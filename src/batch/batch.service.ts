import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Redis } from 'ioredis';
import { randomUUID } from 'crypto';
import {
  SENTINEL_OPTIONS,
  SENTINEL_REDIS,
  DEFAULT_BATCH_TTL_SECONDS,
} from '../sentinel.constants';
import type { SentinelOptions } from '../sentinel.types';
import { QueueRegistry } from '../queues/queue.registry';
import { SentinelEvents } from '../events/sentinel.events';
import { resolvePrefix } from '../sentinel.options';
import { execPipeline } from '../redis/client';
import type {
  Batch,
  BatchJobSpec,
  BatchOptions,
  BatchPage,
  FailedJobRef,
} from './batch.types';

const parseRef = (entry: string): FailedJobRef | null => {
  try {
    return JSON.parse(entry) as FailedJobRef;
  } catch {
    return null;
  }
};

@Injectable()
export class BatchService {
  private readonly logger = new Logger('Sentinel');
  private readonly ttl: number;
  private readonly keyPrefix: string;

  constructor(
    @Inject(SENTINEL_OPTIONS) options: SentinelOptions,
    @Inject(SENTINEL_REDIS) private readonly redis: Redis,
    private readonly queues: QueueRegistry,
    private readonly events: SentinelEvents,
  ) {
    // A TTL of zero deletes the batch on the spot, and `SET … EX 0` errors outright.
    this.ttl = Math.max(60, options.batchTtlSeconds ?? DEFAULT_BATCH_TTL_SECONDS);
    this.keyPrefix = `${resolvePrefix(options)}:batch:`;
  }

  /**
   * Creates the batch and queues every job in it.
   */
  async dispatch(options: BatchOptions): Promise<Batch> {
    const id = randomUUID();
    const key = this.key(id);

    // A chain counts as many jobs as it has links, even though only the first is queued.
    const total = options.jobs.reduce(
      (count, entry) => count + (Array.isArray(entry) ? entry.length : 1),
      0,
    );

    await this.redis.hset(key, {
      id,
      name: options.name,
      totalJobs: total,
      pendingJobs: total,
      processedJobs: 0,
      failedJobs: 0,
      cancelled: 0,
      finished: 0,
      allowFailures: options.allowFailures ? 1 : 0,
      createdAt: new Date().toISOString(),
      finishedAt: '',
      then: options.then ? JSON.stringify(options.then) : '',
      catch: options.catch ? JSON.stringify(options.catch) : '',
      finally: options.finally ? JSON.stringify(options.finally) : '',
    });
    await this.redis.expire(key, this.ttl);

    // Index so the dashboard can list batches without scanning the keyspace.
    await this.redis.zadd(this.indexKey, Date.now(), id);

    // Prune by age before rank. Records expire on their own, and a rank-only prune fills
    // with dead ids that evict live ones to make room.
    await this.redis.zremrangebyscore(this.indexKey, 0, Date.now() - this.ttl * 1000);
    await this.redis.zremrangebyrank(this.indexKey, 0, -501);

    for (const entry of options.jobs) {
      if (!Array.isArray(entry)) {
        await this.enqueue(id, entry);
        continue;
      }

      const [first, ...rest] = entry;

      if (first) {
        await this.enqueue(id, first, rest);
      }
    }

    this.logger.log(`Batch ${id} (${options.name}) with ${total} jobs`);

    return (await this.find(id)) as Batch;
  }

  /**
   * Queues the next link of a chain, once the current one finished.
   */
  async continueChain(id: string, chain: BatchJobSpec[]): Promise<void> {
    const [next, ...rest] = chain;

    if (next) {
      await this.enqueue(id, next, rest);
    }
  }

  private async enqueue(
    id: string,
    spec: BatchJobSpec,
    chain: BatchJobSpec[] = [],
  ): Promise<void> {
    await this.queues.get(spec.queue).add(spec.name ?? 'default', {
      ...spec.data,
      batchId: id,
      ...(chain.length ? { chain } : {}),
    });
  }

  /**
   * The most recent batches, newest first.
   */
  async list({
    search = '',
    page = 0,
    perPage = 25,
  }: { search?: string; page?: number; perPage?: number } = {}): Promise<BatchPage> {
    const ids = await this.redis.zrevrange(this.indexKey, 0, -1);
    const all = (await Promise.all(ids.map((id) => this.find(id)))).filter(
      (batch): batch is Batch => batch !== null,
    );

    const needle = search.trim().toLowerCase();
    const matched = needle
      ? all.filter(
          (batch) =>
            batch.name.toLowerCase().includes(needle) ||
            batch.id.toLowerCase().includes(needle),
        )
      : all;

    return {
      batches: matched.slice(page * perPage, (page + 1) * perPage),
      total: matched.length,
    };
  }

  /**
   * Notes that a failed job of this batch is being retried.
   */
  async recordRetry(id: string): Promise<void> {
    // Retrying is not an event the batch counts. The counters move when the job runs
    // again: a success drops it from the failure list, another failure adds it back.
    await this.touch(id);
  }

