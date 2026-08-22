import { DynamicModule, Global, Module, OnModuleDestroy, Provider } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { SENTINEL_OPTIONS } from './sentinel.constants';
import type { SentinelAsyncOptions, SentinelOptions } from './sentinel.types';
import { redisProvider } from './redis/redis.provider';
import { ClientRegistry } from './redis/client';
import { FailureContextService } from './failures/failure-context.service';
import { RetryLogService } from './retries/retry-log.service';
import { SilencedService } from './silenced/silenced.service';
import { LockService } from './redis/lock.service';
import { resolveOptions } from './sentinel.options';
import { QueueRegistry } from './queues/queue.registry';
import { TagsService } from './tags/tags.service';
import { SentinelEvents } from './events/sentinel.events';
import { LongWaitService } from './events/long-wait.service';
import { BatchService } from './batch/batch.service';
import { BoardSetup } from './board/board.setup';
import { WorkerManager } from './worker/worker.manager';
import { WorkerRegistry } from './worker/worker-registry.service';
import { WorkerLimitsService } from './worker/worker-limits.service';
import { MetricsService } from './metrics/metrics.service';
import { SnapshotService } from './metrics/snapshot.service';
import { StatsService } from './stats/stats.service';
import { MaintenanceService } from './maintenance/maintenance.service';
import { JobsService } from './api/jobs.service';
import { ApiRouter } from './api/api.router';

const providers: Provider[] = [
  ClientRegistry,
  FailureContextService,
  RetryLogService,
  SilencedService,
  redisProvider,
  LockService,
  SentinelEvents,
  QueueRegistry,
  TagsService,
  BatchService,
  BoardSetup,
  WorkerManager,
  WorkerRegistry,
  WorkerLimitsService,
  MetricsService,
  SnapshotService,
  StatsService,
  MaintenanceService,
  LongWaitService,
  JobsService,
  ApiRouter,
];

// Mirrors the classes `src/index.ts` exports; the two lists move together.
const exported: Provider[] = [
  SentinelEvents,
  QueueRegistry,
  TagsService,
  BatchService,
  BoardSetup,
  MetricsService,
  WorkerRegistry,
  StatsService,
  MaintenanceService,
  JobsService,
  LockService,
  SilencedService,
  RetryLogService,
  FailureContextService,
];

/** Queues, batches and the dashboard, all driven by one config object. */
@Global()
@Module({})
export class SentinelModule implements OnModuleDestroy {
  constructor(private readonly clients: ClientRegistry) {}

  /**
   * Closes every tracked client. On a cluster each queue and worker holds one of its
   * own, and any left open keeps the process alive after shutdown.
   */
  async onModuleDestroy(): Promise<void> {
    await this.clients.closeAll();
  }

  static forRoot(options: SentinelOptions): DynamicModule {
    return {
      module: SentinelModule,
      imports: [DiscoveryModule],
      providers: [
        { provide: SENTINEL_OPTIONS, useValue: resolveOptions(options) },
        ...providers,
      ],
      exports: exported,
    };
  }

  static forRootAsync(options: SentinelAsyncOptions): DynamicModule {
    return {
      module: SentinelModule,
      imports: [DiscoveryModule, ...(options.imports ?? [])],
      providers: [
        {
          provide: SENTINEL_OPTIONS,
          useFactory: async (...args: unknown[]) =>
            resolveOptions(await options.useFactory(...args)),
          inject: options.inject ?? [],
        },
        ...providers,
      ],
      exports: exported,
    };
  }
}
