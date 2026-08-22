import { Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Cluster, Redis } from 'ioredis';
import type { Job } from 'bullmq';
import {
  SentinelModule,
  SentinelProcessor,
  JobsService,
  MaintenanceService,
  MetricsService,
  QueueRegistry,
  TagsService,
  WorkerRegistry,
  type SentinelOptions,
} from '../src';
import { queuePrefix, resolvePrefix } from '../src/sentinel.options';
import { Suite, client, sleep } from './harness';

const SUITE = 'cluster';
const PREFIX = 'sentinel-cl';

/** Where `test/cluster/up.sh` puts its nodes. */
const NODES = [
  { host: '127.0.0.1', port: 7381 },
  { host: '127.0.0.1', port: 7382 },
  { host: '127.0.0.1', port: 7383 },
];

@Injectable()
@SentinelProcessor('cl')
class ClusterProcessor {
  async handle(job: Job): Promise<void> {
    await sleep(10);

    if ((job.data as { boom?: boolean }).boom) {
      throw new Error('boom');
    }
  }
}

const options = (): SentinelOptions => ({
  prefix: PREFIX,
  connection: { cluster: NODES },
  worker: true,
  supervisors: { main: { queues: ['cl'], concurrency: 2 } },
  defaultJobOptions: { attempts: 1, removeOnComplete: 100, removeOnFail: 100 },
  board: { enabled: false },
});

@Module({ imports: [SentinelModule.forRoot(options())], providers: [ClusterProcessor] })
class TestModule {}

