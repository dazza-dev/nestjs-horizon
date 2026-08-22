import { Inject, Injectable, Module } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { NestFactory } from '@nestjs/core';
import type { Job } from 'bullmq';
import {
  BatchService,
  BatchedProcessor,
  SentinelEvents,
  SentinelModule,
  SentinelProcessor,
  JobsService,
  MaintenanceService,
  QueueRegistry,
  type BatchedJobData,
  type JobContext,
  type SentinelOptions,
} from '../src';
import { Suite, connection, sleep, wipe } from './harness';

const SUITE = 'batches';
const PREFIX = 'sentinel-batches';

interface Payload extends BatchedJobData {
  releases?: number;
  boom?: boolean;
  unrecoverable?: boolean;
  slowMs?: number;
  step?: string;
}

/** The order jobs actually ran in. A chain has to preserve it. */
const order: string[] = [];
const callbacks: string[] = [];

@Injectable()
@SentinelProcessor('bat')
class BatProcessor extends BatchedProcessor<Payload> {
  constructor(@Inject(BatchService) batches: BatchService) {
    super(batches);
  }

  private readonly released = new Map<string, number>();

  protected async process(job: Job<Payload>, context?: JobContext): Promise<void> {
    if (job.data.batchCallback) {
      callbacks.push(job.name);

      return;
    }

    if (job.data.releases) {
      const so_far = this.released.get(String(job.id)) ?? 0;

      if (so_far < job.data.releases) {
        this.released.set(String(job.id), so_far + 1);
        await context!.release(0);
      }
    }

    await sleep(job.data.slowMs ?? 10);
    order.push(job.data.step ?? job.name);

    if (job.data.unrecoverable) {
      // BullMQ stops retrying immediately, with attempts still on the clock.
      throw new UnrecoverableError('give up');
    }

    if (job.data.boom) {
      throw new Error('boom');
    }
  }
}

/** Kept on its own supervisor: the one-second timeout must not reach the other queues. */
@Injectable()
@SentinelProcessor('bat-slow')
class SlowProcessor extends BatchedProcessor<Payload> {
  constructor(@Inject(BatchService) batches: BatchService) {
    super(batches);
  }

  protected async process(job: Job<Payload>): Promise<void> {
    await sleep(job.data.slowMs ?? 3000);
  }
}

const options = (): SentinelOptions => ({
  prefix: PREFIX,
  connection: connection(),
  worker: true,
  supervisors: {
    main: { queues: ['bat'], concurrency: 4 },
    slow: { queues: ['bat-slow'], concurrency: 1, timeoutSeconds: 1 },
  },
  defaultJobOptions: { attempts: 1, removeOnComplete: 500, removeOnFail: 500 },
  batchTtlSeconds: 120,
  board: { enabled: false },
});

@Module({
  imports: [SentinelModule.forRoot(options())],
  providers: [BatProcessor, SlowProcessor],
})
class TestModule {}

