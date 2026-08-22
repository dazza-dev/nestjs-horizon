import { Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Job } from 'bullmq';
import {
  SENTINEL_OPTIONS,
  SentinelEvents,
  SentinelModule,
  SentinelProcessor,
  JobsService,
  MaintenanceService,
  MetricsService,
  QueueRegistry,
  StatsService,
  TagsService,
  type SentinelOptions,
} from '../src';
import { Suite, connection, sleep, wipe } from './harness';

const SUITE = 'reporting';
const PREFIX = 'sentinel-reporting';

process.env.NODE_ENV = 'test';

@Injectable()
@SentinelProcessor('quick')
class QuickProcessor {
  async handle(job: Job): Promise<void> {
    await sleep(Number((job.data as { delayMs?: number }).delayMs ?? 10));
  }
}

@Injectable()
@SentinelProcessor('slow')
class SlowProcessor {
  async handle(): Promise<void> {
    await sleep(5000);
  }
}

const options = (): SentinelOptions => ({
  name: 'Reporting Test',
  prefix: PREFIX,
  connection: connection(),
  worker: true,
  supervisors: {
    main: {
      queues: ['quick'],
      concurrency: 2,
      defaultJobOptions: { attempts: 1, removeOnComplete: 100 },
    },
    heavy: { queues: ['slow'], concurrency: 1, timeoutSeconds: 1 },
  },
  defaultJobOptions: { attempts: 1, removeOnComplete: 100, removeOnFail: 100 },
  silenced: ['noisy'],
  environments: {
    test: { main: { concurrency: 7, defaultJobOptions: { attempts: 2 } } },
  },
  trim: { completed: 1 },
  metrics: { trimSnapshots: { job: 5, queue: 9 }, trimRecentFailedMinutes: 15 },
  waits: { default: 30 },
  board: { enabled: false },
});

@Module({
  imports: [SentinelModule.forRoot(options())],
  providers: [QuickProcessor, SlowProcessor],
})
class TestModule {}

