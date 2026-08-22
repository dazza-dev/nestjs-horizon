import { Injectable } from '@nestjs/common';
import { Cluster, Redis } from 'ioredis';
import type { SentinelConnection } from '../sentinel.types';
import { normalizeConnection } from '../sentinel.options';

/**
 * The clients one module opened, and therefore has to close.
 *
 * BullMQ leaves a connection it was handed open, assuming the caller owns it. One
 * registry per module, not per process: closing one context must not cut another's.
 */
@Injectable()
export class ClientRegistry {
  private readonly clients = new Set<Redis>();
  private readonly shared = new Map<string, Redis>();

  track(client: Redis): Redis {
    this.clients.add(client);

    return client;
  }

  /**
   * The one cluster client for a named connection.
   *
   * Shared, unlike a worker's blocking connection: a `Cluster` per caller re-runs slot
   * discovery and holds a socket to every node.
   */
  clusterFor(connection: SentinelConnection, name: string): Redis {
    const existing = this.shared.get(name);

    if (existing) {
      return existing;
    }

    return this.shared.set(name, createClient(connection, this)).get(name) as Redis;
  }

  async closeAll(): Promise<void> {
    const open = [...this.clients];

    this.clients.clear();
    this.shared.clear();

    await Promise.all(
      open.map((client) =>
        client.quit().catch(() => {
          client.disconnect();
        }),
      ),
    );
  }
}

export const createClient = (
  connection: SentinelConnection,
  registry?: ClientRegistry,
): Redis => {
  const options = { ...normalizeConnection(connection), maxRetriesPerRequest: null };

  if (!connection.cluster) {
    const client = new Redis(options);

    return registry ? registry.track(client) : client;
  }

  // A cluster has no databases, and SELECT is an error on one.
  const { db, ...redisOptions } = options;

  const cluster = new Cluster(connection.cluster, {
    redisOptions,
  }) as unknown as Redis;

  return registry ? registry.track(cluster) : cluster;
};

/**
 * Runs a pipeline and throws the first command that failed.
 *
 * `exec()` resolves even when commands errored. A pipeline is not a transaction; the
 * commands around the failure have already landed.
 */
export const execPipeline = async (pipeline: {
  exec(): Promise<[Error | null, unknown][] | null>;
}): Promise<void> => {
  const results = await pipeline.exec();
  const failure = results?.find(([error]) => error)?.[0];

  if (failure) {
    throw failure;
  }
};

/** Whether a client talks to a cluster. */
export const isCluster = (client: Redis): boolean =>
  (client as unknown as { isCluster?: boolean }).isCluster === true;

/**
 * Runs `work` against every master, or against the one client when standalone.
 *
 * For commands with no key to route by. SCAN carries no key; ioredis lands it on an
 * arbitrary node, and a cursor from one node means nothing to another.
 */
export const eachNode = async <T>(
  client: Redis,
  work: (node: Redis) => Promise<T>,
): Promise<T[]> => {
  if (!isCluster(client)) {
    return [await work(client)];
  }

  const cluster = client as unknown as Cluster;
  let nodes = cluster.nodes('master');

  // Before topology discovery `nodes()` is empty, and a sweep across none of them
  // reports success having done nothing.
  if (!nodes.length) {
    await cluster.ping();

    nodes = cluster.nodes('master');
  }

  if (!nodes.length) {
    throw new Error('Redis Cluster reported no master nodes.');
  }

  return Promise.all(nodes.map((node) => work(node)));
};
