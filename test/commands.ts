import { Inject, Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Suite, connection, sleep, wipe } from './harness';
import type { Job } from 'bullmq';
import {
  BatchService,
  SentinelModule,
  SentinelProcessor,
  JobsService,
  MaintenanceService,
  MetricsService,
  WorkerRegistry,
  BatchedProcessor,
  type SentinelOptions,
} from '../src';

const SUITE = 'commands';

const PREFIX = 'sentinel-cmd';

@Injectable()
@SentinelProcessor('cmd')
class CmdProcessor extends BatchedProcessor {
  constructor(@Inject(BatchService) batches: BatchService) {
    super(batches);
  }

  protected async process(job: Job): Promise<void> {
    await sleep(10);

    if ((job.data as { boom?: boolean }).boom) {
      throw new Error('boom');
    }
  }
}

const options = (): SentinelOptions => ({
  prefix: PREFIX,
  connection: connection(),
  worker: true,
  supervisors: {
    main: { queues: ['cmd'], concurrency: 2 },
    aux: { queues: ['cmd-aux'] },
  },
  defaultJobOptions: { attempts: 1, removeOnComplete: 200, removeOnFail: 200 },
  board: { enabled: false },
});

@Module({ imports: [SentinelModule.forRoot(options())], providers: [CmdProcessor] })
class TestModule {}

export async function run(): Promise<Suite> {
  const suite = new Suite(SUITE);
  const check = suite.check.bind(suite);

  let terminated = false;
  process.on('SIGTERM', () => (terminated = true));

  const app = await NestFactory.createApplicationContext(TestModule, { logger: false });
  await app.init();

  const jobs = app.get(JobsService);
  const batches = app.get(BatchService);
  const metrics = app.get(MetricsService);
  const workers = app.get(WorkerRegistry);
  const maintenance = app.get(MaintenanceService);

  await wipe(PREFIX);
  await maintenance.resumeAll();

  // --- Retrying a batch's failed jobs ---
  const batch = await batches.dispatch({
    name: 'Batch with failures',
    allowFailures: true,
    jobs: [
      { queue: 'cmd', name: 'good', data: {} },
      { queue: 'cmd', name: 'bad', data: { boom: true } },
      { queue: 'cmd', name: 'worse', data: { boom: true } },
    ],
  });

  await sleep(2500);

  const failedRefs = await batches.failedJobs(batch.id);
  check('batch records its failed jobs', failedRefs.length === 2, `${failedRefs.length}`);

  for (const ref of failedRefs) {
    await jobs.retry(ref.queue, ref.jobId);
  }

  await sleep(2000);

  // `failedJobs` is a cumulative tally. The retried jobs fail again, and only a rise in
  // that tally proves they really re-ran.
  const afterRetry = await batches.find(batch.id);
  check(
    'a batch can retry its failures',
    afterRetry !== null && afterRetry.failedJobs > failedRefs.length,
    JSON.stringify({
      processed: afterRetry?.processedJobs,
      failed: afterRetry?.failedJobs,
    }),
  );

  // --- Global pause and resume ---
  const pausedNames = await maintenance.pauseAll();
  const pausedNow = await workers.paused();
  check(
    'pauseAll pauses every supervisor',
    pausedNames.length === 2 && pausedNow.length === 2,
    JSON.stringify(pausedNow),
  );

  await maintenance.resumeAll();
  check('resumeAll clears them', (await workers.paused()).length === 0);

  // --- clear-metrics ---
  await metrics.recordCompleted('cmd', 'good', 50);
  check(
    'metrics are recorded before clearing',
    (await metrics.measuredQueues()).includes('cmd'),
  );

  await maintenance.clearMetrics();
  check(
    'clearMetrics empties the measurements',
    (await metrics.measuredQueues()).length === 0,
  );

  // --- terminate ---
  check('nothing terminated before asking', !terminated);

  await maintenance.terminate();
  await sleep(4000);

  check('terminate drains the worker', terminated);

  const requestedAt = await workers.terminateRequestedAt();
  check(
    'the terminate flag carries its timestamp',
    (requestedAt ?? 0) > 0,
    `${requestedAt}`,
  );

  await app.close();
  await wipe(PREFIX);

  return suite;
}
