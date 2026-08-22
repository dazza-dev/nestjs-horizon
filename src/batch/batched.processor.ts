import { DelayedError, UnrecoverableError, WaitingChildrenError } from 'bullmq';
import type { Job } from 'bullmq';
import type { JobContext } from '../worker/job-context';
import { BatchService } from './batch.service';
import type { BatchedJobData } from './batch.types';
import type { JobHandler } from '../worker/processor.decorator';

/**
 * Whether BullMQ moved the job itself rather than the job failing.
 *
 * Matched by name as well as type: a duplicate bullmq install breaks `instanceof` across
 * copies.
 */
const moved = (error: unknown): boolean => {
  const name = (error as Error)?.name;

  return (
    error instanceof DelayedError ||
    error instanceof WaitingChildrenError ||
    name === 'DelayedError' ||
    name === 'WaitingChildrenError'
  );
};

/**
 * Base for processors that take part in batches: it keeps the bookkeeping out of the job.
 *
 * Extend it and write `process()` only.
 */
export abstract class BatchedProcessor<
  T extends BatchedJobData = BatchedJobData,
  R = unknown,
> implements JobHandler<T, R | { skipped: true }> {
  protected constructor(protected readonly batches: BatchService) {}

  async handle(job: Job<T>, context?: JobContext): Promise<R | { skipped: true }> {
    const batchId = job.data?.batchId;

    // Standalone job, or the batch's own callback: neither touches the counters.
    if (!batchId || job.data.batchCallback) {
      return this.process(job, context);
    }

    const chain = job.data.chain ?? [];

    if (await this.batches.cancelled(batchId)) {
      await this.batches.recordSkipped(batchId, chain.length);

      return { skipped: true };
    }

    try {
      const result = await this.process(job, context);

      // A timed-out job is failed from outside while the work carries on, so the handler
      // can still arrive here. Counting it as a success closes a batch that lost a job.
      if (context?.aborted) {
        await this.batches.recordFailure(batchId, chain.length, {
          queue: job.queueName,
          jobId: String(job.id),
          name: job.name,
          failedAt: new Date().toISOString(),
        });

        return { skipped: true };
      }

      await this.batches.recordSuccess(batchId, 1, String(job.id));

      if (chain.length) {
        await this.batches.continueChain(batchId, chain);
      }

      return result;
    } catch (error) {
      // A release is not a failure. BullMQ throws these to say the job was moved on
      // purpose, and counting one cancels the batch and skips the job on its return.
      if (moved(error)) {
        throw error;
      }

      // Only the last attempt counts. An UnrecoverableError is the last one whatever
      // `attemptsMade` says; miss it and the batch never reaches zero pending.
      const unrecoverable =
        error instanceof UnrecoverableError ||
        (error as Error)?.name === 'UnrecoverableError';

      const lastAttempt =
        unrecoverable || job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

      if (lastAttempt) {
        await this.batches.recordFailure(batchId, chain.length, {
          queue: job.queueName,
          jobId: String(job.id),
          name: job.name,
          failedAt: new Date().toISOString(),
        });
      }

      throw error;
    }
  }

  /**
   * Whether the batch this job belongs to was cancelled.
   *
   * The base class checks before starting. Call this inside a long `process()` to bail
   * out partway.
   */
  protected async cancelled(job: Job<T>): Promise<boolean> {
    return job.data?.batchId ? this.batches.cancelled(job.data.batchId) : false;
  }

  protected abstract process(job: Job<T>, context?: JobContext): Promise<R>;
}