  /** Drops a job from the batch's failure list once it has been retried. */
  async forgetFailure(id: string, jobId: string): Promise<void> {
    const raw = await this.redis.lrange(this.failedKey(id), 0, -1);

    // Every reference, not just the first one found. A copy left behind keeps showing a
    // completed job as failed.
    for (const entry of raw) {
      if (parseRef(entry)?.jobId === jobId) {
        await this.redis.lrem(this.failedKey(id), 0, entry);
      }
    }
  }

  /**
   * The jobs of this batch that ran out of attempts, newest first.
   */
  async failedJobs(id: string): Promise<FailedJobRef[]> {
    const raw = await this.redis.lrange(this.failedKey(id), 0, -1);

    // One corrupt entry must not take the whole failure list with it.
    return raw
      .map((entry) => parseRef(entry))
      .filter((ref): ref is FailedJobRef => ref !== null);
  }

  /**
   * Returns the batch state, or `null` once it expired.
   */
  async find(id: string): Promise<Batch | null> {
    const raw = await this.redis.hgetall(this.key(id));

    if (!raw.id) {
      return null;
    }

    const total = Number(raw.totalJobs);

    // A retried job can decrement this past zero, which shows up as progress over 100%.
    const pending = Math.max(0, Number(raw.pendingJobs));

    // Derived, not stored. A stored copy would drift from pendingJobs.
    const processed = total - pending;
    const skipped = Number(raw.skippedJobs ?? 0);

    return {
      id: raw.id,
      name: raw.name,
      totalJobs: total,
      pendingJobs: pending,
      processedJobs: processed,
      failedJobs: Number(raw.failedJobs),

      skippedJobs: skipped,
      cancelled: raw.cancelled === '1',
      cancelledAt: raw.cancelledAt || null,
      finished: raw.finished === '1',
      allowFailures: raw.allowFailures === '1',
      createdAt: raw.createdAt,
      finishedAt: raw.finishedAt || null,
      progress: total === 0 ? 0 : Math.round((processed / total) * 100),
    };
  }

  /**
   * Cancels the batch: the jobs that have not started skip themselves.
   */
  async cancel(id: string): Promise<void> {
    if (!(await this.redis.exists(this.key(id)))) {
      throw new NotFoundException(`Batch ${id} not found. It may have expired.`);
    }

    await this.markCancelled(id);
  }

  async cancelled(id: string): Promise<boolean> {
    return (await this.redis.hget(this.key(id), 'cancelled')) === '1';
  }

  /**
   * Marks a batch cancelled, once, and only if it is still there.
   *
   * HSET and HINCRBY both create a missing key, resurrecting an expired batch as a
   * nameless husk that `find()` reports as gone while it sits in Redis.
   */
  private async markCancelled(id: string): Promise<void> {
    const key = this.key(id);

    if (!(await this.redis.exists(key))) {
      return;
    }

    const already = await this.redis.hget(key, 'cancelled');

    const now = new Date().toISOString();

    // Not HSETNX. Dispatch creates both fields empty, so they always exist and the write
    // would never fire.
    const [finishedAt, cancelledAt] = await this.redis.hmget(
      key,
      'finishedAt',
      'cancelledAt',
    );

    // Each timestamp is stamped once. A second cancel would otherwise push `cancelledAt`
    // past the `finishedAt` the first one wrote.
    await this.redis.hset(key, 'cancelled', 1, 'finished', 1);

    if (!cancelledAt) {
      await this.redis.hset(key, 'cancelledAt', now);
    }

    if (!finishedAt) {
      await this.redis.hset(key, 'finishedAt', cancelledAt || now);
    }
    await this.redis.expire(key, this.ttl);

    if (already === '1') {
      return;
    }

    this.logger.warn(`Batch ${id} cancelled`);
    this.events.emit('batch.cancelled', { batchId: id, name: await this.nameOf(id) });
  }

  /** Whether the batch is still in Redis. A write after expiry rebuilds it as a husk. */
  private async alive(id: string): Promise<boolean> {
    return (await this.redis.exists(this.key(id))) === 1;
  }

  /**
   * A job of this batch finished successfully.
   *
   * Only a success moves `pendingJobs`, and the batch is finished when it reaches zero.
   */
  async recordSuccess(id: string, by = 1, jobId?: string): Promise<void> {
    const key = this.key(id);

    if (!(await this.alive(id))) {
      return;
    }

    // A job retried into success leaves the failure list, but the `failedJobs` tally
    // stands: it counts failures that happened, not failures outstanding.
    if (jobId) {
      await this.forgetFailure(id, jobId);
    }

    const pending = await this.redis.hincrby(key, 'pendingJobs', -by);

    await this.touch(id);

    const failed = Number((await this.redis.hget(key, 'failedJobs')) ?? 0);

    if (pending <= 0) {
      await this.markFinished(id);
    }

    // Every job has now run once, whatever the outcome. On a batch that had failures this
    // is the only path that fires `finally`; `then` never will.
    if (pending - failed <= 0) {
      await this.runOnce(id, 'finally');
    }
  }

