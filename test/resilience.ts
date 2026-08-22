import { Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import {
  SentinelEvents,
  SentinelModule,
  SentinelProcessor,
  JobsService,
  LockService,
  MaintenanceService,
  MetricsService,
  QueueRegistry,
  StatsService,
  TagsService,
  WorkerRegistry,
  type SentinelOptions,
} from '../src';
import { normalizeConnection } from '../src/sentinel.options';
import { Suite, client, connection, sleep, wipe } from './harness';

const SUITE = 'resilience';
const PREFIX = 'sentinel-res';

@Injectable()
@SentinelProcessor('res')
class ResProcessor {
  async handle(job: Job): Promise<void> {
    const data = job.data as {
      throwString?: boolean;
      boom?: boolean;
      unrecoverable?: boolean;
    };

    await sleep(5);

    if (data.throwString) {
      // Not every failure is an Error; a library must survive whatever a job throws.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'just a string';
    }

    if (data.unrecoverable) {
      throw new UnrecoverableError('give up');
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
  supervisors: { main: { queues: ['res'], concurrency: 2 } },
  defaultJobOptions: { attempts: 1, removeOnComplete: 100, removeOnFail: 100 },
  board: { enabled: false },
});

@Module({ imports: [SentinelModule.forRoot(options())], providers: [ResProcessor] })
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
  const stats = app.get(StatsService);
  const metrics = app.get(MetricsService);
  const workers = app.get(WorkerRegistry);
  const maintenance = app.get(MaintenanceService);
  const events = app.get(SentinelEvents);
  const redis = client();

  // --- The worker index replaces the key scan ---
  await sleep(300);

  const indexed = await redis.smembers(`${PREFIX}:workers`);
  check(
    'the worker registers itself in an index',
    indexed.length === 1,
    `${indexed.length}`,
  );

  const alive = await workers.all();
  check('the index resolves to the worker record', alive.length === 1, `${alive.length}`);

  await redis.sadd(`${PREFIX}:workers`, 'ghost:999');
  const afterGhost = await workers.all();
  check(
    'an id whose record expired is ignored',
    afterGhost.length === 1,
    `${afterGhost.length}`,
  );
  check(
    'and swept out of the index as we pass',
    !(await redis.smembers(`${PREFIX}:workers`)).includes('ghost:999'),
  );

  // --- Per-queue slots, not the whole process ---
  const perQueue = await stats.workload();
  check(
    'a queue reports its own concurrency, not the worker total',
    perQueue[0]?.processes === 2,
    `processes=${perQueue[0]?.processes}`,
  );

  // --- A listener that throws ---
  events.on('job.completed', () => {
    throw new Error('a bad listener');
  });

  await queues.dispatch('res', 'ok', {});
  await sleep(800);

  const completed = await jobs.list('completed', { queue: 'res' });
  check(
    'a listener that throws does not stop the job from completing',
    completed.total === 1,
    `${completed.total}`,
  );

  // --- A job that throws something that is not an Error ---
  await queues.dispatch('res', 'rude', { throwString: true });
  await sleep(1000);

  const failed = await jobs.list('failed', { queue: 'res' });
  check(
    'a job that throws a string still lands in the failed listing',
    failed.total === 1 && failed.jobs[0].name === 'rude',
    `${failed.total} ${failed.jobs[0]?.name ?? ''}`,
  );

  // --- Hostile input reaching Redis keys ---
  await tags.monitor('weird tag: with *stars* and spaces');
  const monitored = await tags.monitoredWithCounts();
  check(
    'a tag with wildcards and spaces round-trips',
    monitored.some((entry) => entry.tag === 'weird tag: with *stars* and spaces'),
    JSON.stringify(monitored.map((entry) => entry.tag)),
  );

  await tags.stopMonitoring('weird tag: with *stars* and spaces');
  check(
    'and stopping it does not take anything else with it',
    (await tags.monitoredWithCounts()).length === 0,
  );

  // --- Unknown queues and unknown jobs ---
  let refused = false;

  try {
    queues.get('not-a-queue');
  } catch {
    refused = true;
  }

  check('an undeclared queue is refused', refused);

  let notFound = false;

  try {
    await jobs.find('res', '999999');
  } catch {
    notFound = true;
  }

  check('a job that does not exist throws instead of returning junk', notFound);

  // --- An empty install ---
  await maintenance.clearAll();
  await maintenance.forgetFailed();
  await wipe(PREFIX);

  const empty = await stats.dashboard();
  check(
    'a fresh install reports zeros rather than failing',
    empty.recentJobs === 0 && empty.failedJobs === 0 && empty.maxWait === 0,
    JSON.stringify({ recent: empty.recentJobs, failed: empty.failedJobs }),
  );

  const emptyWorkload = await stats.workload();
  check(
    'the workload lists the configured queues even when idle',
    emptyWorkload.length === 1 && emptyWorkload[0].length === 0,
    JSON.stringify(emptyWorkload),
  );

  // --- clearMetrics ---
  await metrics.recordCompleted('res', 'ok', 20);
  await maintenance.clearMetrics();

  await metrics.recordFailed('res', 'ok', Date.now(), 'x1');
  await maintenance.clearMetrics();

  const measurements = await redis.keys(`${PREFIX}:metrics:queue:*`);
  const snapshots = await redis.keys(`${PREFIX}:metrics:snapshot:*`);
  const history = await metrics.recentlyFailed();

  check(
    'clearMetrics drops the measurements',
    measurements.length === 0 && snapshots.length === 0,
    `measurements=${measurements.length} snapshots=${snapshots.length}`,
  );
  check('clearMetrics keeps the job history', history > 0, `failed=${history}`);

  // --- UnrecoverableError ---
  const failedBefore = await metrics.recentlyFailed();

  await queues.dispatch(
    'res',
    'doomed',
    { tags: ['doom'], unrecoverable: true },
    { attempts: 5, backoff: 10 },
  );
  await sleep(1500);

  check(
    'a job that gives up early is counted as failed',
    (await metrics.recentlyFailed()) - failedBefore === 1,
    `delta=${(await metrics.recentlyFailed()) - failedBefore}`,
  );
  check(
    'and is indexed under its tags',
    (await tags.jobsFor('doom', 'failed')).total === 1,
  );

  let badSupervisor = false;

  try {
    await workers.pause('does-not-exist');
  } catch {
    badSupervisor = true;
  }

  check('pausing a supervisor that does not exist is refused', badSupervisor);

  // --- job.pushed and job.started ---
  const pushed: string[] = [];
  const started: string[] = [];

  events.on('job.pushed', (e) => pushed.push(`${e.name}:${e.jobId}`));
  events.on('job.started', (e) => started.push(`${e.name}:${e.jobId}@${e.attempt}`));

  const traced = await queues.dispatch('res', 'traced', {});
  await sleep(800);

  check(
    'job.pushed fires on dispatch',
    pushed.includes(`traced:${String(traced.id)}`),
    pushed.join(','),
  );
  check(
    'job.started fires with the attempt number',
    started.includes(`traced:${String(traced.id)}@1`),
    started.join(','),
  );

  // --- A monitored tag outliving its job ---
  await tags.monitor('kept');
  const doomed = await queues.dispatch('res', 'vanishing', { tags: ['kept'] });
  await sleep(800);

  // The queue forgets it; the tag must not.
  await queues.get('res').remove(String(doomed.id));

  const keptRefs = await tags.jobsFor('kept', 'jobs');
  const keptJobs = await jobs.findMany(keptRefs.refs);

  check(
    'a monitored tag survives the job being trimmed',
    keptRefs.total === 1 && keptJobs.length === 1 && keptJobs[0].name === 'vanishing',
    `total=${keptRefs.total} resolved=${keptJobs.length}`,
  );
  await tags.stopMonitoring('kept');

  // --- Two listeners, the first one throwing ---
  const heard: string[] = [];

  events.on('job.pushed', () => {
    throw new Error('a bad listener');
  });
  events.on('job.pushed', () => heard.push('second'));

  await queues.dispatch('res', 'shared', {});

  check('a throwing listener does not block the next one', heard.includes('second'));

  // --- Hostile paging ---
  const hostile = await jobs.list('completed', { queue: 'res', perPage: 0, page: -1 });

  check(
    'a zero page size falls back instead of loading everything',
    hostile.jobs.length <= 25,
    `${hostile.jobs.length}`,
  );

  // --- normalizeConnection ---
  const keptTls = normalizeConnection({
    url: 'rediss://example.com',
    tls: undefined,
    password: undefined,
  });

  check(
    'an undefined override does not undo the url',
    keptTls.tls !== undefined,
    JSON.stringify(keptTls),
  );

  const fromUrl = normalizeConnection({ url: 'redis://user:p%40ss@example.com:6380/3' });

  check(
    'a redis:// url is unpacked into fields',
    fromUrl.host === 'example.com' &&
      fromUrl.port === 6380 &&
      fromUrl.db === 3 &&
      fromUrl.username === 'user' &&
      fromUrl.password === 'p@ss',
    JSON.stringify(fromUrl),
  );

  const secure = normalizeConnection({ url: 'rediss://example.com' });
  check(
    'rediss:// turns on TLS and defaults the port',
    secure.tls !== undefined && secure.port === 6379,
    JSON.stringify(secure),
  );

  const overridden = normalizeConnection({ url: 'redis://example.com:6380', db: 9 });
  check(
    'an explicit field overrides the url',
    overridden.host === 'example.com' && overridden.db === 9,
    JSON.stringify(overridden),
  );

  let badUrl = false;

  try {
    normalizeConnection({ url: 'not a url' });
  } catch {
    badUrl = true;
  }

  check('a malformed url fails loudly instead of silently using localhost', badUrl);

  // --- The fleet-wide lock ---
  const lock = app.get(LockService);
  let ran = 0;

  const attempts = await Promise.all(
    Array.from({ length: 5 }, () =>
      lock.once('probe', 3000, () => {
        ran += 1;

        return Promise.resolve();
      }),
    ),
  );

  check(
    'only one caller wins the lock',
    attempts.filter(Boolean).length === 1 && ran === 1,
    `winners=${attempts.filter(Boolean).length} runs=${ran}`,
  );

  const stillHeld = await lock.once('probe', 3000, () => Promise.resolve());
  check('the lock keeps others out while it is held', stillHeld === false);

  // A holder that dies must not block the fleet: the lock expires on its own.
  await lock.once('short', 1000, () => Promise.resolve());
  await sleep(1300);

  const afterExpiry = await lock.once('short', 1000, () => Promise.resolve());
  check('an expired lock is free again', afterExpiry === true);

  // --- Big payloads ---
  const big = { tags: ['big'], blob: 'x'.repeat(200_000) };

  await queues.dispatch('res', 'heavy', big);
  await sleep(800);

  const heavy = await jobs.list('completed', { queue: 'res', search: 'heavy' });
  check(
    'a 200KB payload survives the round trip',
    heavy.jobs.length === 1 &&
      (heavy.jobs[0].data as { blob: string }).blob.length === 200_000,
    `${heavy.jobs.length}`,
  );

  // --- Booting into a paused fleet ---
  await workers.pause('main');

  // The worker this suite already started polls the flag. Give it time to stop before
  // queueing anything, or it eats the batch and the late worker is never tested.
  await sleep(5000);

  for (let n = 0; n < 10; n += 1) {
    await queues.dispatch('res', `paused-boot-${n}`, {});
  }

  const late = await NestFactory.createApplicationContext(TestModule, { logger: false });

  await late.init();
  await sleep(5000);

  const consumed = (await jobs.list('completed', { queue: 'res' })).jobs.filter((job) =>
    job.name.startsWith('paused-boot-'),
  ).length;

  // The flags are read before the workers open. Left to itself a worker consumes for a
  // whole poll interval before its first check, and a fleet paused before this process
  // existed came up consuming while the dashboard still said paused.
  check(
    'a worker that starts into a paused fleet consumes nothing',
    consumed === 0,
    `consumed=${consumed}`,
  );

  await workers.resume('main');
  await sleep(5000);

  check(
    'and picks the backlog up once the fleet resumes',
    (await jobs.list('completed', { queue: 'res' })).jobs.filter((job) =>
      job.name.startsWith('paused-boot-'),
    ).length === 10,
    `consumed=${
      (await jobs.list('completed', { queue: 'res' })).jobs.filter((job) =>
        job.name.startsWith('paused-boot-'),
      ).length
    }`,
  );

  await late.close();

  // --- Supervisor names off Object.prototype ---
  let prototypeRefused = true;

  for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    try {
      await workers.pause(name);
      prototypeRefused = false;
    } catch {
      // Expected: only declared supervisors can be paused.
    }
  }

  const pausedSet = await workers.paused();

  check(
    'a supervisor name inherited from Object is refused',
    prototypeRefused && pausedSet.length === 0,
    JSON.stringify(pausedSet),
  );

  await maintenance.clearAll();
  await maintenance.forgetFailed();
  await redis.quit();
  await app.close();

  // --- After a graceful shutdown ---
  const after = client();
  const remaining = await after.smembers(`${PREFIX}:workers`);

  check(
    'a worker leaves the index on shutdown',
    remaining.length === 0,
    `${remaining.length}`,
  );

  await after.quit();
  await wipe(PREFIX);

  return suite;
}