/** Whether the throwaway cluster is up. The suite is skipped when it is not. */
const available = async (): Promise<boolean> => {
  const probe = new Cluster(NODES);

  // Default options: a retry strategy that gives up quickly also fails against a healthy
  // cluster. The timeout below is what decides the cluster is absent.
  probe.on('error', () => undefined);

  try {
    await Promise.race([
      probe.ping(),
      sleep(3000).then(() => Promise.reject(new Error('no cluster'))),
    ]);

    return true;
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
};

export async function run(): Promise<Suite> {
  const suite = new Suite(SUITE);
  const check = suite.check.bind(suite);

  if (!(await available())) {
    suite.skip('Redis Cluster', 'run `pnpm cluster:up` to exercise it');

    return suite;
  }

  check(
    'our own keys share a slot, because reading them takes multi-key commands',
    resolvePrefix(options()) === `{${PREFIX}}`,
    resolvePrefix(options()),
  );
  check(
    'but each queue gets its own tag, so the queues spread across the nodes',
    queuePrefix(options(), 'cl') === `{${PREFIX}:cl}` &&
      queuePrefix(options(), 'other') === `{${PREFIX}:other}`,
    queuePrefix(options(), 'cl'),
  );

  // A prefix that cannot work must say so at boot, not per job.
  for (const [bad, why] of [
    ['hz*pfx', 'a glob character'],
    ['hz{}pfx', 'an empty hash tag'],
    ['hz{izon', 'an unbalanced brace'],
    ['hz}x', 'a stray closing brace'],
    ['a{b}c{d}e', 'two hash tags'],
    ['', 'nothing in it'],
  ]) {
    let refused = false;

    try {
      resolvePrefix({ ...options(), prefix: bad });
    } catch {
      refused = true;
    }

    check(`a prefix with ${why} is refused at boot`, refused, bad);
  }

  // Braces in a queue name would collapse every queue onto one slot the same way.
  let badQueue = false;

  try {
    queuePrefix(options(), 'ma}il');
  } catch {
    badQueue = true;
  }

  check('a queue name with a brace is refused', badQueue, 'ma}il');

  // N queues must land on N slots. Checking the string shape alone would have passed
  // for every prefix bug found so far.
  const keyslot = new Redis(NODES[0]);
  const slots = new Set(
    await Promise.all(
      ['a', 'b', 'c', 'd', 'e', 'f'].map((queue) =>
        keyslot.cluster('KEYSLOT', queuePrefix(options(), queue)),
      ),
    ),
  );

  await keyslot.quit();

  check(
    'each queue really hashes to its own slot',
    slots.size === 6,
    `${slots.size}/6 slots`,
  );

  // Wipe first. `clear()` keeps finished jobs on purpose, and a previous run would still
  // be counted here.
  const sweep = new Cluster(NODES);

  sweep.on('error', () => undefined);
  await sweep.ping();

  const stale = (
    await Promise.all(sweep.nodes('master').map((node) => node.keys(`*${PREFIX}*`)))
  ).flat();

  await Promise.all(stale.map((key) => sweep.del(key)));
  sweep.disconnect();

  const app = await NestFactory.createApplicationContext(TestModule, { logger: false });
  await app.init();

  const queues = app.get(QueueRegistry);
  const jobs = app.get(JobsService);
  const tags = app.get(TagsService);
  const metrics = app.get(MetricsService);
  const workers = app.get(WorkerRegistry);
  const maintenance = app.get(MaintenanceService);

  // --- Jobs on the cluster ---
  await tags.monitor('billing');
  await queues.dispatch('cl', 'ok', { tags: ['billing'] });
  await queues.dispatch('cl', 'bad', { tags: ['billing'], boom: true });
  await sleep(2500);

  const completed = await jobs.list('completed', { queue: 'cl' });
  const failed = await jobs.list('failed', { queue: 'cl' });

  check(
    'a job dispatched to a cluster runs on it',
    completed.total === 1 && failed.total === 1,
    `completed=${completed.total} failed=${failed.total}`,
  );

  // Asked per node: `keys` on a cluster client goes to an arbitrary one, the trap this
  // release fixed in `deleteMatching`.
  const direct = new Cluster(NODES);

  direct.on('error', () => undefined);

  // A fresh cluster client has not discovered the topology yet. Without this ping,
  // `nodes('master')` comes back empty and every lookup below silently finds nothing.
  await direct.ping();

  const onNodes = async (pattern: string): Promise<string[]> => {
    const perNode = await Promise.all(
      direct.nodes('master').map((node) => node.keys(pattern)),
    );

    return perNode.flat();
  };

  const keys = await onNodes(`{${PREFIX}:cl}*`);

  check(
    'the queue keys live on the cluster, under their own tag',
    keys.length > 0,
    `${keys.length} keys`,
  );

  const standalone = client();
  const strays = await standalone.keys(`*${PREFIX}*`);

  await standalone.quit();

  check(
    'and nothing was written to the standalone Redis',
    strays.length === 0,
    `${strays.length} keys on the standalone Redis`,
  );

  // --- The multi-key work that CROSSSLOT would break ---
  check(
    'metrics survive the multi-key pipeline',
    (await metrics.measuredQueues()).includes('cl'),
  );

  const monitored = await tags.monitoredWithCounts();
  check(
    'tag counts survive, and MGET of the copies too',
    monitored.find((entry) => entry.tag === 'billing')?.count === 2,
    JSON.stringify(monitored),
  );

  const tagged = await tags.jobsFor('billing', 'jobs');
  check(
    'a monitored tag resolves its jobs',
    (await jobs.findMany(tagged.refs)).length === 2,
    `${tagged.total}`,
  );

  check('the worker index resolves through MGET', (await workers.all()).length === 1);

  // --- SCAN, walked per node ---
  await metrics.recordCompleted('cl', 'ok', 25);
  await maintenance.clearMetrics();

  const leftover = (await onNodes(`{${PREFIX}}:metrics:queue:*`)).length;

  check('clearMetrics reaches the node the keys live on', leftover === 0, `${leftover}`);

  await maintenance.clearAll();
  await maintenance.forgetFailed();
  await tags.stopMonitoring('billing');

  const mine = await onNodes(`*${PREFIX}*`);

  if (mine.length) {
    await Promise.all(mine.map((key) => direct.del(key)));
  }

  direct.disconnect();

  // Two application contexts in one process is ordinary; this suite runs several.
  // Closing one must not take the other's connections down with it.
  const second = await NestFactory.createApplicationContext(TestModule, {
    logger: false,
  });

  await second.init();
  await app.close();

  let survived = false;

  try {
    await second.get(QueueRegistry).dispatch('cl', 'after-close', {});
    survived = true;
  } catch {
    survived = false;
  }

  check('closing one context leaves another one working', survived);

  await second.get(MaintenanceService).clearAll();
  await second.close();

  return suite;
}
