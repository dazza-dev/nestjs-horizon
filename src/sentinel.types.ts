import type { IncomingMessage, ServerResponse } from 'http';
import type { FactoryProvider, ModuleMetadata } from '@nestjs/common';
import type { JobsOptions, RedisOptions } from 'bullmq';

/** One node of a Redis Cluster. Any node will do; the rest are discovered. */
export interface ClusterNode {
  host: string;
  port: number;
}

/**
 * Redis connection: a URL, the individual fields, or a cluster.
 *
 * With `cluster` set the key prefix is hash-tagged and every key this package writes
 * lands in one slot. Without that, commands touching two keys fail with CROSSSLOT.
 */
export type SentinelConnection = RedisOptions & {
  url?: string;
  cluster?: ClusterNode[];
};

/** A named group of queues processed together, with the concurrency it declares. */
export interface SupervisorOptions {
  queues: string[];

  /** Jobs each of this supervisor's queues runs at the same time, per worker process.
   * Defaults to 1. */
  concurrency?: number;

  /** Job options applied to every queue in this supervisor. */
  defaultJobOptions?: JobsOptions;

  /** Seconds a job may run before it is failed. Overrides the global timeout. */
  timeoutSeconds?: number;

  /** Releases a job may ask for before it is failed. Overrides the global limit. */
  maxReleases?: number;

  /** Name of a connection from `connections`. Defaults to the main one. */
  connection?: string;
}

/** Decides whether a request may open the dashboard. Return `false` to deny. */
export type SentinelAuthCallback = (
  request: IncomingMessage,
) => boolean | Promise<boolean>;

/** Anything Express accepts as middleware. Runs before the dashboard. */
export type SentinelMiddleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: (error?: unknown) => void,
) => void;

export interface BoardOptions {
  /** Defaults to `true`. Set to `false` to keep the dashboard out of the app entirely. */
  enabled?: boolean;

  /** Where the dashboard is mounted. Defaults to `/sentinel`. */
  path?: string;

  /**
   * Public prefix when a reverse proxy serves the dashboard under a different path than
   * the application mounts it on. The page and its API calls are built from this.
   */
  proxyPath?: string;

  /** Only serve the dashboard on this host; every other host gets a 404. */
  domain?: string;

  /**
   * Gate for the dashboard. Without one the dashboard is served only outside production,
   * where publishing every job payload would be a leak.
   */
  auth?: SentinelAuthCallback;

  /** Middleware run before the auth gate and the dashboard. */
  middleware?: SentinelMiddleware[];

  /** Title shown in the dashboard. */
  title?: string;

  /**
   * Returns the CSP nonce for this request. The page has no inline script and runs under
   * a plain `script-src 'self'`; this is for policies that demand a nonce on every tag.
   */
  cspNonce?: (request: IncomingMessage) => string | undefined;
}

export interface MetricsOptions {
  /** How long recent-job records are kept, in minutes. Defaults to 60. */
  trimRecentMinutes?: number;

  /** How long failed-job records are kept, in minutes. Defaults to 7 days. */
  trimFailedMinutes?: number;

  /**
   * Window the failure counter reads over, in minutes. Defaults to `trimFailedMinutes`.
   * Set it below retention to count "failures in the last hour" while keeping a week.
   */
  trimRecentFailedMinutes?: number;

  /**
   * How long the copies kept for a monitored tag live, in minutes. Defaults to 7 days.
   * The tag itself is permanent; its per-job copies are not.
   */
  trimMonitoredMinutes?: number;

  /** Seconds between snapshots. Defaults to 300. */
  snapshotIntervalSeconds?: number;

  /** Snapshots kept, as one number or per series. Defaults to 24. */
  trimSnapshots?: number | { job?: number; queue?: number };
}

/**
 * How long finished jobs stay in the queues, in minutes.
 *
 * BullMQ's `removeOnComplete` / `removeOnFail` bound them by count, this by age. Both
 * can be used together.
 */
export interface TrimOptions {
  completed?: number;
  failed?: number;

  /** Delayed jobs that were scheduled and never became due. Off by default. */
  delayed?: number;
}

/** Limits that make a worker process retire itself. */
export interface WorkerLimits {
  /** Retire after this many jobs. */
  maxJobs?: number;

  /** Retire after this many seconds. */
  maxLifetimeSeconds?: number;

  /** Retire once heap usage passes this many megabytes. */
  memoryLimitMb?: number;
}

/** Fired when a queue's forecast wait passes its threshold, or cannot be made at all. */
export type LongWaitHandler = (event: {
  queue: string;

  /** Null when the queue has a backlog and nothing consuming it: an unbounded wait. */
  seconds: number | null;
  threshold: number;
}) => void | Promise<void>;

export interface SentinelOptions {
  connection: SentinelConnection;

  /** Extra named connections a supervisor can point at. */
  connections?: Record<string, SentinelConnection>;

  /** Name of this instance, shown in the dashboard. */
  name?: string;

  /**
   * Key prefix for every Redis key. Defaults to `sentinel`. On a cluster it is wrapped
   * in braces unless it already carries a hash tag.
   */
  prefix?: string;

  supervisors: Record<string, SupervisorOptions>;

  /** Which key of `environments` applies. Defaults to `NODE_ENV`. */
  env?: string;

  /**
   * Overrides merged on top of `supervisors`, keyed by `env` and falling back to
   * `NODE_ENV`.
   */
  environments?: Record<string, Record<string, Partial<SupervisorOptions>>>;

  /** Job options applied to every queue, unless a supervisor overrides them. */
  defaultJobOptions?: JobsOptions;

  /** Seconds a job may run before it is failed. Off by default. */
  timeoutSeconds?: number;

  /**
   * How many times a handler may call `release()` on one job before it is failed.
   * Defaults to 25. Its own budget, not shared with `attempts`.
   */
  maxReleases?: number;

  /**
   * Job names kept out of the completed listing. They still run, and a silenced job
   * that fails still shows up in the failed listing.
   */
  silenced?: string[];

  /** Same, by tag: a job carrying any of these is silenced. */
  silencedTags?: string[];

  /**
   * Seconds a queue may take to drain before `onLongWait` fires, keyed by queue name with
   * `default` as the fallback. A forecast of time to drain, not the age of a job.
   */
  waits?: Record<string, number>;

  onLongWait?: LongWaitHandler;

  board?: BoardOptions;

  metrics?: MetricsOptions;

  /** Age-based retention for the job listings. */
  trim?: TrimOptions;

  /**
   * Whether this process consumes jobs. Keep it `false` in the API process and `true`
   * in the worker.
   */
  worker?: boolean;

  workerLimits?: WorkerLimits;

  /** How long a batch keeps its state in Redis. Defaults to 7 days. */
  batchTtlSeconds?: number;
}

export interface SentinelAsyncOptions {
  imports?: ModuleMetadata['imports'];
  inject?: FactoryProvider['inject'];
  // The injected dependencies are whatever `inject` names, which Nest cannot type here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useFactory: (...args: any[]) => SentinelOptions | Promise<SentinelOptions>;
}
