import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import {
  SENTINEL_OPTIONS,
  SENTINEL_REDIS,
  DEFAULT_TRIM_RECENT_MINUTES,
  DEFAULT_TRIM_FAILED_MINUTES,
  MAX_SNAPSHOTS,
} from '../sentinel.constants';
import type { SentinelOptions } from '../sentinel.types';
import { deleteMatching } from '../redis/scan';
import { resolvePrefix } from '../sentinel.options';
import { execPipeline } from '../redis/client';

export interface Measurement {
  /** Jobs recorded since the last snapshot. */
  throughput: number;

  /** Average runtime in milliseconds. */
  runtime: number;

  /**
   * When this was taken, or null for the live counter.
   *
   * An idle queue falls back to its last snapshot that saw work, which can be hours old.
   */
  asOf?: number | null;
}

export interface Snapshot extends Measurement {
  time: number;

  /** Seconds the queue needed to drain when the snapshot was taken. Queues only. */
  wait?: number;
}

/** Supplies each queue's wait when a snapshot is taken. */
export type WaitProvider = (queue: string) => Promise<number>;

/** Records what the queues did, since BullMQ keeps the queue but not its past. */
@Injectable()
export class MetricsService {
  private readonly prefix: string;
  private readonly maxSnapshots: number;
  private readonly recentMinutes: number;
  private readonly failedMinutes: number;
  private readonly recentFailedMinutes: number;
  private readonly jobSnapshots: number;
  private readonly queueSnapshots: number;

  constructor(
    @Inject(SENTINEL_OPTIONS) private readonly options: SentinelOptions,
    @Inject(SENTINEL_REDIS) private readonly redis: Redis,
  ) {
    this.prefix = `${resolvePrefix(options)}:metrics`;
    const snapshots = options.metrics?.trimSnapshots ?? MAX_SNAPSHOTS;

    // Clamped to at least one. LTRIM with a zero length keeps everything in Redis: the
    // obvious way to ask for no history would produce infinite history.
    const keep = (value: number | undefined): number =>
      Number.isFinite(value) && (value as number) > 0
        ? Math.floor(value as number)
        : MAX_SNAPSHOTS;

    this.jobSnapshots = keep(typeof snapshots === 'number' ? snapshots : snapshots.job);
    this.queueSnapshots = keep(
      typeof snapshots === 'number' ? snapshots : snapshots.queue,
    );
    this.maxSnapshots = Math.max(this.jobSnapshots, this.queueSnapshots);
    this.recentMinutes =
      options.metrics?.trimRecentMinutes ?? DEFAULT_TRIM_RECENT_MINUTES;
    this.failedMinutes =
      options.metrics?.trimFailedMinutes ?? DEFAULT_TRIM_FAILED_MINUTES;
    this.recentFailedMinutes =
      options.metrics?.trimRecentFailedMinutes ?? this.failedMinutes;
  }

  /**
   * Records that a job entered the system.
   *
   * Counts what was pushed, not what completed: during an incident the useful number is
   * what arrived. The member carries the job id, and the completion collapses onto it.
   */
  async recordPushed(
    queue: string,
    job: string,
    jobId: string,
    at = Date.now(),
  ): Promise<void> {
    await this.redis.zadd(
      `${this.prefix}:recent`,
      at,
      this.member(queue, job, at, jobId),
    );
  }

  /**
   * Records a job that finished, with how long it took.
   */
  async recordCompleted(
    queue: string,
    job: string,
    runtimeMs: number,
    at = Date.now(),
    jobId = '',
  ): Promise<void> {
    const pipeline = this.redis.pipeline();

    pipeline.sadd(`${this.prefix}:queues`, queue);
    pipeline.sadd(`${this.prefix}:jobs`, job);
    pipeline.hincrby(`${this.prefix}:queue:${queue}`, 'throughput', 1);
    pipeline.hincrbyfloat(`${this.prefix}:queue:${queue}`, 'runtime', runtimeMs);
    pipeline.hincrby(`${this.prefix}:job:${job}`, 'throughput', 1);
    pipeline.hincrbyfloat(`${this.prefix}:job:${job}`, 'runtime', runtimeMs);
    pipeline.zadd(`${this.prefix}:recent`, at, this.member(queue, job, at, jobId));

    // Kept apart from pushes. `recent` answers how much work arrived, this set how much
    // got done; a job pushed but never run belongs in one and not the other.
    pipeline.zadd(`${this.prefix}:completed`, at, this.member(queue, job, at, jobId));

    await execPipeline(pipeline);
  }

