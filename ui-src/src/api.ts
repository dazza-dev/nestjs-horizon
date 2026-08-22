import { ref } from 'vue';

/** Where the dashboard is mounted, written into the page by the server. */
export const basePath = (): string => {
  const meta = document.querySelector('meta[name="sentinel-base"]');
  const value = meta?.getAttribute('content') ?? '';

  return value.startsWith('__') ? '/sentinel' : value;
};

/** Instance name, written into the page by the server. */
export const instanceName = (): string => {
  const meta = document.querySelector('meta[name="sentinel-name"]');
  const value = meta?.getAttribute('content') ?? '';

  return value && !value.startsWith('__') ? value : 'Sentinel';
};

/**
 * The last request that failed, or null.
 *
 * Screens poll, and a rejection has nowhere else to surface: an API that started refusing
 * looks like one with nothing new to report.
 */
export const lastError = ref<string | null>(null);

/**
 * Requests still in flight, and whether any of them failed.
 *
 * A screen fires several at once. Clearing the banner per success would let a late reply
 * wipe an earlier failure before anyone read it.
 */
let inFlight = 0;
let failedThisRound = false;

const settle = (): void => {
  inFlight -= 1;

  if (inFlight > 0) {
    return;
  }

  if (!failedThisRound) {
    lastError.value = null;
  }

  failedThisRound = false;
};

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  let response: Response;

  inFlight += 1;

  try {
    response = await fetch(`${basePath()}/api${path}`, {
      credentials: 'same-origin',
      ...init,
    });
  } catch {
    lastError.value = 'Cannot reach the Sentinel API.';
    failedThisRound = true;
    settle();

    throw new Error('network');
  }

  if (!response.ok) {
    const message = await response
      .json()
      .then((body: { message?: string }) => body.message)
      .catch(() => undefined);

    lastError.value = message ?? `${response.status} ${response.statusText}`;
    failedThisRound = true;
    settle();

    throw new Error(`${response.status} ${response.statusText}`);
  }

  settle();

  return response.json() as Promise<T>;
};

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string) => request<T>(path, { method: 'POST' }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

export interface Stats {
  jobsPerMinute: number;
  recentJobs: number;
  failedJobs: number;
  periods: { recentJobs: number; failedJobs: number };
  processes: number;
  maxWait: number | null;
  workers: number;
  paused: string[];
  status: 'running' | 'paused' | 'inactive';
  queueWithMaxRuntime: string | null;
  queueWithMaxThroughput: string | null;
}

export interface Workload {
  name: string;
  length: number;

  /** Not counted in the backlog: these run later. */
  delayed: number;
  wait: number | null;

  /** Every supervisor on this queue is paused. */
  paused: boolean;
  processes: number;
}

export interface SupervisorView {
  name: string;
  queues: string[];

  /** Queues with no registered processor. No worker ever started on them. */
  unconsumed?: string[];
  concurrency: number;
  paused: boolean;

  /** False when nothing is running this supervisor. */
  running: boolean;
}

export interface Master {
  id: string;
  hostname: string;
  pid: number;
  startedAt: string;
  supervisors: SupervisorView[];
}

export interface Measurement {
  name: string;
  throughput: number;
  runtime: number;
}

export interface SnapshotPoint {
  time: number;
  throughput: number;
  runtime: number;
}

export interface Batch {
  id: string;
  name: string;
  totalJobs: number;
  pendingJobs: number;
  processedJobs: number;
  failedJobs: number;

  /** Of the processed jobs, how many never ran because the batch was cancelled. */
  skippedJobs: number;
  allowFailures: boolean;
  cancelled: boolean;
  cancelledAt: string | null;
  finished: boolean;
  progress: number;
  createdAt: string;
  finishedAt: string | null;
}

export interface JobView {
  id: string;
  queue: string;
  name: string;
  state: string;
  attempts: number;
  data: unknown;
  tags: string[];
  failedReason?: string;
  stacktrace?: string[];
  attemptTraces: string[];
  manualRetries: ManualRetry[];

  /** Metadata the error carried. Only the detail of a single job returns it. */
  context?: Record<string, unknown> | null;
  finishedAt?: number | null;
  startedAt: number | null;
  createdAt: number | null;

  /** When a delayed job becomes due, or null when it is not scheduled. */
  scheduledFor?: number | null;
  runtime: number | null;
}

/** One press of the Retry button, and how that run ended. */
export interface ManualRetry {
  at: string;
  outcome: 'completed' | 'failed' | null;
}

export interface MonitoredTag {
  tag: string;
  count: number;
  failed: number;
}

export interface BatchPage {
  batches: Batch[];
  total: number;
}

export interface JobPage {
  jobs: JobView[];
  total: number;

  /** Rows this listing can page through, when that is fewer than `total`. */
  reachable?: number;
}

/**
 * Guards a click handler against unhandled rejections.
 *
 * The banner already reports the failure; this only stops the console noise on top.
 */
export const action =
  <A extends unknown[]>(handler: (...args: A) => Promise<unknown>) =>
  async (...args: A): Promise<void> => {
    try {
      await handler(...args);
    } catch {
      // Already reported through `lastError`.
    }
  };
