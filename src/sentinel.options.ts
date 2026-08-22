import type { RedisOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import type { ClientRegistry } from './redis/client';
import { DEFAULT_PREFIX, DEFAULT_WAIT_SECONDS } from './sentinel.constants';
import type {
  SentinelConnection,
  SentinelOptions,
  SupervisorOptions,
} from './sentinel.types';

/** Percent-decoding that reports a bad url instead of throwing a bare URIError. */
function decode(value: string, url: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(
      `Sentinel connection url has invalid percent-encoding in its credentials: ${url}`,
    );
  }
}

export function normalizeConnection(connection: SentinelConnection): RedisOptions {
  const { url, cluster, ...rest } = connection;

  // The nodes decide where the client connects: the url's host would be ignored while
  // its credentials still applied.
  if (url && cluster) {
    throw new Error(
      'A Sentinel connection takes either `url` or `cluster`, not both. ' +
        'Put the credentials in the cluster nodes or in the connection options.',
    );
  }

  if (!url) {
    return rest;
  }

  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Sentinel connection url is not a valid URL: ${url}`);
  }

  // Anything else is not a Redis url, and `URL` would quietly drop the port off it.
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error(
      `Sentinel connection url must be redis:// or rediss://, got "${parsed.protocol}//".`,
    );
  }

  const database = parsed.pathname.slice(1);

  // Sent as-is it fails the SELECT and leaves the client on database 0, writing into
  // whatever else lives there.
  if (database && !/^\d+$/.test(database)) {
    throw new Error(
      `Sentinel connection url has an invalid database: "/${database}". ` +
        'It must be a single number, as in redis://host:6379/3.',
    );
  }

  const fromUrl: RedisOptions = {
    host: parsed.hostname || '127.0.0.1',
    port: parsed.port ? Number(parsed.port) : 6379,
  };

  if (parsed.username) {
    fromUrl.username = decode(parsed.username, url);
  }

  if (parsed.password) {
    fromUrl.password = decode(parsed.password, url);
  }

  if (database) {
    fromUrl.db = Number(database);
  }

  // rediss:// is Redis over TLS, which most hosted providers require.
  if (parsed.protocol === 'rediss:') {
    fromUrl.tls = {};
  }

  // Only fields actually set. A key present with an `undefined` value would strip TLS
  // off a rediss:// url and send the password in the clear.
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) {
      (fromUrl as Record<string, unknown>)[key] = value;
    }
  }

  return fromUrl;
}

/**
 * Folds the environment overrides into the supervisors, leaving one resolved config for
 * everything downstream.
 */
export function resolveOptions(options: SentinelOptions): SentinelOptions {
  const env = options.env ?? process.env.NODE_ENV ?? 'development';
  const overrides = options.environments?.[env];

  // A fresh install alerts on a backed-up queue with nothing configured. Pass
  // `waits: {}` to opt out.
  const waits = options.waits ?? { default: DEFAULT_WAIT_SECONDS };

  if (!overrides) {
    return { ...options, waits };
  }

  const supervisors: Record<string, SupervisorOptions> = {};

  for (const [name, supervisor] of Object.entries(options.supervisors)) {
    const override = overrides[name] ?? {};

    supervisors[name] = {
      ...supervisor,
      ...override,

      // Merged, not replaced: raising `attempts` in one environment must not drop the
      // backoff and retention the base supervisor declared.
      defaultJobOptions: {
        ...supervisor.defaultJobOptions,
        ...override.defaultJobOptions,
      },
    };
  }

  // An environment may also declare a supervisor the defaults do not have.
  for (const [name, supervisor] of Object.entries(overrides)) {
    if (!supervisors[name] && supervisor.queues) {
      supervisors[name] = supervisor as SupervisorOptions;
    }
  }

  return { ...options, waits, supervisors };
}

/** A hash tag Redis will actually honour: braces with something between them. */
const HASH_TAG = /\{([^{}]+)\}/;

/** One balanced, non-empty tag and no other braces anywhere. */
const ONE_TAG = /^[^{}]*\{[^{}]+\}[^{}]*$/;

/** Glob characters. `MATCH` reads them as patterns, not as literals. */
const GLOB = /[*?[\]\\]/;