export async function run(): Promise<Suite> {
  const suite = new Suite(SUITE);
  const check = suite.check.bind(suite);

  await wipe(PREFIX);

  const app = await NestFactory.createApplicationContext(TestModule, { logger: false });
  await app.init();

  const batches = app.get(BatchService);
  const events = app.get(SentinelEvents);
  const maintenance = app.get(MaintenanceService);
  const jobs = app.get(JobsService);
  const queues = app.get(QueueRegistry);

  const finished: string[] = [];
  const cancelledEvents: string[] = [];

  events.on('batch.finished', (event) => finished.push(event.batchId));
  events.on('batch.cancelled', (event) => cancelledEvents.push(event.batchId));

  // --- Chains run in order ---
  order.length = 0;
  const chained = await batches.dispatch({
    name: 'Chained export',
    jobs: [
      [
        { queue: 'bat', name: 'chunk', data: { step: 'a', slowMs: 120 } },
        { queue: 'bat', name: 'chunk', data: { step: 'b', slowMs: 10 } },
        { queue: 'bat', name: 'chunk', data: { step: 'c', slowMs: 10 } },
      ],
    ],
  });

  check(
    'a chain counts every link up front',
    chained.totalJobs === 3,
    `${chained.totalJobs}`,
  );

  await sleep(2500);

  check(
    'the links run strictly in order',
    order.join('') === 'abc',
    order.join(',') || 'nothing ran',
  );

  const afterChain = await batches.find(chained.id);
  check(
    'a finished chain leaves nothing pending',
    afterChain?.finished === true && afterChain.pendingJobs === 0,
    JSON.stringify({ finished: afterChain?.finished, pending: afterChain?.pendingJobs }),
  );

  // --- A chain with a failing link ---
  order.length = 0;
  const broken = await batches.dispatch({
    name: 'Broken chain',
    allowFailures: true,
    jobs: [
      [
        { queue: 'bat', name: 'chunk', data: { step: 'x', boom: true } },
        { queue: 'bat', name: 'chunk', data: { step: 'y' } },
        { queue: 'bat', name: 'chunk', data: { step: 'z' } },
      ],
    ],
  });

  await sleep(2000);

  const afterBroken = await batches.find(broken.id);
  check(
    // A failure never decrements pendingJobs. A batch holding an unretried failure
    // settles at pending === failed rather than at zero.
    'a link that fails settles the batch instead of hanging it',
    afterBroken?.pendingJobs === 1 && afterBroken.failedJobs === 1,
    JSON.stringify({
      finished: afterBroken?.finished,
      pending: afterBroken?.pendingJobs,
      failed: afterBroken?.failedJobs,
    }),
  );
  check(
    'the abandoned links never ran',
    !order.includes('y') && !order.includes('z'),
    order.join(','),
  );

  // --- Cancelling mid-flight ---
  order.length = 0;
  const cancelled = await batches.dispatch({
    name: 'Cancelled batch',
    jobs: Array.from({ length: 12 }, (_, i) => ({
      queue: 'bat',
      name: 'slow',
      data: { step: `job-${i}`, slowMs: 150 },
    })),
  });

  await sleep(200);
  await batches.cancel(cancelled.id);
  await sleep(3000);

  const afterCancel = await batches.find(cancelled.id);
  check(
    'a cancelled batch still finishes its bookkeeping',
    afterCancel?.finished === true && afterCancel.pendingJobs === 0,
    JSON.stringify({
      finished: afterCancel?.finished,
      pending: afterCancel?.pendingJobs,
    }),
  );
  check(
    'cancelling stops the jobs that had not started',
    order.length < 12,
    `ran ${order.length} of 12`,
  );
  check('batch.cancelled fires', cancelledEvents.includes(cancelled.id));

  // --- then / catch / finally ---
  callbacks.length = 0;
  const withHooks = await batches.dispatch({
    name: 'Hooks',
    allowFailures: true,
    jobs: [
      { queue: 'bat', name: 'ok', data: {} },
      { queue: 'bat', name: 'bad', data: { boom: true } },
    ],
    then: { queue: 'bat', name: 'then-hook' },
    catch: { queue: 'bat', name: 'catch-hook' },
    finally: { queue: 'bat', name: 'finally-hook' },
  });

  await sleep(2500);

  check(
    'catch fires on the first failure even when failures are allowed',
    callbacks.includes('catch-hook'),
    callbacks.join(','),
  );
  check('then does not fire when something failed', !callbacks.includes('then-hook'));
  check('finally always fires', callbacks.includes('finally-hook'), callbacks.join(','));
  // pendingJobs still holds the failure. Only a success, or a retry that succeeds,
  // closes a batch.
  check(
    'a batch with an unretried failure does not report finished',
    !finished.includes(withHooks.id),
    finished.length ? 'reported' : 'not reported',
  );

  const stamped = await batches.dispatch({
    name: 'Stamped',
    jobs: [
      { queue: 'bat', name: 'ok', data: { slowMs: 400 } },
      { queue: 'bat', name: 'bad', data: { boom: true } },
    ],
  });

  await sleep(2500);

  const stampedView = await batches.find(stamped.id);

  // `finished` and `finishedAt` have to be written together. A batch cancelled by a
  // failure never returns to zero pending, and nothing later repairs a missing stamp.
  check(
    'a batch cancelled by a failure carries a finish time',
    stampedView?.finished === true && !!stampedView?.finishedAt,
    JSON.stringify({ finished: stampedView?.finished, at: stampedView?.finishedAt }),
  );

  // --- A job that releases itself ---
  callbacks.length = 0;

  const relBatch = await batches.dispatch({
    name: 'Released',
    jobs: [
      { queue: 'bat', name: 'waits', data: { releases: 1 } },
      { queue: 'bat', name: 'plain', data: {} },
    ],
    then: { queue: 'bat', name: 'then-hook' },
    catch: { queue: 'bat', name: 'catch-hook' },
  });

  await sleep(3000);

  const relView = await batches.find(relBatch.id);

  // BullMQ throws DelayedError to say the job was moved on purpose. Counting it as a
  // failure cancelled the batch, and the returning job was then skipped: the work never
  // ran at all.
  check(
    'a job that releases itself does not fail or cancel its batch',
    relView?.failedJobs === 0 &&
      relView?.cancelled === false &&
      relView?.processedJobs === 2 &&
      !callbacks.includes('catch-hook'),
    JSON.stringify({
      failed: relView?.failedJobs,
      cancelled: relView?.cancelled,
      processed: relView?.processedJobs,
      hooks: callbacks.join(','),
    }),
  );

  // --- Repeated failures of one job ---
  const twice = await batches.dispatch({
    name: 'Twice',
    allowFailures: true,
    jobs: [{ queue: 'bat', name: 'bad', data: { boom: true } }],
  });

  await sleep(2000);

  const once = (await batches.failedJobs(twice.id)).length;
  const target = (await batches.failedJobs(twice.id))[0];
  const bullJob = await queues.get(target.queue).getJob(target.jobId);

  await jobs.retry(target.queue, target.jobId);
  await sleep(2500);

  const listed = (await batches.failedJobs(twice.id)).length;

  await bullJob?.updateData({ ...(bullJob.data as Payload), boom: false });
  await jobs.retry(target.queue, target.jobId);
  await sleep(2500);

  check(
    'a job that failed twice leaves no stale entry once it succeeds',
    once === 1 && listed === 1 && (await batches.failedJobs(twice.id)).length === 0,
    `first=${once} second=${listed} after success=${(await batches.failedJobs(twice.id)).length}`,
  );

  // --- Retrying a failed link ---
  callbacks.length = 0;

  const retried = await batches.dispatch({
    name: 'Retried',
    allowFailures: true,
    jobs: [
      { queue: 'bat', name: 'ok', data: {} },
      { queue: 'bat', name: 'bad', data: { boom: true } },
    ],
    then: { queue: 'bat', name: 'then-hook' },
    catch: { queue: 'bat', name: 'catch-hook' },
    finally: { queue: 'bat', name: 'finally-hook' },
  });

  await sleep(2500);

  const stuck = await batches.find(retried.id);

  check(
    'a batch waiting on a failure holds its pending count',
    stuck?.pendingJobs === 1 && stuck?.failedJobs === 1 && !stuck?.finished,
    JSON.stringify({ pending: stuck?.pendingJobs, failed: stuck?.failedJobs }),
  );

  const toRetry = await batches.failedJobs(retried.id);

  // The dashboard's path: note the retry, make the job succeed, put it back.
  await batches.recordRetry(retried.id);

  for (const ref of toRetry) {
    const bull = await queues.get(ref.queue).getJob(ref.jobId);

    await bull?.updateData({ ...(bull.data as Payload), boom: false });
    await jobs.retry(ref.queue, ref.jobId);
  }

  await sleep(3000);

  const closed = await batches.find(retried.id);
  const stillFailed = await batches.failedJobs(retried.id);

  // The retry itself moves no counter; the run it starts does. Incrementing
  // pendingJobs on retry left a count nothing could bring back to zero.
  check(
    'a retry that succeeds closes the batch and fires then',
    closed?.pendingJobs === 0 &&
      closed?.finished === true &&
      callbacks.includes('then-hook'),
    JSON.stringify({
      pending: closed?.pendingJobs,
      finished: closed?.finished,
      hooks: callbacks.join(','),
    }),
  );
  check(
    'the failure tally stays, but the job leaves the failure list',
    closed?.failedJobs === 1 && stillFailed.length === 0,
    JSON.stringify({ failed: closed?.failedJobs, listed: stillFailed.length }),
  );
  check(
    'finally fires once across the whole life of the batch',
    callbacks.filter((name) => name === 'finally-hook').length === 1,
    callbacks.join(','),
  );

  // --- A clean run ---
  callbacks.length = 0;
  await batches.dispatch({
    name: 'Clean',
    jobs: [{ queue: 'bat', name: 'ok', data: {} }],
    then: { queue: 'bat', name: 'then-hook' },
    catch: { queue: 'bat', name: 'catch-hook' },
  });

  await sleep(2000);

  check(
    'then fires when nothing failed, and catch does not',
    callbacks.includes('then-hook') && !callbacks.includes('catch-hook'),
    callbacks.join(','),
  );

  // --- UnrecoverableError ---
  callbacks.length = 0;
  const giveUp = await batches.dispatch({
    name: 'Unrecoverable',
    allowFailures: true,
    jobs: [
      { queue: 'bat', name: 'ok', data: {} },
      { queue: 'bat', name: 'doomed', data: { unrecoverable: true } },
    ],
    finally: { queue: 'bat', name: 'finally-hook' },
  });

  await sleep(3000);

  const afterGiveUp = await batches.find(giveUp.id);
  check(
    'an UnrecoverableError settles the batch instead of hanging it',
    afterGiveUp?.pendingJobs === 1 && afterGiveUp.failedJobs === 1,
    JSON.stringify({
      finished: afterGiveUp?.finished,
      pending: afterGiveUp?.pendingJobs,
      failed: afterGiveUp?.failedJobs,
    }),
  );
  check(
    'and its callbacks still fire',
    callbacks.includes('finally-hook'),
    callbacks.join(','),
  );

  check(
    'a cancelled batch records the time',
    typeof afterCancel?.cancelledAt === 'string' && afterCancel.cancelledAt.length > 0,
    String(afterCancel?.cancelledAt),
  );

  // --- Cancelling a batch with nothing failed ---
  callbacks.length = 0;
  const stopped = await batches.dispatch({
    name: 'Cancelled clean',
    jobs: Array.from({ length: 8 }, (_, i) => ({
      queue: 'bat',
      name: 'slow',
      data: { step: `c-${i}`, slowMs: 120 },
    })),
    then: { queue: 'bat', name: 'then-hook' },
    finally: { queue: 'bat', name: 'finally-hook' },
  });

  await sleep(150);
  await batches.cancel(stopped.id);
  await sleep(3000);

  const afterStopped = await batches.find(stopped.id);
  check(
    // A job skipped because its batch was cancelled counts as a success. A cancelled
    // batch with nothing failed still drains to zero and still runs `then`.
    'a cancelled batch with no failures still completes and runs then',
    callbacks.includes('then-hook') && afterStopped?.failedJobs === 0,
    `${callbacks.join(',')} failed=${afterStopped?.failedJobs}`,
  );
  check(
    'but it still runs finally',
    callbacks.includes('finally-hook'),
    callbacks.join(','),
  );

  // --- A failure cancels, like an explicit cancel ---
  callbacks.length = 0;
  const strict = await batches.dispatch({
    name: 'Strict',
    jobs: [{ queue: 'bat', name: 'bad', data: { boom: true } }],
    finally: { queue: 'bat', name: 'finally-hook' },
  });

  await sleep(2500);

  const afterStrict = await batches.find(strict.id);
  check(
    'a failure-cancelled batch records when it was cancelled',
    afterStrict?.cancelled === true && typeof afterStrict.cancelledAt === 'string',
    JSON.stringify({ c: afterStrict?.cancelled, at: afterStrict?.cancelledAt }),
  );
  check(
    'and reports that cancellation as an event',
    cancelledEvents.includes(strict.id),
    cancelledEvents.length ? 'yes' : 'no',
  );

  // --- A chain written off in one decrement ---
  callbacks.length = 0;
  const crossing = await batches.dispatch({
    name: 'Crossing zero',
    allowFailures: true,
    jobs: [
      [
        { queue: 'bat', name: 'chunk', data: { step: 'p', boom: true } },
        { queue: 'bat', name: 'chunk', data: { step: 'q' } },
      ],
    ],
    finally: { queue: 'bat', name: 'finally-hook' },
  });

  await sleep(2500);

  const afterCrossing = await batches.find(crossing.id);
  check(
    'a chain written off in one go settles rather than hanging',
    afterCrossing?.pendingJobs === 1 && afterCrossing.failedJobs === 1,
    JSON.stringify({
      finished: afterCrossing?.finished,
      pending: afterCrossing?.pendingJobs,
    }),
  );
  check(
    'and fires its hooks exactly once',
    callbacks.filter((name) => name === 'finally-hook').length === 1,
    callbacks.join(','),
  );

  // --- Cancelling a batch that is gone ---
  let refused = false;

  try {
    await batches.cancel('does-not-exist');
  } catch {
    refused = true;
  }

  check(
    'cancelling an unknown batch reports it is gone rather than succeeding',
    refused && (await batches.find('does-not-exist')) === null,
  );

  // --- Progress and listing ---
  const page = await batches.list({ search: 'Chained', page: 0, perPage: 10 });
  check(
    'batches can be searched by name',
    page.batches.length === 1 && page.batches[0].name === 'Chained export',
    `${page.batches.length}`,
  );

  const progress = await batches.find(chained.id);
  check(
    'a finished batch reports 100%',
    progress?.progress === 100,
    `${progress?.progress}`,
  );

  // --- Timeouts ---
  const timedOut = await batches.dispatch({
    name: 'Times out',
    jobs: [{ queue: 'bat-slow', name: 'slow', data: { slowMs: 3000 } }],
  });

  await sleep(5000);

  const afterTimeout = await batches.find(timedOut.id);
  const timedOutFailures = await jobs.list('failed', { queue: 'bat-slow' });

  check(
    'a job the timeout failed counts against its batch, not for it',
    afterTimeout?.failedJobs === 1 && timedOutFailures.total === 1,
    JSON.stringify({
      batchFailed: afterTimeout?.failedJobs,
      queueFailed: timedOutFailures.total,
    }),
  );

  check('an unknown batch resolves to null', (await batches.find('nope')) === null);

  await maintenance.clearAll();
  await maintenance.forgetFailed();
  await app.close();
  await wipe(PREFIX);

  return suite;
}
