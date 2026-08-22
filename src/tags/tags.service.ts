import { Inject, Injectable } from '@nestjs/common';
import type { Job } from 'bullmq';
import { Redis } from 'ioredis';
import {
  SENTINEL_OPTIONS,
  SENTINEL_REDIS,
  DEFAULT_TRIM_FAILED_MINUTES,
  DEFAULT_TRIM_MONITORED_MINUTES,
} from '../sentinel.constants';
import type { SentinelOptions } from '../sentinel.types';
import { resolvePrefix } from '../sentinel.options';
import { execPipeline } from '../redis/client';
import { deleteMatching, scanKeys } from '../redis/scan';

/** Jobs kept per tag. Older ones fall off the end. */
const TAG_HISTORY = 1000;

export interface MonitoredTag {
  tag: string;
  count: number;

  /** Failures carrying the tag, counted separately from jobs. */
  failed: number;
}

export interface TaggedJobRef {
  queue: string;
  jobId: string;

  /**
   * What the job looked like when it was indexed.
   *
   * Once BullMQ trims the job a bare pointer resolves to nothing, and the tag then counts
   * more rows than it can show.
   */
  snapshot?: {
    name: string;
    state: string;
    tags: string[];
    createdAt: number | null;
    finishedAt: number | null;
    runtime: number | null;
  };
}

/** Which of a tag's two indexes to read. */
export type TagIndex = 'jobs' | 'failed';

/**
 * Explicit job tags, the tags being monitored, and the tags of every failure.
 *
 * Tags travel in the payload as `tags: string[]`. Two indexes: monitored tags collect jobs
 * only while someone is watching; failures are indexed under all of their tags with a TTL,
 * which lets the failed listing be searched by tag beyond the current page.
 */
@Injectable()
export class TagsService {
  private readonly prefix: string;
  private readonly failedTtl: number;
  private readonly monitoredTtl: number;

  constructor(
    @Inject(SENTINEL_OPTIONS) options: SentinelOptions,
    @Inject(SENTINEL_REDIS) private readonly redis: Redis,
  ) {
    this.prefix = resolvePrefix(options);
    // At least a minute: `EXPIRE key 0` deletes the key outright and `SET … EX 0` errors.
    const minutes = options.metrics?.trimFailedMinutes ?? DEFAULT_TRIM_FAILED_MINUTES;

    this.failedTtl = Math.max(60, minutes * 60);

    const monitored =
      options.metrics?.trimMonitoredMinutes ?? DEFAULT_TRIM_MONITORED_MINUTES;

    this.monitoredTtl = Math.max(60, monitored * 60);
  }

  /** Tags declared in a job payload. */
  static of(job: Pick<Job, 'data'>): string[] {
    const tags = (job.data as { tags?: unknown } | undefined)?.tags;

    if (!Array.isArray(tags)) {
      return [];
    }

    return tags.filter((tag): tag is string => typeof tag === 'string');
  }

  async monitored(): Promise<string[]> {
    return (await this.redis.smembers(this.monitoredKey())).sort();
  }

  /** Monitored tags with their job and failure counts. */
  async monitoredWithCounts(): Promise<MonitoredTag[]> {
    const tags = await this.monitored();

    return Promise.all(
      tags.map(async (tag) => {
        const [count, failed] = await Promise.all([
          this.redis.llen(this.tagKey(tag, 'jobs')),
          this.redis.llen(this.tagKey(tag, 'failed')),
        ]);

        return { tag, count, failed };
      }),
    );
  }

  async monitor(tag: string): Promise<void> {
    await this.redis.sadd(this.monitoredKey(), tag);
  }

  /**
   * Stops watching a tag and drops the jobs collected under it. The failure index is left
   * alone; it is tied to nobody watching and expires on its own.
   */
  async stopMonitoring(tag: string): Promise<void> {
    const key = this.tagKey(tag, 'jobs');
    const entries = await this.redis.lrange(key, 0, -1);

    await this.redis.srem(this.monitoredKey(), tag);
    await this.redis.del(key);

    if (!entries.length) {
      return;
    }

    // Snapshots are keyed by job, not by tag. A job another monitored tag still carries
    // keeps its copy, or that tag's listing goes blank.
    const held = new Set<string>();

    for (const other of await this.monitored()) {
      const rows = await this.redis.lrange(this.tagKey(other, 'jobs'), 0, -1);

      for (const row of rows) {
        const ref = this.parse(row);

        held.add(`${ref.queue}:${ref.jobId}`);
      }
    }

    const orphaned = entries
      .map((entry) => this.parse(entry))
      .filter((ref) => !held.has(`${ref.queue}:${ref.jobId}`));

    if (orphaned.length) {
      await execPipeline(
        orphaned.reduce(
          (pipeline, ref) => pipeline.del(this.snapshotKey(ref.queue, ref.jobId, 'jobs')),
          this.redis.pipeline(),
        ),
      );
    }
  }

