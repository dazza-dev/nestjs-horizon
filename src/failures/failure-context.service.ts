import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import {
  DEFAULT_TRIM_FAILED_MINUTES,
  SENTINEL_OPTIONS,
  SENTINEL_REDIS,
} from '../sentinel.constants';
import type { SentinelOptions } from '../sentinel.types';
import { resolvePrefix } from '../sentinel.options';
import { deleteMatching } from '../redis/scan';

/** Structured detail an error carried about why it was thrown. */
export type FailureContext = Record<string, unknown>;

/**
 * What an error said about itself, kept beside the failure.
 *
 * Read off the error rather than asked of the application: the detail travels with the
 * thing that knows it, and stays out of the message string.
 */
@Injectable()
export class FailureContextService {
  private readonly prefix: string;
  private readonly ttl: number;

  constructor(
    @Inject(SENTINEL_OPTIONS) options: SentinelOptions,
    @Inject(SENTINEL_REDIS) private readonly redis: Redis,
  ) {
    this.prefix = resolvePrefix(options);

    const minutes = options.metrics?.trimFailedMinutes ?? DEFAULT_TRIM_FAILED_MINUTES;

    this.ttl = Math.max(60, minutes * 60);
  }

  /**
   * Pulls the context off an error, if it carries one.
   *
   * A method or a property, either way. Anything that is not a plain object is ignored
   * rather than coerced: a string is indistinguishable from the message it already has.
   */
  read(error: unknown): FailureContext | null {
    if (!error || typeof error !== 'object') {
      return null;
    }

    const carrier = error as { context?: unknown };

    let value: unknown;

    try {
      value =
        typeof carrier.context === 'function'
          ? (carrier.context as () => unknown)()
          : carrier.context;
    } catch {
      // An error thrown while reporting an error must not replace it.
      return null;
    }

    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as FailureContext)
      : null;
  }

  /** Stores the context of a failure, for as long as the failure itself is kept. */
  async record(
    queue: string,
    jobId: string,
    context: FailureContext | null,
  ): Promise<void> {
    // No context means no context, not "keep the last one": the same job runs again on a
    // retry, and a stale diagnosis reads as current.
    if (!context) {
      await this.forget(queue, jobId);

      return;
    }

    let encoded: string;

    try {
      encoded = JSON.stringify(context);
    } catch {
      // A circular or unserialisable context is the author's problem. Losing the failure
      // over it would be ours.
      encoded = JSON.stringify({
        error: 'context could not be serialised',
      });
    }

    await this.redis.set(this.key(queue, jobId), encoded, 'EX', this.ttl);
  }

  /** The context of a failure, or null when it carried none. */
  async of(queue: string, jobId: string): Promise<FailureContext | null> {
    const raw = await this.redis.get(this.key(queue, jobId));

    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw) as FailureContext;
    } catch {
      return null;
    }
  }

  /** Drops the context of a job that was removed. */
  async forget(queue: string, jobId: string): Promise<void> {
    await this.redis.del(this.key(queue, jobId));
  }

  /** Drops every stored context for a queue, or for all of them. */
  async clear(queue?: string): Promise<void> {
    await deleteMatching(this.redis, `${this.prefix}:context:${queue ?? '*'}:*`);
  }

  private key(queue: string, jobId: string): string {
    return `${this.prefix}:context:${queue}:${jobId}`;
  }
}