  /**
   * Records a job that exhausted its attempts.
   */
  async recordFailed(
    queue: string,
    job: string,
    at = Date.now(),
    jobId = '',
  ): Promise<void> {
    await this.redis.zadd(
      `${this.prefix}:failed`,
      at,
      this.member(queue, job, at, jobId),
    );
  }

  /**
   * A unique member per job.
   *
   * ZADD rewrites the score of a member it already has. Without the id, two jobs of the
   * same name finishing in one millisecond collapse into one.
   */
  private member(queue: string, job: string, at: number, jobId: string): string {
    // The timestamp is the fallback when there is no id to key on.
    return jobId ? `${queue}:${job}:${jobId}` : `${queue}:${job}:${at}`;
  }

  /** Jobs recorded inside the configured recent-job retention window. */
  async recentJobs(): Promise<number> {
    return this.countSince(`${this.prefix}:recent`, this.recentMinutes);
  }

  /** Failures recorded inside the counter's window, which may be shorter than retention. */
  async recentlyFailed(): Promise<number> {
    return this.countSince(`${this.prefix}:failed`, this.recentFailedMinutes);
  }

  /** The windows the counters read over. The dashboard labels its numbers with these. */
  windows(): { recentJobs: number; failedJobs: number } {
    return { recentJobs: this.recentMinutes, failedJobs: this.recentFailedMinutes };
  }

  /**
   * Jobs finished per minute, counted over the last five minutes at most.
   *
   * Completions only: a failure, or a job scheduled for next month, is not work done.
   */
  async jobsPerMinute(): Promise<number> {
    // Never wider than what the records live for, or the rate is divided by minutes
    // whose jobs have already been trimmed away.
    const window = Math.min(5, this.recentMinutes);
    const key = `${this.prefix}:completed`;
    const count = await this.countSince(key, window);

    if (count === 0) {
      return 0;
    }

    // The span observed, not the nominal window: a young install has less than five
    // minutes of history, and a fixed divisor reports a fraction of the real rate.
    const [, oldest] = await this.redis.zrange(key, '0', '0', 'WITHSCORES');
    const observed = Math.min(window, (Date.now() - Number(oldest)) / 60_000);

    // Ten seconds is the shortest span the number means anything over.
    return Math.round((count / Math.max(observed, 1 / 6)) * 10) / 10;
  }

  async measuredQueues(): Promise<string[]> {
    return (await this.redis.smembers(`${this.prefix}:queues`)).sort();
  }

  async measuredJobs(): Promise<string[]> {
    return (await this.redis.smembers(`${this.prefix}:jobs`)).sort();
  }

  async measurementForQueue(queue: string): Promise<Measurement> {
    return this.measurement(`${this.prefix}:queue:${queue}`);
  }

  async measurementForJob(job: string): Promise<Measurement> {
    return this.measurement(`${this.prefix}:job:${job}`);
  }

  /**
   * The last completed measurement for a queue.
   *
   * Snapshot only: comparing queues means comparing equal periods, and the live counter
   * holds however much of the current one has elapsed.
   */
  async lastSnapshotForQueue(queue: string): Promise<Measurement> {
    const series = await this.snapshots(`${this.prefix}:snapshot:queue:${queue}`);

    // `snapshots()` returns oldest first for the charts, so the newest is at the end.
    const latest = series[series.length - 1];

    return latest
      ? { throughput: latest.throughput, runtime: latest.runtime }
      : { throughput: 0, runtime: 0 };
  }

  async summaryForQueue(queue: string): Promise<Measurement> {
    return this.summary(
      await this.measurementForQueue(queue),
      await this.snapshotsForQueue(queue),
    );
  }

  async summaryForJob(job: string): Promise<Measurement> {
    return this.summary(
      await this.measurementForJob(job),
      await this.snapshotsForJob(job),
    );
  }

  private summary(live: Measurement, snapshots: Snapshot[]): Measurement {
    if (live.throughput > 0) {
      return live;
    }

    // Idle periods snapshot as zero. Fall back to the last one that saw work: a listing
    // asks what this queue has been doing, not whether it moved in the last minute.
    for (let i = snapshots.length - 1; i >= 0; i -= 1) {
      if (snapshots[i].throughput > 0) {
        return {
          throughput: snapshots[i].throughput,
          runtime: snapshots[i].runtime,
          asOf: snapshots[i].time,
        };
      }
    }

    return live;
  }

  async snapshotsForQueue(queue: string): Promise<Snapshot[]> {
    return this.snapshots(`${this.prefix}:snapshot:queue:${queue}`);
  }

  async snapshotsForJob(job: string): Promise<Snapshot[]> {
    return this.snapshots(`${this.prefix}:snapshot:job:${job}`);
  }

