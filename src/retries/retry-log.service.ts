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

/** One press of the Retry button, and how it turned out. */
export interface ManualRetry {
  /** When the button was pressed, ISO 8601. */
  at: string;

  /** What the run it started did, or null while it is still going. */
  outcome: 'completed' | 'failed' | null;
}

/**
 * The record of who pressed Retry, and what came of it.
 *
 * BullMQ re-runs the same job; nothing on the job separates a manual retry from an
 * automatic one. Without the outcome, a job retried twice says when the button was
 * pressed and nothing about which press failed.
 */
@Injectable()
export class RetryLogService {
  private readonly prefix: string;
  private readonly ttl: number;

  constructor(
    @Inject(SENTINEL_OPTIONS) options: SentinelOptions,
    @Inject(SENTINEL_REDIS) private readonly redis: Redis,
  ) {
    this.prefix = resolvePrefix(options);

    // The log outlives the job it describes. Without a TTL it leaves one key per retried
    // job behind forever.
    const minutes = options.metrics?.trimFailedMinutes ?? DEFAULT_TRIM_FAILED_MINUTES;

    this.ttl = Math.max(60, minutes * 60);
  }

  /** Notes a press of the button, outcome still open. Returns the number of presses. */
  async record(queue: string, jobId: string, at = new Date()): Promise<number> {
    const key = this.key(queue, jobId);
    const entry: ManualRetry = { at: at.toISOString(), outcome: null };
    const count = await this.redis.rpush(key, JSON.stringify(entry));

    await this.redis.expire(key, this.ttl);

    return count;
  }

  /**
   * Closes the open entry, if there is one, with what the job just did.
   *
   * Retries of one job are sequential: the next time it settles belongs to the last press.
   * An entry that already has an outcome is left alone.
   */
  async settle(
    queue: string,
    jobId: string,
    outcome: 'completed' | 'failed',
  ): Promise<void> {
    const key = this.key(queue, jobId);
    const last = await this.redis.lindex(key, -1);

    if (!last) {
      return;
    }

    const entry = this.parse(last);

    if (!entry || entry.outcome !== null) {
      return;
    }

    await this.redis.lset(key, -1, JSON.stringify({ ...entry, outcome }));
  }

  /** Every press for a job, oldest first. */
  async of(queue: string, jobId: string): Promise<ManualRetry[]> {
    const raw = await this.redis.lrange(this.key(queue, jobId), 0, -1);

    return raw
      .map((entry) => this.parse(entry))
      .filter((entry): entry is ManualRetry => entry !== null);
  }

  /** Drops every log for a queue, or for all of them. */
  async clear(queue?: string): Promise<void> {
    await deleteMatching(this.redis, `${this.prefix}:retries:${queue ?? '*'}:*`);
  }

  /** Drops the log for a job that was removed. */
  async forget(queue: string, jobId: string): Promise<void> {
    await this.redis.del(this.key(queue, jobId));
  }

  private key(queue: string, jobId: string): string {
    return `${this.prefix}:retries:${queue}:${jobId}`;
  }

  private parse(raw: string): ManualRetry | null {
    try {
      const entry = JSON.parse(raw) as ManualRetry;

      return typeof entry.at === 'string' ? entry : null;
    } catch {
      return null;
    }
  }
}
