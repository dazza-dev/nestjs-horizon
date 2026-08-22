import { Inject, Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { Redis } from 'ioredis';
import {
  DEFAULT_TRIM_RECENT_MINUTES,
  SENTINEL_OPTIONS,
  SENTINEL_REDIS,
} from '../sentinel.constants';
import type { SentinelOptions } from '../sentinel.types';
import { resolvePrefix } from '../sentinel.options';
import { TagsService } from '../tags/tags.service';
import { deleteMatching, scanKeys } from '../redis/scan';

/** A job kept out of the completed listing. */
export interface SilencedRef {
  queue: string;
  jobId: string;
}

/** Most a single read of the index will pull back. */
const MAX_SCAN = 1000;

/**
 * The index of jobs that finished quietly, one key per queue.
 *
 * An index rather than a filter at read time: the listing does not depend on how much
 * ordinary traffic sits on top of it, and the decision is frozen at the moment it ran.
 */
@Injectable()
export class SilencedService {
  private readonly prefix: string;
  private readonly names: Set<string>;
  private readonly tags: Set<string>;
  private readonly ttl: number;

  constructor(
    @Inject(SENTINEL_OPTIONS) options: SentinelOptions,
    @Inject(SENTINEL_REDIS) private readonly redis: Redis,
  ) {
    this.prefix = resolvePrefix(options);
    this.names = new Set(options.silenced ?? []);
    this.tags = new Set(options.silencedTags ?? []);

    // The index points at completed jobs; it is worth as long as they are kept.
    const minutes = options.metrics?.trimRecentMinutes ?? DEFAULT_TRIM_RECENT_MINUTES;

    this.ttl = Math.max(60, minutes * 60);
  }

  /** Whether anything is configured to be silenced. */
  get configured(): boolean {
    return this.names.size > 0 || this.tags.size > 0;
  }

  /** By name, by tag, or by the job declaring itself with `silenced: true`. */
  decide(job: Pick<Job, 'name' | 'data'>): boolean {
    if (this.names.has(job.name)) {
      return true;
    }

    if (TagsService.of(job).some((tag) => this.tags.has(tag))) {
      return true;
    }

    return (job.data as { silenced?: unknown } | undefined)?.silenced === true;
  }

  /** Records a job that finished quietly. */
  async record(queue: string, jobId: string, at = Date.now()): Promise<void> {
    const key = this.key(queue);

    await this.redis.zadd(key, at, jobId);

    // A safety net for a queue that goes quiet, not the retention. `trim` ages entries out
    // one by one; expiring the key drops a whole queue's index at once.
    await this.redis.expire(key, this.ttl * 2);
  }

  /** Drops entries older than the retention. */
  async trim(now = Date.now()): Promise<void> {
    const keys = await this.keys();

    await Promise.all(
      keys.map((key) => this.redis.zremrangebyscore(key, 0, now - this.ttl * 1000)),
    );
  }

  /**
   * One page of silenced jobs, newest first.
   *
   * Counts run over the retention window, not the whole key: a stale entry stops counting
   * before a trim comes round to remove it.
   */
  async page(
    page: number,
    perPage: number,
    queue?: string,
  ): Promise<{ refs: SilencedRef[]; total: number; reachable?: number }> {
    // One queue reads its own index at its own offset: exact count, no ceiling.
    if (queue) {
      const key = this.key(queue);
      const from = page * perPage;
      const [ids, total] = await Promise.all([
        perPage > 0
          ? this.redis.zrevrangebyscore(key, '+inf', this.floor, 'LIMIT', from, perPage)
          : Promise.resolve([] as string[]),
        this.redis.zcount(key, this.floor, '+inf'),
      ]);

      return { refs: ids.map((jobId) => ({ queue, jobId })), total };
    }

    const keys = await this.keys();

    // A sum of per-queue counts, not a count of what one read happened to reach. Exact
    // even across queues.
    const totals = await Promise.all(
      keys.map((key) => this.redis.zcount(key, this.floor, '+inf')),
    );
    const total = totals.reduce((sum, count) => sum + count, 0);

    if (perPage <= 0) {
      return { refs: [], total };
    }

    // Merging across queues needs a window. `reachable` reports how far it got.
    const perQueue = await Promise.all(
      keys.map(async (key) => {
        const upTo = Math.min((page + 1) * perPage, MAX_SCAN);
        const scored = await this.redis.zrevrangebyscore(
          key,
          '+inf',
          this.floor,
          'WITHSCORES',
          'LIMIT',
          0,
          upTo,
        );

        return this.pairs(key, scored);
      }),
    );

    const merged = perQueue.flat().sort((a, b) => b.at - a.at);

    return {
      refs: merged
        .slice(page * perPage, (page + 1) * perPage)
        .map(({ queue: name, jobId }) => ({ queue: name, jobId })),
      total,
      reachable: Math.min(total, merged.length),
    };
  }

  /** The entries of the index, for excluding them from the completed listing. */
  async members(): Promise<Set<string>> {
    const keys = await this.keys();
    const perQueue = await Promise.all(
      keys.map(async (key) => {
        // The same floor page() and count() read at, or the completed total subtracts
        // rows this set still hides.
        const ids = await this.redis.zrevrangebyscore(
          key,
          '+inf',
          this.floor,
          'LIMIT',
          0,
          MAX_SCAN,
        );

        return ids.map((jobId) => `${this.queueOf(key)}:${jobId}`);
      }),
    );

    return new Set(perQueue.flat());
  }

  /** How many of a queue's completions are being kept out of the completed listing. */
  async count(queue?: string): Promise<number> {
    return (await this.page(0, 0, queue)).total;
  }

  /** Drops one entry, for a job that was removed or that succeeded on a retry. */
  async forget(queue: string, jobId: string): Promise<void> {
    await this.redis.zrem(this.key(queue), jobId);
  }

  /** Drops many at once, for a sweep that removed a batch of jobs. */
  async forgetMany(queue: string, jobIds: string[]): Promise<void> {
    if (jobIds.length) {
      await this.redis.zrem(this.key(queue), ...jobIds);
    }
  }

  /** Drops the index for a queue, or for every queue. */
  async clear(queue?: string): Promise<void> {
    if (queue) {
      await this.redis.del(this.key(queue));

      return;
    }

    await deleteMatching(this.redis, `${this.prefix}:silenced:*`);
  }

  /** Reads a WITHSCORES reply into refs the merge can sort by finish time. */
  private pairs(
    key: string,
    scored: string[],
  ): { queue: string; jobId: string; at: number }[] {
    const queue = this.queueOf(key);
    const out: { queue: string; jobId: string; at: number }[] = [];

    for (let i = 0; i < scored.length; i += 2) {
      out.push({ queue, jobId: scored[i], at: Number(scored[i + 1]) });
    }

    return out;
  }

  private queueOf(key: string): string {
    return key.slice(`${this.prefix}:silenced:`.length);
  }

  private key(queue: string): string {
    return `${this.prefix}:silenced:${queue}`;
  }

  /** Every queue's index. One key per queue makes a filtered read exact and unbounded. */
  private async keys(): Promise<string[]> {
    return scanKeys(this.redis, `${this.prefix}:silenced:*`);
  }

  /** The oldest score still inside the retention window. */
  private get floor(): number {
    return Date.now() - this.ttl * 1000;
  }
}