  /**
   * Rolls the live counters into a time series and resets them. Each snapshot covers
   * only the period since the previous one.
   */
  async snapshot(at = Date.now(), waitFor?: WaitProvider): Promise<void> {
    const [queues, jobs] = await Promise.all([
      this.measuredQueues(),
      this.measuredJobs(),
    ]);

    for (const queue of queues) {
      await this.rollUp(
        `${this.prefix}:queue:${queue}`,
        `${this.prefix}:snapshot:queue:${queue}`,
        at,
        this.queueSnapshots,
        // Queue snapshots carry the wait, giving the chart a series
        // rather than one live number.
        waitFor ? await waitFor(queue) : undefined,
      );
    }

    for (const job of jobs) {
      await this.rollUp(
        `${this.prefix}:job:${job}`,
        `${this.prefix}:snapshot:job:${job}`,
        at,
        this.jobSnapshots,
      );
    }
  }

  /**
   * Drops the failure records for a queue, or for every queue.
   *
   * The dashboard's failed counter reads this set; it has to go when the jobs do.
   */
  async forgetFailures(queue?: string): Promise<void> {
    const key = `${this.prefix}:failed`;

    if (!queue) {
      await this.redis.del(key);

      return;
    }

    const members = await this.redis.zrange(key, '0', '-1');
    const mine = members.filter((member) => member.startsWith(`${queue}:`));

    if (mine.length) {
      await this.redis.zrem(key, ...mine);
    }
  }

  /**
   * Drops every counter and snapshot.
   */
  async clearAll(): Promise<void> {
    // The recent and failed records survive: they belong to the job history, not to the
    // measurements.
    await deleteMatching(this.redis, `${this.prefix}:queue:*`);
    await deleteMatching(this.redis, `${this.prefix}:job:*`);
    await deleteMatching(this.redis, `${this.prefix}:snapshot:*`);
    await this.redis.del(`${this.prefix}:queues`, `${this.prefix}:jobs`);
  }

  /**
   * Drops records older than the configured window, so Redis does not grow forever.
   */
  async trim(now = Date.now()): Promise<void> {
    const recent = this.options.metrics?.trimRecentMinutes ?? DEFAULT_TRIM_RECENT_MINUTES;
    const failed = this.options.metrics?.trimFailedMinutes ?? DEFAULT_TRIM_FAILED_MINUTES;

    await this.redis.zremrangebyscore(`${this.prefix}:recent`, 0, now - recent * 60_000);
    await this.redis.zremrangebyscore(
      `${this.prefix}:completed`,
      0,
      now - recent * 60_000,
    );
    await this.redis.zremrangebyscore(`${this.prefix}:failed`, 0, now - failed * 60_000);
  }

  private async countSince(key: string, minutes: number): Promise<number> {
    return this.redis.zcount(key, Date.now() - minutes * 60_000, '+inf');
  }

  private async measurement(key: string): Promise<Measurement> {
    const raw = await this.redis.hgetall(key);
    const throughput = Number(raw.throughput ?? 0);

    return {
      throughput,
      runtime: throughput === 0 ? 0 : Math.round(Number(raw.runtime ?? 0) / throughput),
    };
  }

  private async snapshots(key: string): Promise<Snapshot[]> {
    const raw = await this.redis.lrange(key, 0, this.maxSnapshots - 1);

    // A corrupt point must not break the whole chart.
    return raw
      .map((entry) => {
        try {
          return JSON.parse(entry) as Snapshot;
        } catch {
          return null;
        }
      })
      .filter((point): point is Snapshot => point !== null)
      .reverse();
  }

  private async rollUp(
    source: string,
    target: string,
    at: number,
    keep: number,
    wait?: number,
  ): Promise<void> {
    // One transaction: a job finishing between a read and a separate DEL would have its
    // throughput thrown away.
    const result = await this.redis.multi().hgetall(source).del(source).exec();
    const failure = result?.find(([error]) => error)?.[0];

    // The DEL already ran. Writing the zeroes a failed read produces would record the
    // window as idle and lose the throughput for good.
    if (failure) {
      throw failure;
    }

    const raw = (result?.[0]?.[1] ?? {}) as Record<string, string>;
    const throughput = Number(raw.throughput ?? 0);

    const measurement: Measurement = {
      throughput,
      runtime: throughput === 0 ? 0 : Math.round(Number(raw.runtime ?? 0) / throughput),
    };

    await execPipeline(
      this.redis
        .pipeline()
        .lpush(target, JSON.stringify({ ...measurement, time: at, wait }))
        .ltrim(target, 0, keep - 1),
    );
  }
}
