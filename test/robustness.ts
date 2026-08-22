import { Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Suite, client, connection, sleep, wipe } from './harness';
import type { INestApplicationContext } from '@nestjs/common';
import type { Job } from 'bullmq';
import {
  SentinelModule,
  SentinelProcessor,
  JobsService,
  MaintenanceService,
  SentinelEvents,
  MetricsService,
  QueueRegistry,
  type JobContext,
  type SentinelOptions,
} from '../src';

const SUITE = 'robustness';

const PREFIX = 'sentinel-rob';

let longWaitCalls = 0;

/** Every release event the processors raised. */
const releases: { delay: number }[] = [];

/** How long a handler took to notice it had been aborted. */
const aborted: number[] = [];

/** Its supervisor forbids release(); this one tries anyway, and lies in its payload. */
@Injectable()
@SentinelProcessor('rob-strict')
class StrictProcessor {
  async handle(job: Job, context?: JobContext): Promise<void> {
    await sleep(5);
    await context!.release(0);

    // Unreachable: release() never returns.
    throw new Error(`released past the ceiling on ${job.name}`);
  }
}

@Injectable()
@SentinelProcessor('rob')
class RobProcessor {
  async handle(job: Job, context?: JobContext): Promise<void> {
    await sleep(5);

    const data = job.data as {
      boom?: boolean;
      releases?: number;
      context?: boolean;
      watch?: boolean;
    };

    // Counted off the job, not off this instance. Two workers share the queue, and a
    // per-instance counter would give each of them a full quota for the same job.
    if (data.releases && job.attemptsStarted <= data.releases) {
      await context!.release(0);
    }

    // Long work that checks the abort signal between steps.
    if (data.watch) {
      const started = Date.now();

      for (let step = 0; step < 40; step += 1) {
        if (context?.aborted) {
          aborted.push(Date.now() - started);

          return;
        }

        await sleep(250);
      }
    }

    if (data.context) {
      const failure = new Error('payload with context');

      (failure as Error & { context: unknown }).context = { orderId: 42, tier: 'gold' };

      throw failure;
    }

    if (data.boom) {
      throw new Error('boom');
    }
  }
}

const options = (): SentinelOptions => ({
  prefix: PREFIX,
  connection: connection(),
  worker: true,
  supervisors: {
    main: { queues: ['rob'], concurrency: 2, timeoutSeconds: 3 },
    strict: { queues: ['rob-strict'], concurrency: 1, maxReleases: 0 },
  },
  defaultJobOptions: { attempts: 1, removeOnComplete: 500, removeOnFail: 500 },
  metrics: { snapshotIntervalSeconds: 2 },
  waits: { rob: 1 },
  onLongWait: () => {
    longWaitCalls += 1;
  },
  board: { enabled: false },
});

@Module({
  imports: [SentinelModule.forRoot(options())],
  providers: [RobProcessor, StrictProcessor],
})
class WorkerModule {}

const redis = client();

