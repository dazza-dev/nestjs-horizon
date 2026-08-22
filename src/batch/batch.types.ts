/** One job in a batch: which queue it enters and what it carries. */
export interface BatchJobSpec {
  queue: string;
  name?: string;
  data?: Record<string, unknown>;
}

/** A chain runs its jobs one after another. A plain spec runs alongside the rest. */
export type BatchEntry = BatchJobSpec | BatchJobSpec[];

export interface BatchOptions {
  name: string;

  /**
   * Nest an array to chain those jobs: each link waits for the one before it. Useful
   * when the steps would collide, like chunks of the same export.
   */
  jobs: BatchEntry[];

  /** Runs when every job finished and none failed. */
  then?: BatchJobSpec;

  /** Runs on the first failure, whether or not the batch tolerates failures. */
  catch?: BatchJobSpec;

  /** Always runs once the batch is done. */
  finally?: BatchJobSpec;

  /** When `true`, a failure does not cancel the jobs still pending. */
  allowFailures?: boolean;
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
  cancelled: boolean;

  cancelledAt: string | null;
  finished: boolean;
  allowFailures: boolean;
  createdAt: string;
  finishedAt: string | null;

  /** Completion percentage, 0 to 100. */
  progress: number;
}

/** Data every job in a batch carries. */
export interface BatchedJobData {
  batchId?: string;

  /** Marks the `then`/`catch`/`finally` jobs, which do not count towards the batch. */
  batchCallback?: boolean;

  /** Jobs still to run in this chain, enqueued one at a time as each finishes. */
  chain?: BatchJobSpec[];
  [key: string]: unknown;
}

export interface BatchPage {
  batches: Batch[];
  total: number;
}

/** Enough to find the job again in its queue. */
export interface FailedJobRef {
  queue: string;
  jobId: string;
  name: string;
  failedAt: string;
}
