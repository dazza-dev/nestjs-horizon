import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { hostname } from 'os';
import { SENTINEL_OPTIONS, SENTINEL_REDIS } from '../sentinel.constants';
import type { SentinelOptions } from '../sentinel.types';
import { resolvePrefix } from '../sentinel.options';
import { execPipeline } from '../redis/client';

const HEARTBEAT_SECONDS = 5;
const TTL_SECONDS = 15;

export interface WorkerRecord {
  id: string;
  pid: number;
  hostname: string;
  supervisors: string[];
  queues: string[];
  /** Total slots across every queue this worker serves. */
  concurrency: number;

  /** Slots per queue, the divisor for a per-queue wait forecast. */
  slots: Record<string, number>;
  startedAt: string;
  lastHeartbeat: string;
}

/**
 * Lets each worker announce itself, so the dashboard can show what is running.
 *
 * The record has a TTL and a timer refreshes it, so a worker that dies disappears with
 * nothing to clean up.
 */
@Injectable()
export class WorkerRegistry implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Sentinel');
  private readonly prefix: string;
  private readonly indexKey: string;
  private readonly id = `${hostname()}:${process.pid}`;
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(SENTINEL_OPTIONS) private readonly options: SentinelOptions,
    @Inject(SENTINEL_REDIS) private readonly redis: Redis,
  ) {
    this.prefix = resolvePrefix(options);
    this.indexKey = `${this.prefix}:workers`;
  }

  /**
   * What this process actually started, not what the config declares.
   *
   * A queue whose processor is missing would otherwise publish slots nothing consumes.
   */
  private running?: { supervisors: string[]; slots: Record<string, number> };

  declareRunning(supervisors: string[], slots: Record<string, number>): void {
    this.running = { supervisors, slots };

    // Publish straight away: this lands after the first heartbeat, which claims the
    // process runs nothing.
    this.beat();
  }

  onApplicationBootstrap(): void {
    if (this.options.worker !== true) {
      return;
    }

    this.beat();

    this.timer = setInterval(() => this.beat(), HEARTBEAT_SECONDS * 1000);
    this.timer.unref();
  }

  /**
   * Every worker alive right now.
   *
   * Through an index, not a key scan: the dashboard asks every few seconds and KEYS
   * blocks Redis while it walks the keyspace.
   */
  async all(): Promise<WorkerRecord[]> {
    const ids = await this.redis.smembers(this.indexKey);

    if (!ids.length) {
      return [];
    }

    const records = await this.redis.mget(
      ...ids.map((id) => `${this.prefix}:worker:${id}`),
    );

    // A record whose TTL ran out leaves its id behind. Drop it in passing.
    const dead = ids.filter((_, i) => records[i] === null);

    if (dead.length) {
      await this.redis.srem(this.indexKey, ...dead);
    }

    return records
      .filter((raw): raw is string => raw !== null)
      .map((raw) => {
        try {
          return JSON.parse(raw) as WorkerRecord;
        } catch {
          return null;
        }
      })
      .filter((record): record is WorkerRecord => record !== null)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Pauses a supervisor. Its workers stop taking new jobs but finish what they hold.
   */
  async pause(supervisor: string): Promise<void> {
    this.assertKnown(supervisor);
    await this.redis.sadd(`${this.prefix}:paused`, supervisor);
  }

  async resume(supervisor: string): Promise<void> {
    // Anything actually paused can be resumed, declared or not. A supervisor dropped from
    // the config while paused would otherwise be stuck in the set.
    if (!(await this.isPaused(supervisor))) {
      this.assertKnown(supervisor);
    }

    await this.redis.srem(`${this.prefix}:paused`, supervisor);
  }

  /** A typo must not report success and then pause nothing. */
  private assertKnown(supervisor: string): void {
    // hasOwn, not a truthiness test. `__proto__` and `toString` are truthy on any plain
    // object, and a typo of one would pause a supervisor that does not exist.
    if (!Object.hasOwn(this.options.supervisors, supervisor)) {
      throw new BadRequestException(
        `Supervisor "${supervisor}" is not declared in the Sentinel config.`,
      );
    }
  }

  async paused(): Promise<string[]> {
    return this.redis.smembers(`${this.prefix}:paused`);
  }

  async isPaused(supervisor: string): Promise<boolean> {
    return (await this.redis.sismember(`${this.prefix}:paused`, supervisor)) === 1;
  }

  /** Pauses every supervisor. */
  async pauseAll(): Promise<string[]> {
    const names = Object.keys(this.options.supervisors);

    if (names.length) {
      await this.redis.sadd(`${this.prefix}:paused`, ...names);
    }

    return names;
  }

  /** Resumes every supervisor. */
  async resumeAll(): Promise<void> {
    await this.redis.del(`${this.prefix}:paused`);
  }

  /**
   * Asks every worker to shut down cleanly.
   *
   * The flag carries when it was raised, so a worker started after a deploy ignores it.
   */
  async terminate(): Promise<void> {
    await this.redis.set(`${this.prefix}:terminate`, await this.now());
  }

  /**
   * Redis's clock, so the flag and the worker reading it are timed by the same one.
   *
   * They are usually different machines, and drift either kills the replacements a
   * deploy just started or leaves the old ones running.
   */
  async now(): Promise<number> {
    const [seconds, micros] = await this.redis.time();

    return Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
  }

  async terminateRequestedAt(): Promise<number | null> {
    const raw = await this.redis.get(`${this.prefix}:terminate`);

    return raw ? Number(raw) : null;
  }

  /**
   * A heartbeat that cannot take the process down.
   *
   * The next beat re-publishes the record, so a missed write is not worth an unhandled
   * rejection.
   */
  private beat(): void {
    this.announce().catch((error: Error) =>
      this.logger.error(`Heartbeat failed: ${error.message}`),
    );
  }

  private async announce(): Promise<void> {
    const supervisors = this.running?.supervisors ?? [];
    const slots = this.running?.slots ?? {};
    const queues = Object.keys(slots);
    const concurrency = Object.values(slots).reduce((total, n) => total + n, 0);

    const record: WorkerRecord = {
      id: this.id,
      pid: process.pid,
      hostname: hostname(),
      supervisors,
      queues,
      concurrency,
      slots,
      startedAt: this.startedAt,
      lastHeartbeat: new Date().toISOString(),
    };

    await execPipeline(
      this.redis
        .pipeline()
        .set(
          `${this.prefix}:worker:${this.id}`,
          JSON.stringify(record),
          'EX',
          TTL_SECONDS,
        )
        .sadd(this.indexKey, this.id),
    );
  }

  private readonly startedAt = new Date().toISOString();

  /** Leaves the index clean when a worker shuts down on purpose. */
  private async withdraw(): Promise<void> {
    await execPipeline(
      this.redis
        .pipeline()
        .del(`${this.prefix}:worker:${this.id}`)
        .srem(this.indexKey, this.id),
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
    }

    // The record has a TTL anyway; a shutdown must not fail over a stale index entry.
    await this.withdraw().catch((error: Error) =>
      this.logger.error(`Could not withdraw from the worker index: ${error.message}`),
    );
  }
}
