import { Inject, Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Job } from 'bullmq';
import {
  BatchService,
  BatchedProcessor,
  QueueRegistry,
  SentinelModule,
  SentinelProcessor,
  TagsService,
  setupSentinelBoard,
  type BatchedJobData,
  type SentinelOptions,
} from './src';

const PORT = 3333;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Payload extends BatchedJobData {
  boom?: boolean;
  slowMs?: number;
  label?: string;
}

@Injectable()
@SentinelProcessor('mail')
class MailProcessor extends BatchedProcessor<Payload> {
  constructor(@Inject(BatchService) batches: BatchService) {
    super(batches);
  }

  protected async process(job: Job<Payload>): Promise<void> {
    await sleep(job.data.slowMs ?? 150 + Math.floor(Math.random() * 400));

    if (job.data.boom) {
      throw new Error(`SMTP refused the message for ${job.data.label ?? 'a recipient'}`);
    }
  }
}

@Injectable()
@SentinelProcessor('reports')
class ReportsProcessor extends BatchedProcessor<Payload> {
  constructor(@Inject(BatchService) batches: BatchService) {
    super(batches);
  }

  protected async process(job: Job<Payload>): Promise<void> {
    await sleep(job.data.slowMs ?? 600 + Math.floor(Math.random() * 900));

    if (job.data.boom) {
      throw new Error('The report query timed out after 30s');
    }
  }
}

@Injectable()
@SentinelProcessor('webhooks')
class WebhooksProcessor extends BatchedProcessor<Payload> {
  constructor(@Inject(BatchService) batches: BatchService) {
    super(batches);
  }

  protected async process(job: Job<Payload>): Promise<void> {
    await sleep(job.data.slowMs ?? 80);

    if (job.data.boom) {
      throw new Error('Endpoint returned 503');
    }
  }
}

const options = (): SentinelOptions => ({
  name: 'Sentinel',
  connection: { host: '127.0.0.1', port: 6379, db: 13 },
  worker: true,
  supervisors: {
    'supervisor-mail': { queues: ['mail'], concurrency: 3 },
    'supervisor-reports': { queues: ['reports'], concurrency: 2 },
    'supervisor-webhooks': { queues: ['webhooks'], concurrency: 5 },
  },
  defaultJobOptions: { attempts: 1, removeOnComplete: 500, removeOnFail: 500 },
  // Short enough that the metric charts have points to draw within a minute of browsing.
  metrics: { snapshotIntervalSeconds: 20 },
  silenced: ['heartbeat'],
  waits: { default: 60 },
  board: {
    // Open on purpose: this is a local demo, not something to copy into an app.
    auth: () => true,
  },
});

@Module({
  imports: [SentinelModule.forRoot(options())],
  providers: [MailProcessor, ReportsProcessor, WebhooksProcessor],
})
class DemoModule {}

const NAMES = ['ana', 'bruno', 'carla', 'diego', 'elena', 'frank', 'gabriela'];
const pick = <T>(list: T[]): T => list[Math.floor(Math.random() * list.length)];

async function main() {
  const app = await NestFactory.create(DemoModule, { logger: ['warn', 'error'] });

  setupSentinelBoard(app);
  await app.listen(PORT);

  const queues = app.get(QueueRegistry);
  const batches = app.get(BatchService);
  const tags = app.get(TagsService);

  // --- Things to look at ---
  await tags.monitor('customer:42');
  await tags.monitor('billing');

  // Completed work: the listings and the metric charts open with something in them.
  for (let i = 0; i < 25; i += 1) {
    await queues.dispatch('mail', 'send-invoice', {
      label: pick(NAMES),
      tags: ['billing', `customer:${40 + (i % 5)}`],
    });
  }

  // Failures, for the retry and delete actions.
  for (let i = 0; i < 6; i += 1) {
    await queues.dispatch('mail', 'send-receipt', {
      boom: true,
      label: pick(NAMES),
      tags: ['billing'],
    });
  }

  await queues.dispatch('reports', 'monthly-summary', {
    boom: true,
    tags: ['reporting'],
  });
  await queues.dispatch('webhooks', 'notify-partner', { boom: true });

  // Silenced: it runs constantly and nobody wants to read about it.
  for (let i = 0; i < 8; i += 1) {
    await queues.dispatch('webhooks', 'heartbeat', {});
  }

  // Delayed rows for the pending listing.
  for (let i = 1; i <= 4; i += 1) {
    await queues.dispatch(
      'reports',
      'nightly-export',
      { tags: ['reporting'] },
      { delay: i * 15 * 60 * 1000 },
    );
  }

  // One batch that finishes clean, one that keeps a failure to retry.
  await batches.dispatch({
    name: 'Weekly digest',
    jobs: Array.from({ length: 8 }, (_, i) => ({
      queue: 'mail',
      name: 'digest',
      data: { label: NAMES[i % NAMES.length] },
    })),
    then: { queue: 'webhooks', name: 'digest-done' },
    finally: { queue: 'webhooks', name: 'digest-finished' },
  });

  await batches.dispatch({
    name: 'Invoice run — March',
    allowFailures: true,
    jobs: [
      ...Array.from({ length: 5 }, () => ({
        queue: 'mail' as const,
        name: 'invoice',
        data: { label: pick(NAMES) },
      })),
      { queue: 'mail', name: 'invoice', data: { boom: true, label: 'zoe' } },
      { queue: 'mail', name: 'invoice', data: { boom: true, label: 'yuri' } },
    ],
    catch: { queue: 'webhooks', name: 'invoice-alert' },
  });

  // A long one, always mid-flight, for the cancel button.
  await batches.dispatch({
    name: 'Backfill 2025 — long running',
    jobs: Array.from({ length: 60 }, (_, i) => ({
      queue: 'reports',
      name: 'backfill',
      data: { slowMs: 4000, label: `chunk-${i}` },
    })),
  });

  console.log(`\n  Sentinel demo on http://127.0.0.1:${PORT}/sentinel\n`);

  // A trickle keeps the dashboard alive during a browse. The catch is load-bearing: a
  // Redis blip must not take the demo down with an unhandled rejection.
  const trickle = (queue: string, name: string, data: Record<string, unknown>) =>
    queues.dispatch(queue, name, data).catch(() => undefined);

  setInterval(() => {
    void trickle('webhooks', 'notify-partner', { tags: ['integrations'] });
    void trickle('mail', 'send-invoice', { label: pick(NAMES), tags: ['billing'] });

    if (Math.random() < 0.25) {
      void trickle('mail', 'send-receipt', { boom: true, tags: ['billing'] });
    }
  }, 3000);
}

main().catch((error: Error) => {
  console.error(`\n  Demo failed to start: ${error.message}\n`);
  process.exit(1);
});