export async function run(): Promise<Suite> {
  const suite = new Suite(SUITE);
  const check = suite.check.bind(suite);

  await wipe(PREFIX);

  const app = await NestFactory.createApplicationContext(TestModule, { logger: false });
  await app.init();

  const queues = app.get(QueueRegistry);
  const jobs = app.get(JobsService);
  const tags = app.get(TagsService);
  const events = app.get(SentinelEvents);
  const maintenance = app.get(MaintenanceService);
  const metrics = app.get(MetricsService);

  const seen = { completed: 0, failed: 0, lastError: '' };
  events.on('job.completed', () => (seen.completed += 1));
  events.on('job.failed', (event) => {
    seen.failed += 1;
    seen.lastError = event.error;
  });

  const resolved = app.get<SentinelOptions>(SENTINEL_OPTIONS);
  check(
    'environments overrides apply for NODE_ENV',
    resolved.supervisors.main.concurrency === 7,
    `concurrency=${resolved.supervisors.main.concurrency}`,
  );

  await tags.monitor('invoice');
  await queues.dispatch('quick', 'tagged', { tags: ['invoice'], delayMs: 10 });
  await queues.dispatch('quick', 'untagged', { delayMs: 10 });
  await queues.dispatch('quick', 'noisy', { delayMs: 10 });
  await sleep(1500);

  const monitored = await tags.monitoredWithCounts();
  check(
    'a monitored tag collects its job',
    monitored.find((entry) => entry.tag === 'invoice')?.count === 1,
    JSON.stringify(monitored),
  );

  const tagged = await tags.jobsFor('invoice', 'jobs');
  const taggedJobs = await jobs.findMany(tagged.refs);
  check(
    'a monitored tag resolves to its job',
    taggedJobs.length === 1 && taggedJobs[0].name === 'tagged',
    taggedJobs.map((job) => job.name).join(','),
  );
  check(
    'tags travel in the job view',
    taggedJobs[0]?.tags.includes('invoice') === true,
    JSON.stringify(taggedJobs[0]?.tags),
  );

  const completed = await jobs.list('completed', {});
  const silenced = await jobs.list('silenced', {});
  check(
    'a silenced job is out of the completed listing',
    !completed.jobs.some((job) => job.name === 'noisy'),
    completed.jobs.map((job) => job.name).join(','),
  );
  check(
    'the silenced listing shows only silenced jobs',
    silenced.jobs.length === 1 && silenced.jobs[0].name === 'noisy',
    silenced.jobs.map((job) => job.name).join(','),
  );

  await queues.dispatch('slow', 'hangs', {});
  await sleep(2500);

  const failed = await jobs.list('failed', { queue: 'slow' });
  check(
    'a job over its timeout fails',
    failed.jobs.length === 1 && /timeout of 1s/.test(failed.jobs[0].failedReason ?? ''),
    failed.jobs[0]?.failedReason ?? 'no failure recorded',
  );

  check('job.completed fires', seen.completed === 3, `count=${seen.completed}`);
  check(
    'job.failed fires with the reason',
    seen.failed === 1 && /timeout/.test(seen.lastError),
    `${seen.failed} / ${seen.lastError}`,
  );

  await queues.get('quick').pause();
  await queues.dispatch('quick', 'to-be-cleared', { delayMs: 50 });

  const completedBefore = (await jobs.list('completed', { queue: 'quick' })).total;
  const cleared = await maintenance.clear('quick');
  const pendingAfter = await jobs.list('pending', { queue: 'quick' });
  const completedAfter = (await jobs.list('completed', { queue: 'quick' })).total;

  await queues.get('quick').resume();

  check(
    'clear drops the work that had not run',
    cleared === 1 && pendingAfter.total === 0,
    `cleared=${cleared} pending=${pendingAfter.total}`,
  );
  check(
    'clear keeps the history',
    completedAfter === completedBefore,
    `before=${completedBefore} after=${completedAfter}`,
  );

  // The wait is a forecast: ready jobs x runtime / processes.
  const stats = app.get(StatsService);

  await maintenance.clear('quick');
  await queues.get('quick').pause();
  for (let i = 0; i < 4; i += 1) {
    await queues.dispatch('quick', 'backlog', { delayMs: 10 });
  }

  // Age the backlog: the oldest job is seconds old while the work itself is milliseconds.
  await sleep(3000);

  const workload = await stats.workload();
  const quick = workload.find((entry) => entry.name === 'quick');

  check(
    'the workload counts the backlog',
    (quick?.length ?? 0) >= 4,
    `length=${quick?.length}`,
  );
  check(
    'wait forecasts the time to clear, not the age of the oldest job',
    // Queued 3s ago, but four jobs at ~10ms clear in well under a second. A wait of 3
    // would mean the age of the oldest job leaked back into the forecast.
    quick?.wait === 0,
    `wait=${quick?.wait}`,
  );

  await queues.get('quick').resume();
  await maintenance.clear('quick');

  const dashboard = await stats.dashboard();
  check(
    'the dashboard publishes the retention windows it counts over',
    dashboard.periods.recentJobs === 60 && dashboard.periods.failedJobs === 15,
    JSON.stringify(dashboard.periods),
  );

  // Settle first: a neighbouring test's jobs landing mid-measurement would move the rate.
  await sleep(2000);

  const rateBefore = await metrics.jobsPerMinute();
  const pushedBefore = await metrics.recentJobs();

  await queues.dispatch('quick', 'rate-later', {}, { delay: 600_000 });
  await sleep(800);

  // Scheduled for next month: it belongs in the recent-jobs card, never in a rate of work
  // done. Only a completion writes to that index; failures never reach it.
  check(
    'a job that has not run counts as pushed but not as work done',
    (await metrics.jobsPerMinute()) === rateBefore &&
      (await metrics.recentJobs()) - pushedBefore === 1,
    `rate ${rateBefore}→${await metrics.jobsPerMinute()} pushed +${
      (await metrics.recentJobs()) - pushedBefore
    }`,
  );

  // The busiest-queue cards compare the newest period. Reading the series from its oldest
  // end had them naming a winner from hours ago.
  await queues.dispatch('quick', 'one', { delayMs: 5 });
  await sleep(600);
  await metrics.snapshot();
  await queues.dispatch('quick', 'two', { delayMs: 5 });
  await queues.dispatch('quick', 'three', { delayMs: 5 });
  await sleep(900);
  await metrics.snapshot();

  const series = await metrics.snapshotsForQueue('quick');
  const newest = await metrics.lastSnapshotForQueue('quick');

  check(
    'the last snapshot is the newest one, not the first of the series',
    series.length >= 2 && newest.throughput === series[series.length - 1].throughput,
    `series=${JSON.stringify(series.map((point) => point.throughput))} newest=${newest.throughput}`,
  );

  const resolvedMetrics = app.get<SentinelOptions>(SENTINEL_OPTIONS).metrics;
  check(
    'snapshot limits can differ per series',
    typeof resolvedMetrics?.trimSnapshots === 'object' &&
      resolvedMetrics.trimSnapshots.job === 5 &&
      resolvedMetrics.trimSnapshots.queue === 9,
  );

  check(
    'the environment override merges job options instead of replacing them',
    resolved.supervisors.main.defaultJobOptions?.attempts === 2 &&
      resolved.supervisors.main.defaultJobOptions?.removeOnComplete === 100,
    JSON.stringify(resolved.supervisors.main.defaultJobOptions),
  );

  // Retention is age-based, through BullMQ's clean(grace, …).
  await queues.dispatch('quick', 'old', { delayMs: 5 });
  await sleep(600);

  const beforeTrim = (await jobs.list('completed', { queue: 'quick' })).total;
  const trimmed = await maintenance.trim();

  check(
    'nothing is trimmed before its window is up',
    trimmed === 0 &&
      (await jobs.list('completed', { queue: 'quick' })).total === beforeTrim,
    `removed=${trimmed}`,
  );

  const status = await maintenance.status();
  check(
    'status reports a running worker',
    status.status === 'running' && status.workers >= 1,
    JSON.stringify(status),
  );

  // --- jobsPerMinute on a young install ---
  await maintenance.clearMetrics();

  const now = Date.now();

  for (let n = 0; n < 12; n += 1) {
    await metrics.recordCompleted('quick', 'burst', 100, now - n * 2500, `burst-${n}`);
  }

  const rate = await metrics.jobsPerMinute();

  // Only a floor: the suite's own workers keep completing while this runs. Dividing by
  // the whole window would put this near 3, whatever they add.
  check(
    'the rate divides by the span observed, not by the whole window',
    rate > 15,
    `${rate}/min from 12 jobs in 30s`,
  );

  await app.close();
  await wipe(PREFIX);

  return suite;
}