export async function run(): Promise<Suite> {
  const suite = new Suite(SUITE);
  const check = suite.check.bind(suite);

  // Two worker processes, the way this is scaled in production.
  const a: INestApplicationContext = await NestFactory.createApplicationContext(
    WorkerModule,
    { logger: false },
  );
  const b: INestApplicationContext = await NestFactory.createApplicationContext(
    WorkerModule,
    { logger: false },
  );

  await a.init();
  await b.init();

  const queues = a.get(QueueRegistry);
  const metrics = a.get(MetricsService);

  // Listen on both contexts: whichever worker picks the job up is the one that raises the
  // event. A single emitter made the count a coin toss.
  for (const context of [a, b]) {
    context.get(SentinelEvents).on('job.released', (event) => releases.push(event));
  }
  const jobs = a.get(JobsService);
  const maintenance = a.get(MaintenanceService);

  await maintenance.clearAll();
  await maintenance.forgetFailed();
  await wipe(PREFIX);

  // --- Snapshots with two workers ---
  await metrics.recordCompleted('rob', 'work', 100);
  await metrics.recordCompleted('rob', 'work', 100);

  await sleep(5000);

  const snapshots = await redis.lrange(`${PREFIX}:metrics:snapshot:queue:rob`, 0, -1);
  const parsed = snapshots.map(
    (raw) => JSON.parse(raw) as { throughput: number; time: number },
  );
  const counted = parsed.reduce((sum, snap) => sum + snap.throughput, 0);
  const ticks = new Set(parsed.map((snap) => Math.round(snap.time / 1000)));

  check(
    'two workers do not each snapshot the same tick',
    ticks.size === parsed.length,
    `${parsed.length} snapshots on ${ticks.size} ticks: ${JSON.stringify(parsed)}`,
  );
  check(
    'throughput is counted once, not once per worker',
    counted === 2,
    `counted=${counted}`,
  );

  // --- Long-wait alerts with two workers ---
  longWaitCalls = 0;

  // Time-to-clear needs both a measured runtime and a backlog before it can cross the
  // threshold.
  await metrics.recordCompleted('rob', 'work', 500);
  await queues.get('rob').pause();

  for (let i = 0; i < 40; i += 1) {
    await queues.dispatch('rob', 'backlog', {});
  }

  await sleep(7000);
  await queues.get('rob').resume();

  check(
    'a long wait alerts once, not once per worker',
    longWaitCalls === 1,
    `calls=${longWaitCalls}`,
  );

  // --- Retries and the failure counter ---
  await maintenance.clearAll();
  await maintenance.forgetFailed();
  const before = await metrics.recentlyFailed();

  await queues.dispatch('rob', 'flaky', { boom: true }, { attempts: 3, backoff: 10 });
  await sleep(4000);

  const after = await metrics.recentlyFailed();
  check(
    'a job that exhausts its retries counts as one failure',
    after - before === 1,
    `delta=${after - before}`,
  );

  // --- clear() ---
  await queues.get('rob').pause();
  await queues.dispatch('rob', 'leftover', {});

  const waiting = await jobs.list('pending', { queue: 'rob' });
  const removed = await maintenance.clear('rob');
  const emptied = await jobs.list('pending', { queue: 'rob' });

  await queues.get('rob').resume();

  check(
    'clear empties the backlog of a queue that had one',
    waiting.total > 0 && removed > 0 && emptied.total === 0,
    `before=${waiting.total} removed=${removed} after=${emptied.total}`,
  );

  // --- retryAll over many failures ---
  await maintenance.clearAll();
  await maintenance.forgetFailed();
  for (let i = 0; i < 60; i += 1) {
    await queues.dispatch('rob', 'mass', { boom: true });
  }
  await sleep(5000);

  const failedNow = await jobs.list('failed', { queue: 'rob' });
  const started = Date.now();
  const retried = await jobs.retryAll('rob');
  const elapsed = Date.now() - started;

  check(
    'retryAll covers every failed job, not just a page',
    retried === failedNow.total && retried >= 60,
    `failed=${failedNow.total} retried=${retried} in ${elapsed}ms`,
  );

  const logs = await redis.keys(`${PREFIX}:retries:*`);
  const ttls = await Promise.all(logs.map((key) => redis.ttl(key)));

  check(
    'the manual-retry log expires instead of piling up',
    logs.length > 0 && ttls.every((ttl) => ttl > 0),
    `${logs.length} keys, lowest ttl ${Math.min(...ttls)}s`,
  );

  // --- Manual retry and the attempt budget ---
  await maintenance.forgetFailed();

  const doomed = await queues.dispatch(
    'rob',
    'doomed',
    { boom: true },
    { attempts: 3, backoff: 0 },
  );

  await sleep(2500);

  const beforeRetry = await jobs.find('rob', String(doomed.id));

  await jobs.retry('rob', String(doomed.id));
  await sleep(2500);

  const afterRetry = await jobs.find('rob', String(doomed.id));

  check(
    'a retried job gets its full attempt budget again, not one last try',
    beforeRetry.attempts === 3 && afterRetry.attempts === 3,
    `before=${beforeRetry.attempts} after=${afterRetry.attempts}`,
  );

  // --- Paging a delayed backlog ---
  await maintenance.clearAll();

  for (let n = 0; n < 30; n += 1) {
    await queues.dispatch(
      'rob',
      `inv-${String(n).padStart(2, '0')}`,
      {},
      // Last dispatched is first due, the order a retry backoff produces.
      { delay: (30 - n) * 60_000 },
    );
  }

  const walked: string[] = [];

  for (let page = 0; page < 6; page += 1) {
    const slice = await jobs.list('pending', { queue: 'rob', page, perPage: 5 });

    walked.push(...slice.jobs.map((job) => job.name));
  }

  const distinct = new Set(walked);

  check(
    'every delayed job is reachable by paging, whatever order they come due in',
    distinct.size === 30 && walked.length === 30,
    `rows=${walked.length} distinct=${distinct.size}`,
  );

  await maintenance.clearAll();

  // --- release() ---
  await maintenance.clearAll();
  await maintenance.forgetFailed();

  const failedBefore = (await jobs.list('failed', { queue: 'rob' })).total;
  const releasedJob = await queues.dispatch('rob', 'not-ready', { releases: 2 });

  await sleep(5000);

  const settled = await jobs.find('rob', String(releasedJob.id));

  check(
    'a released job comes back and finishes without ever failing',
    settled.state === 'completed' &&
      settled.attemptTraces.length === 0 &&
      !settled.failedReason,
    `state=${settled.state} traces=${settled.attemptTraces.length}`,
  );
  check(
    'and it leaves no trace in the failure listing or its counter',
    (await jobs.list('failed', { queue: 'rob' })).total === failedBefore,
    `before=${failedBefore} after=${(await jobs.list('failed', { queue: 'rob' })).total}`,
  );
  check(
    'releasing raises job.released, not job.failed',
    releases.length === 2 && releases.every((event) => event.delay === 0),
    JSON.stringify(releases),
  );

  // --- A handler that never stops releasing ---
  const looping = await queues.dispatch(
    'rob',
    'never-ready',
    { releases: 99 },
    { attempts: 2 },
  );

  await sleep(6000);

  const stopped = await jobs.find('rob', String(looping.id));

  check(
    'a handler that never stops releasing is failed rather than looped forever',
    stopped.state === 'failed' && /released itself/.test(stopped.failedReason ?? ''),
    `${stopped.state}: ${stopped.failedReason ?? 'no reason'}`,
  );

  await maintenance.forgetFailed();

  // --- The release ceiling ---
  const escaping = await queues.dispatch('rob-strict', 'tries-to-escape', {
    // Invalid on purpose: it must fall back to the supervisor's 0, not to the default.
    maxReleases: -1,
  });

  await sleep(2000);

  const refused = await jobs.find('rob-strict', String(escaping.id));

  check(
    'a job cannot raise the release ceiling its supervisor set',
    refused.state === 'failed' && /does not allow/.test(refused.failedReason ?? ''),
    `${refused.state}: ${refused.failedReason ?? 'no reason'}`,
  );

  await maintenance.forgetFailed();

  // --- Abort signalling ---
  const slow = await queues.dispatch('rob', 'watches-the-clock', { watch: true });

  await sleep(6000);

  const timedOut = await jobs.find('rob', String(slow.id));

  // The slot is freed either way. This asserts the handler also finds out and stops,
  // rather than running on after the job is already marked failed.
  check(
    'a handler that checks ctx.aborted stops when the timeout fires',
    aborted.length === 1 && aborted[0] < 4000 && timedOut.state === 'failed',
    `stopped after ${aborted[0] ?? '—'}ms, state=${timedOut.state}`,
  );

  // --- Errors that carry context ---
  await maintenance.forgetFailed();

  const carrying = await queues.dispatch('rob', 'with-context', { context: true });

  await sleep(3000);

  const carried = await jobs.find('rob', String(carrying.id));

  check(
    'an error that carries context has it stored beside the failure',
    carried.context?.orderId === 42,
    JSON.stringify(carried.context),
  );

  const bare = await queues.dispatch('rob', 'no-context', { boom: true });

  await sleep(3000);

  check(
    'an ordinary error stores none',
    (await jobs.find('rob', String(bare.id))).context === null,
    JSON.stringify((await jobs.find('rob', String(bare.id))).context),
  );

  await maintenance.forgetFailed();

  // --- Retrying a job that did not fail ---
  await queues.dispatch('rob', 'already-fine', {});
  await sleep(1500);

  const fine = (await jobs.list('completed', { queue: 'rob' })).jobs[0];
  let refusal = '';

  // Checked apart, or a missing fixture would throw a TypeError and read as a refusal.
  check('there is a completed job to try this on', fine !== undefined);

  try {
    await jobs.retry('rob', fine.id);
  } catch (error) {
    refusal = (error as Error).message;
  }

  check(
    'retrying a job that is not failed is refused',
    /not failed/i.test(refusal),
    refusal || 'it was allowed',
  );

  // --- forgetFailed() ---
  await sleep(500);
  await maintenance.forgetFailed();

  const afterForget = await jobs.list('failed', { queue: 'rob' });
  const counter = await metrics.recentlyFailed();

  check(
    'forgetting the failed jobs also clears the counter beside them',
    afterForget.total === 0 && counter === 0,
    `listing=${afterForget.total} counter=${counter}`,
  );

  const strayTags = await redis.keys(`${PREFIX}:failed-tag:*`);

  check(
    'and the tag index they were written into',
    strayTags.length === 0,
    `${strayTags.length} keys`,
  );

  await a.close();
  await b.close();
  await redis.quit();

  return suite;
}