  /** Records a job under each of its tags that is being monitored. */
  async index(
    queue: string,
    jobId: string,
    tags: string[],
    snapshot?: TaggedJobRef['snapshot'],
  ): Promise<void> {
    if (!tags.length) {
      return;
    }

    const monitored = new Set(await this.redis.smembers(this.monitoredKey()));
    const watched = tags.filter((tag) => monitored.has(tag));

    await this.push('jobs', queue, jobId, watched, snapshot);
  }

  /**
   * Records a failed job under all of its tags, monitored or not. Entries expire with the
   * failed-job retention.
   */
  async indexFailure(
    queue: string,
    jobId: string,
    tags: string[],
    snapshot?: TaggedJobRef['snapshot'],
  ): Promise<void> {
    await this.push('failed', queue, jobId, tags, snapshot);
  }

  /** One page of the jobs collected under a tag, newest first. */
  async jobsFor(
    tag: string,
    index: TagIndex = 'jobs',
    page = 0,
    perPage = 25,
  ): Promise<{ refs: TaggedJobRef[]; total: number }> {
    const key = this.tagKey(tag, index);
    const total = await this.redis.llen(key);
    const entries = await this.redis.lrange(
      key,
      page * perPage,
      (page + 1) * perPage - 1,
    );

    const refs = await this.withSnapshots(
      entries.map((entry) => this.parse(entry)),
      index,
    );

    return { refs, total };
  }

  private async push(
    index: TagIndex,
    queue: string,
    jobId: string,
    tags: string[],
    snapshot?: TaggedJobRef['snapshot'],
  ): Promise<void> {
    if (!tags.length) {
      return;
    }

    const pipeline = this.redis.pipeline();

    for (const tag of tags) {
      const key = this.tagKey(tag, index);

      // LREM before LPUSH: a job indexed again moves to the front instead of doubling.
      pipeline.lrem(key, 0, `${queue}:${jobId}`);
      pipeline.lpush(key, `${queue}:${jobId}`);
      pipeline.ltrim(key, 0, TAG_HISTORY - 1);

      if (index === 'failed') {
        pipeline.expire(key, this.failedTtl);
      }
    }

    if (snapshot) {
      const key = this.snapshotKey(queue, jobId, index);

      // The monitored list has no TTL; without one here a busy tag leaves a key per job
      // behind with nothing to remove it.
      const ttl = index === 'failed' ? this.failedTtl : this.monitoredTtl;

      pipeline.set(key, JSON.stringify(snapshot), 'EX', ttl);
    }

    await execPipeline(pipeline);
  }

  /** Reads the stored copies for refs whose job may already be gone. */
  private async withSnapshots(
    refs: TaggedJobRef[],
    index: TagIndex,
  ): Promise<TaggedJobRef[]> {
    if (!refs.length) {
      return refs;
    }

    const stored = await this.redis.mget(
      ...refs.map((ref) => this.snapshotKey(ref.queue, ref.jobId, index)),
    );

    return refs.map((ref, i) => {
      const raw = stored[i];

      if (!raw) {
        return ref;
      }

      try {
        return { ...ref, snapshot: JSON.parse(raw) as TaggedJobRef['snapshot'] };
      } catch {
        // An unreadable copy costs one row its detail, not the screen.
        return ref;
      }
    });
  }

  /** Where a job's copy lives. One key per index: the two retention windows differ. */
  private snapshotKey(queue: string, jobId: string, index: TagIndex): string {
    const kind = index === 'failed' ? 'failed-tagged' : 'tagged';

    return `${this.prefix}:${kind}:${queue}:${jobId}`;
  }

  private parse(entry: string): TaggedJobRef {
    const separator = entry.indexOf(':');

    return { queue: entry.slice(0, separator), jobId: entry.slice(separator + 1) };
  }

  /** Drops the failure index and its copies, for a queue or for every queue. */
  async forgetFailures(queue?: string): Promise<void> {
    if (!queue) {
      await deleteMatching(this.redis, `${this.prefix}:failed-tag:*`);
      await deleteMatching(this.redis, `${this.prefix}:failed-tagged:*`);

      return;
    }

    const keys = await scanKeys(this.redis, `${this.prefix}:failed-tag:*`);
    const pipeline = this.redis.pipeline();

    for (const key of keys) {
      for (const entry of await this.redis.lrange(key, 0, -1)) {
        if (this.parse(entry).queue === queue) {
          pipeline.lrem(key, 0, entry);
        }
      }
    }

    await execPipeline(pipeline);
    await deleteMatching(this.redis, `${this.prefix}:failed-tagged:${queue}:*`);
  }

  private monitoredKey(): string {
    return `${this.prefix}:monitored`;
  }

  private tagKey(tag: string, index: TagIndex): string {
    return index === 'failed'
      ? `${this.prefix}:failed-tag:${tag}`
      : `${this.prefix}:tag:${tag}`;
  }
}
