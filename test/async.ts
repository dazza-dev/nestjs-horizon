import { Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Job } from 'bullmq';
import {
  SENTINEL_OPTIONS,
  SentinelModule,
  SentinelProcessor,
  MaintenanceService,
  QueueRegistry,
  type SentinelEvents,
  type SentinelOptions,
  type JobHandler,
} from '../src';
import { SentinelEvents as Events } from '../src/events/sentinel.events';
// Internal on purpose: an application never injects it, but the retirement path
// has no other way in.
import { WorkerLimitsService } from '../src/worker/worker-limits.service';
import { Suite, connection, sleep, wipe } from './harness';

const SUITE = 'async';
const PREFIX = 'sentinel-async';

const ran: string[] = [];

@Injectable()
@SentinelProcessor('async-q')
class AsyncProcessor implements JobHandler {
  handle(job: Job): Promise<void> {
    ran.push(job.name);

    return Promise.resolve();
  }
}

/** Stands in for a ConfigService: the reason an application reaches for forRootAsync. */
@Injectable()
class Settings {
  readonly prefix = PREFIX;
  readonly concurrency = 3;

  build(): SentinelOptions {
    return {
      prefix: this.prefix,
      connection: connection(),
      worker: true,
      supervisors: { main: { queues: ['async-q'], concurrency: this.concurrency } },
      defaultJobOptions: { attempts: 1, removeOnComplete: 100 },
      board: { enabled: false },
      workerLimits: { maxJobs: 2 },
    };
  }
}

@Module({ providers: [Settings], exports: [Settings] })
class SettingsModule {}

@Module({
  imports: [
    SentinelModule.forRootAsync({
      imports: [SettingsModule],
      inject: [Settings],
      // Async on purpose: a real factory awaits a config source.
      useFactory: async (settings: Settings) => {
        await sleep(10);

        return settings.build();
      },
    }),
  ],
  providers: [AsyncProcessor],
})
class TestModule {}

export async function run(): Promise<Suite> {
  const suite = new Suite(SUITE);
  const check = suite.check.bind(suite);

  ran.length = 0;

  await wipe(PREFIX);

  const app = await NestFactory.createApplicationContext(TestModule, { logger: false });
  await app.init();

  const queues = app.get(QueueRegistry);
  const maintenance = app.get(MaintenanceService);
  const events = app.get<SentinelEvents>(Events);

  // --- The factory's options reach the container ---
  const resolved = app.get<SentinelOptions>(SENTINEL_OPTIONS);

  check(
    'the async factory decides the configuration',
    resolved.prefix === PREFIX && resolved.supervisors.main.concurrency === 3,
    JSON.stringify({
      prefix: resolved.prefix,
      concurrency: resolved.supervisors.main.concurrency,
    }),
  );

  // `resolveOptions` runs on the factory's result, not only on a literal.
  check(
    'and its result is normalised the same way forRoot normalises one',
    typeof resolved.waits === 'object' && resolved.waits !== null,
    JSON.stringify(resolved.waits),
  );

  check(
    'an injected dependency is available to the factory',
    app.get(Settings).prefix === PREFIX,
  );

  // --- Dispatching through an async boot ---
  check('the queues declared by the factory exist', queues.names().includes('async-q'));

  const retiring: string[] = [];

  events.on('worker.retiring', (event) => retiring.push(event.reason));

  await queues.dispatch('async-q', 'first', {});
  await sleep(1500);

  check(
    'a job dispatched through an async boot runs',
    ran.includes('first'),
    ran.join(','),
  );

  // --- workerLimits ---
  check(
    'the worker has not retired before its limit',
    retiring.length === 0,
    retiring.join(','),
  );

  // SIGTERM is caught for the duration. Uncaught, it takes the test runner down with it.
  let terminated = false;
  const onTerm = () => {
    terminated = true;
  };

  process.on('SIGTERM', onTerm);

  const limits = app.get(WorkerLimitsService);

  // The second job crosses `maxJobs: 2`, which the worker manager reports per attempt.
  limits.countJob();
  limits.countJob();
  await sleep(200);

  check(
    'a worker retires once it passes maxJobs',
    retiring.length === 1 && retiring[0].includes('2 jobs'),
    retiring.join(',') || 'never retired',
  );

  check('and it retires by asking the process to stop, not by exiting', terminated);

  limits.countJob();
  await sleep(100);

  check(
    'retiring happens once, however many jobs follow',
    retiring.length === 1,
    `${retiring.length}`,
  );

  process.off('SIGTERM', onTerm);

  await maintenance.clearAll();
  await app.close();
  await wipe(PREFIX);

  return suite;
}
