export { SentinelModule } from './sentinel.module';
export { SENTINEL_OPTIONS } from './sentinel.constants';

export { QueueRegistry } from './queues/queue.registry';
export { BatchService } from './batch/batch.service';
export { BatchedProcessor } from './batch/batched.processor';
export { SentinelProcessor } from './worker/processor.decorator';
export { BoardSetup } from './board/board.setup';
export { MetricsService } from './metrics/metrics.service';
export { StatsService } from './stats/stats.service';
export { JobsService } from './api/jobs.service';
export { TagsService } from './tags/tags.service';
export { MaintenanceService } from './maintenance/maintenance.service';
export { SentinelEvents } from './events/sentinel.events';
export { LockService } from './redis/lock.service';
export { WorkerRegistry } from './worker/worker-registry.service';
export { JobTimeoutError } from './worker/job-timeout';
export { setupSentinelBoard } from './board/setup-board';
export { basicAuth, BASIC_AUTH, isBasicAuth } from './board/basic-auth';
export { normalizeConnection, resolvePrefix } from './sentinel.options';

export type {
  SentinelOptions,
  SentinelAsyncOptions,
  SentinelConnection,
  SentinelAuthCallback,
  SupervisorOptions,
  BoardOptions,
} from './sentinel.types';
export type {
  Batch,
  BatchOptions,
  BatchJobSpec,
  BatchedJobData,
  BatchEntry,
  BatchPage,
  FailedJobRef,
} from './batch/batch.types';
export type { JobHandler } from './worker/processor.decorator';
export type { Measurement, Snapshot } from './metrics/metrics.service';
export type {
  DashboardStats,
  QueueWorkload,
  Master,
  SupervisorView,
} from './stats/stats.service';
export type { JobView, JobPage, Listing } from './api/jobs.service';
export type { WorkerRecord } from './worker/worker-registry.service';
export type { MonitoredTag, TaggedJobRef, TagIndex } from './tags/tags.service';
export type { WaitProvider } from './metrics/metrics.service';
export type { TrimOptions } from './sentinel.types';
export type { SentinelStatus } from './maintenance/maintenance.service';
export type {
  SentinelEventMap,
  SentinelEventName,
  JobPushedEvent,
  JobStartedEvent,
  JobCompletedEvent,
  JobFailedEvent,
  LongWaitEvent,
  SupervisorEvent,
  WorkerRetiringEvent,
  BatchEvent,
} from './events/sentinel.events';
export type {
  MetricsOptions,
  WorkerLimits,
  SentinelMiddleware,
  LongWaitHandler,
} from './sentinel.types';
export type { BasicAuthOptions } from './board/basic-auth';
export { MaxReleasesError } from './worker/job-context';
export { RetryLogService } from './retries/retry-log.service';
export { SilencedService } from './silenced/silenced.service';
export { FailureContextService } from './failures/failure-context.service';

export type { JobContext } from './worker/job-context';
export type { ManualRetry } from './retries/retry-log.service';
export type { SilencedRef } from './silenced/silenced.service';
export type { FailureContext } from './failures/failure-context.service';
