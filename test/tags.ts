import { Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Job } from 'bullmq';
import {
  SentinelModule,
  SentinelProcessor,
  JobsService,
  MaintenanceService,
  QueueRegistry,
  TagsService,
  type SentinelOptions,
} from '../src';
import { Suite, client, connection, sleep, wipe } from './harness';

const SUITE = 'tags';
const PREFIX = 'sentinel-tags';

@Injectable()
@SentinelProcessor('work')
class WorkProcessor {
  async handle(job: Job): Promise<void> {
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
  supervisors: { main: { queues: ['work'], concurrency: 1 } },
  defaultJobOptions: { attempts: 1, removeOnComplete: 500, removeOnFail: 500 },
  silenced: ['heartbeat'],
  silencedTags: ['noise'],
  metrics: { trimFailedMinutes: 30 },
  board: { enabled: false },
});

@Module({ imports: [SentinelModule.forRoot(options())], providers: [WorkProcessor] })
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
  const maintenance = app.get(MaintenanceService);
  const redis = client();

  await tags.monitor('invoices');

  await queues.dispatch('work', 'ok', { tags: ['invoices'] });
  await queues.dispatch('work', 'heartbeat', {});
  await queues.dispatch('work', 'chatty', { tags: ['noise'] });
  await queues.dispatch('work', 'self-quiet', { silenced: true });
  await queues.dispatch('work', 'heartbeat', { boom: true });
  await queues.dispatch('work', 'billing', { tags: ['invoices', 'orders'], boom: true });
  await sleep(3000);

  const failed = await jobs.list('failed', {});
  check(
    'a silenced failure stays in the failed listing',
    failed.jobs.some((job) => job.name === 'heartbeat'),
    failed.jobs.map((job) => job.name).join(','),
  );

  const completed = await jobs.list('completed', {});
  check(
    'a silenced success is out of the completed listing',
    !completed.jobs.some((job) => job.name === 'heartbeat'),
    completed.jobs.map((job) => job.name).join(','),
  );

  const silenced = await jobs.list('silenced', {});
  const names = silenced.jobs.map((job) => job.name).sort();
  check('silencedTags silences by tag', names.includes('chatty'), names.join(','));
  check(
    'a payload flag silences the job itself',
    names.includes('self-quiet'),
    names.join(','),
  );
  check(
    'tag-silenced and self-silenced jobs leave the completed listing',
    !completed.jobs.some((job) => ['chatty', 'self-quiet'].includes(job.name)),
    completed.jobs.map((job) => job.name).join(','),
  );

  // Only the completion path writes the silenced index. A silenced job that failed
  // belongs in the failed listing and nowhere else.
  check(
    'a silenced failure is not in the silenced listing either',
    silenced.jobs.every((job) => !job.failedReason),
    silenced.jobs.map((job) => `${job.name}:${job.failedReason ?? 'ok'}`).join(','),
  );

  // The silenced listing is its own index. Back when it was a filter over the completed
  // window, ordinary traffic pushed silenced jobs out of it.
  for (let n = 0; n < 40; n += 1) {
    await queues.dispatch('work', `noise-${n}`, {});
  }

  await sleep(3000);

  const stillSilenced = await jobs.list('silenced', {});

  check(
    'silenced jobs survive ordinary traffic piling on top of them',
    stillSilenced.total === silenced.total,
    `before=${silenced.total} after=${stillSilenced.total}`,
  );

  const found = await jobs.list('silenced', { search: 'chatty', perPage: 1 });

  check(
    'searching the silenced listing counts matches, not matches on this page',
    found.total === 1 && found.jobs[0]?.name === 'chatty',
    `total=${found.total} ${found.jobs.map((job) => job.name).join(',')}`,
  );

  const byTag = await tags.jobsFor('orders', 'failed');
  const byTagJobs = await jobs.findMany(byTag.refs);
  check(
    'failures are indexed under every tag, monitored or not',
    byTag.total === 1 && byTagJobs[0]?.name === 'billing',
    `total=${byTag.total} ${byTagJobs.map((job) => job.name).join(',')}`,
  );

  const listedByTag = await jobs.list('failed', { search: 'orders' });
  check(
    'the generic search matches tags too',
    listedByTag.jobs.some((job) => job.name === 'billing'),
    listedByTag.jobs.map((job) => job.name).join(','),
  );

  const monitored = await tags.monitoredWithCounts();
  const invoices = monitored.find((entry) => entry.tag === 'invoices');
  check(
    'a monitored tag counts jobs and failures apart',
    invoices?.count === 2 && invoices.failed === 1,
    JSON.stringify(invoices),
  );

  const failedTab = await tags.jobsFor('invoices', 'failed');
  check(
    'the failed tab of a monitored tag lists its failures',
    failedTab.total === 1,
    `total=${failedTab.total}`,
  );

  const failureTtl = await redis.ttl(`${PREFIX}:failed-tag:orders`);
  check(
    'the failure index expires',
    failureTtl > 0 && failureTtl <= 30 * 60,
    `ttl=${failureTtl}s`,
  );

  const monitoredTtl = await redis.ttl(`${PREFIX}:tag:invoices`);
  check('the monitored index is permanent', monitoredTtl === -1, `ttl=${monitoredTtl}`);

  // `billing` is monitored and also failed, and each index keeps its own copy. One shared
  // key would let the failure's expiry land on the permanent copy.
  const billing = byTag.refs[0].jobId;
  const monitoredCopy = await redis.ttl(`${PREFIX}:tagged:work:${billing}`);
  const failedCopy = await redis.ttl(`${PREFIX}:failed-tagged:work:${billing}`);

  check(
    'a monitored copy keeps the monitored retention even when the job also failed',
    monitoredCopy > 30 * 60,
    `ttl=${monitoredCopy}`,
  );
  check(
    'while the failure copy expires on its own',
    failedCopy > 0 && failedCopy <= 30 * 60,
    `ttl=${failedCopy}`,
  );

  const detail = await jobs.find('work', byTag.refs[0].jobId);
  check(
    'the job detail carries its tags',
    detail.tags.includes('orders'),
    JSON.stringify(detail.tags),
  );

  await maintenance.clearAll();
  await maintenance.forgetFailed();
  await redis.quit();
  await app.close();
  await wipe(PREFIX);

  return suite;
}