/**
 * The tag Redis would route by: the first balanced brace pair, or nothing. Empty braces
 * are not a tag; Redis hashes the whole key.
 */
function effectiveTag(key: string): string | undefined {
  return HASH_TAG.exec(key)?.[1];
}

/**
 * Checks the prefix once, loudly. Unchecked it surfaces later as CROSSSLOT per job, or
 * as a `clearMetrics` that deletes another application's keys.
 */
function assertUsable(prefix: string, clustered: boolean): void {
  if (!prefix.trim()) {
    throw new Error('Sentinel prefix cannot be empty.');
  }

  if (GLOB.test(prefix)) {
    throw new Error(
      `Sentinel prefix "${prefix}" contains a glob character (* ? [ ] \\). ` +
        'Those are patterns to Redis and would make key sweeps match the wrong keys.',
    );
  }

  // Any brace at all is checked. A stray "}" turns "hz}x" into the tag "hz" for every
  // queue, collapsing them all onto one node.
  if (clustered && /[{}]/.test(prefix) && !ONE_TAG.test(prefix)) {
    throw new Error(
      `Sentinel prefix "${prefix}" has an unbalanced, empty or repeated hash tag. ` +
        'On a cluster it must contain exactly one "{...}" pair with something inside it.',
    );
  }
}

/** Checks the key that came out, not the string that went in. */
function assertTagged(key: string, expected: string): string {
  const tag = effectiveTag(key);

  if (tag !== expected) {
    throw new Error(
      `Sentinel built the key prefix "${key}", which Redis would route by ` +
        `${tag === undefined ? 'no hash tag' : `"${tag}"`} rather than "${expected}". ` +
        'Check the prefix and queue names for braces.',
    );
  }

  return key;
}

/**
 * The prefix for this package's own keys: metrics, tags, batches, the worker registry.
 * On a cluster they share a slot, since reads pipeline and MGET across unrelated keys.
 */
export function resolvePrefix(options: SentinelOptions): string {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const clustered = Boolean(options.connection.cluster);

  assertUsable(prefix, clustered);

  if (!clustered) {
    return prefix;
  }

  return HASH_TAG.test(prefix) ? prefix : assertTagged(`{${prefix}}`, prefix);
}

/**
 * The prefix BullMQ uses for one queue. On a cluster every queue gets its own hash tag
 * and the queues spread across the nodes.
 */
export function queuePrefix(
  options: SentinelOptions,
  queue: string,
  supervisor?: SupervisorOptions,
): string {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const clustered = Boolean(rawConnectionFor(options, supervisor).cluster);

  assertUsable(prefix, clustered);
  assertUsableQueue(queue);

  if (!clustered) {
    return prefix;
  }

  // An explicit tag is the author's decision about co-location; leave it alone.
  return HASH_TAG.test(prefix)
    ? prefix
    : assertTagged(`{${prefix}:${queue}}`, `${prefix}:${queue}`);
}

/** A queue name becomes part of a key prefix and is checked the same way. */
function assertUsableQueue(queue: string): void {
  if (!queue.trim() || GLOB.test(queue) || /[{}]/.test(queue)) {
    throw new Error(
      `Sentinel queue name "${queue}" cannot be empty or contain braces or glob ` +
        'characters: it becomes part of the Redis keys the queue is stored under.',
    );
  }
}

/** The connection a supervisor runs on, falling back to the main one. */
export function rawConnectionFor(
  options: SentinelOptions,
  supervisor?: SupervisorOptions,
): SentinelConnection {
  if (!supervisor?.connection) {
    return options.connection;
  }

  const named = options.connections?.[supervisor.connection];

  if (!named) {
    throw new Error(
      `Connection "${supervisor.connection}" is not declared in the Sentinel config.`,
    );
  }

  return named;
}

/** What BullMQ gets for a supervisor: plain options, or a cluster client of its own. */
export function connectionFor(
  options: SentinelOptions,
  clients: ClientRegistry,
  supervisor?: SupervisorOptions,
): RedisOptions | Redis {
  const connection = rawConnectionFor(options, supervisor);

  if (!connection.cluster) {
    return normalizeConnection(connection);
  }

  return clients.clusterFor(connection, supervisor?.connection ?? 'default');
}