  /**
   * A job that never ran because the batch was already cancelled.
   *
   * Counted as a success: it was not a failure, and the batch has to be able to conclude.
   */
  async recordSkipped(id: string, abandonedInChain = 0): Promise<void> {
    const by = 1 + abandonedInChain;

    if (await this.alive(id)) {
      // Counted apart too, or a cancelled batch reports the same "100% processed" as one
      // that ran to the end.
      await this.redis.hincrby(this.key(id), 'skippedJobs', by);
    }

    await this.recordSuccess(id, by);
  }

  /**
   * Records a failure. Unless the batch allows failures, it cancels the rest.
   */
  async recordFailure(
    id: string,
    abandonedInChain = 0,
    job?: FailedJobRef,
  ): Promise<void> {
    const key = this.key(id);

    if (!(await this.alive(id))) {
      return;
    }

    const failed = await this.redis.hincrby(key, 'failedJobs', 1);

    // Kept so the dashboard can list a batch's failures without scanning every queue. The
    // old entry goes first: BullMQ retries the same job id, which would otherwise appear
    // twice.
    if (job) {
      await this.forgetFailure(id, job.jobId);
      await this.redis.lpush(this.failedKey(id), JSON.stringify(job));
      await this.redis.expire(this.failedKey(id), this.ttl);
    }

    // Cancel first: a `catch` handler that inspects the batch should see it cancelled.
    if (failed === 1 && (await this.redis.hget(key, 'allowFailures')) !== '1') {
      await this.markCancelled(id);
    }

    // Never fatally: a hook queued to an undeclared queue would stop the counters below
    // it and hang the batch.
    if (failed === 1) {
      await this.run(id, 'catch').catch((error: Error) =>
        this.logger.error(`Batch ${id} catch hook failed: ${error.message}`),
      );
    }

    await this.touch(id);

    // The failure leaves `pendingJobs` alone; that is what lets a retry complete the
    // batch later. Only the links of a broken chain are written off.
    if (abandonedInChain > 0) {
      await this.recordSuccess(id, abandonedInChain);

      return;
    }

    const pending = Number((await this.redis.hget(key, 'pendingJobs')) ?? 0);

    if (pending - failed <= 0) {
      await this.runOnce(id, 'finally');
    }
  }

  private async nameOf(id: string): Promise<string> {
    return (await this.redis.hget(this.key(id), 'name')) ?? '';
  }

  /** Keeps the batch and its one-shot guards alive for another TTL window. */
  private async touch(id: string): Promise<void> {
    const key = this.key(id);

    // Refreshed, not set once. A batch that outlives its TTL evaporates mid-flight, and
    // the next HINCRBY rebuilds a hash with no expiry.
    await execPipeline(
      this.redis
        .pipeline()
        .expire(key, this.ttl)
        .expire(`${key}:finished`, this.ttl)
        .expire(`${key}:finally`, this.ttl),
    );
  }

  /**
   * Every job succeeded. Reached only when `pendingJobs` hits zero, the one place from
   * which `then` can fire.
   */
  private async markFinished(id: string): Promise<void> {
    const key = this.key(id);

    if ((await this.redis.set(`${key}:finished`, '1', 'EX', this.ttl, 'NX')) !== 'OK') {
      return;
    }

    await this.redis.hset(key, 'finished', 1, 'finishedAt', new Date().toISOString());
    this.events.emit('batch.finished', { batchId: id, name: await this.nameOf(id) });

    await this.run(id, 'then').catch((error: Error) =>
      this.logger.error(`Batch ${id} then hook failed: ${error.message}`),
    );
  }

  /** Runs a hook at most once for the life of the batch. */
  private async runOnce(id: string, hook: 'finally'): Promise<void> {
    const key = `${this.key(id)}:${hook}`;

    if ((await this.redis.set(key, '1', 'EX', this.ttl, 'NX')) !== 'OK') {
      return;
    }

    await this.run(id, hook).catch((error: Error) =>
      this.logger.error(`Batch ${id} ${hook} hook failed: ${error.message}`),
    );
  }

  private async run(id: string, hook: 'then' | 'catch' | 'finally'): Promise<void> {
    const raw = await this.redis.hget(this.key(id), hook);

    if (!raw) {
      return;
    }

    const spec = JSON.parse(raw) as BatchJobSpec;

    await this.queues.get(spec.queue).add(
      spec.name ?? hook,
      {
        ...spec.data,
        batchId: id,
        batchCallback: true,
      },
      // Hooks are ordinary jobs: without a priority, a `finally` can run before the
      // `catch` it is supposed to follow.
      { priority: hook === 'finally' ? 2 : 1 },
    );
  }

  private failedKey(id: string): string {
    return `${this.keyPrefix}${id}:failed`;
  }

  private get indexKey(): string {
    return `${this.keyPrefix}index`;
  }

  private key(id: string): string {
    return `${this.keyPrefix}${id}`;
  }
}
