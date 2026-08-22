import { DelayedError, type Job } from 'bullmq';
import { DEFAULT_MAX_RELEASES } from '../sentinel.constants';

/** Thrown when a job releases itself more times than it has attempts. */
export class MaxReleasesError extends Error {
  constructor(limit: number) {
    super(
      limit === 0
        ? 'Job tried to release itself, which this queue does not allow.'
        : `Job released itself ${limit} times without finishing.`,
    );
    this.name = 'MaxReleasesError';
  }
}

/** What a handler is given besides the job. */
export interface JobContext {
  /**
   * Puts the job back on the queue without failing it: no stack trace, no failure.
   *
   * For work that is not ready rather than work that is broken, like a 429 or a held
   * lock. The call never returns. Bounded by `maxReleases`, which a payload may raise.
   */
  release(seconds?: number): Promise<never>;

  /**
   * Whether this job should stop: past its timeout, or the worker is shutting down.
   *
   * Nothing in Node interrupts a running promise, so long work has to ask.
   */
  readonly aborted: boolean;

  /** The same thing as a signal, for anything that accepts one. */
  readonly signal: AbortSignal | undefined;
}

/** Built per job, because `release` needs that job's lock token. */
export function jobContext(
  job: Job,
  token: string | undefined,
  signal: AbortSignal | undefined,
  cap: number,
  onRelease?: (seconds: number) => void,
): JobContext {
  return {
    async release(seconds = 0): Promise<never> {
      if (!token) {
        throw new Error(
          'release() needs the job lock, which is only held while a worker is processing it.',
        );
      }

      // `attemptsStarted` counts every pop, `attemptsMade` only failures: the difference
      // is how often this job released itself. A NaN cap would silently lift the brake.
      const limit =
        Number.isFinite(cap) && cap >= 0 ? Math.floor(cap) : DEFAULT_MAX_RELEASES;

      if (job.attemptsStarted - job.attemptsMade - 1 >= limit) {
        throw new MaxReleasesError(limit);
      }

      // A NaN delay becomes a NaN timestamp and the job never comes back.
      const delay = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;

      await job.moveToDelayed(Date.now() + delay * 1000, token);

      onRelease?.(delay);

      // BullMQ reads this as "moved on purpose" and stops without failing the job.
      throw new DelayedError();
    },

    get aborted(): boolean {
      return signal?.aborted ?? false;
    },

    signal,
  };
}
