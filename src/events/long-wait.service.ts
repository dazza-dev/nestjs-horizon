import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { SENTINEL_OPTIONS, SENTINEL_REDIS } from '../sentinel.constants';
import type { SentinelOptions } from '../sentinel.types';
import { StatsService } from '../stats/stats.service';
import { SentinelEvents } from './sentinel.events';
import { LockService } from '../redis/lock.service';
import { resolvePrefix } from '../sentinel.options';

const MIN_INTERVAL_MS = 5_000;
const MAX_INTERVAL_MS = 60_000;

/** How long a queue stays quiet after alerting. */
const RE_ALERT_SECONDS = 300;

/**
 * Watches how long each queue is forecast to take to drain, against the `waits`
 * thresholds.
 *
 * Thresholds are keyed by queue, with `default` as the fallback. A queue over its
 * threshold alerts at most once every five minutes. The cooldown survives recovery, or a
 * queue oscillating around the threshold would page on every tick.
 */
@Injectable()
export class LongWaitService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Sentinel');
  private intervalMs = MAX_INTERVAL_MS;
  private timer?: NodeJS.Timeout;
  private readonly prefix: string;

  constructor(
    @Inject(SENTINEL_OPTIONS) private readonly options: SentinelOptions,
    private readonly stats: StatsService,
    private readonly events: SentinelEvents,
    private readonly lock: LockService,
    @Inject(SENTINEL_REDIS) private readonly redis: Redis,
  ) {
    this.prefix = resolvePrefix(options);
  }

  onApplicationBootstrap(): void {
    // The worker owns this check: an app running several API instances alerts once.
    // An empty `waits` turns the check off deliberately; an absent one gets the default.
    if (this.options.worker !== true || !Object.keys(this.options.waits ?? {}).length) {
      return;
    }

    this.intervalMs = this.interval();

    this.timer = setInterval(() => void this.check(), this.intervalMs);
    this.timer.unref();
  }

  private interval(): number {
    const thresholds = Object.values(this.options.waits ?? {});
    const tightest = Math.min(...thresholds) * 1000;

    return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, tightest));
  }

  private async check(): Promise<void> {
    try {
      // One alert per fleet, not one per worker process.
      await this.lock.once('long-wait', this.intervalMs * 0.8, () => this.scan());
    } catch (error) {
      this.logger.error(`Wait check failed: ${(error as Error).message}`);
    }
  }

  private async scan(): Promise<void> {
    const workload = await this.stats.workload();

    for (const queue of workload) {
      const threshold = this.thresholdFor(queue.name);

      if (!threshold) {
        continue;
      }

      // A queue nothing consumes has no forecast, however deep the backlog. Without this
      // the one queue that can never drain is the one that never alerts.
      const stranded = queue.wait === null && queue.length > 0;

      if (!stranded && (queue.wait ?? 0) < threshold) {
        continue;
      }

      // A cooldown, not a latch. The state lives in Redis because the worker holding the
      // lock changes, and it expires: a page that fires once and never again is one
      // nobody acts on.
      const first = await this.redis.set(
        this.alertedKey(queue.name),
        '1',
        'EX',
        RE_ALERT_SECONDS,
        'NX',
      );

      if (first !== 'OK') {
        continue;
      }

      await this.announce(queue.name, queue.wait, threshold);
    }
  }

  private async announce(
    queue: string,
    seconds: number | null,
    threshold: number,
  ): Promise<void> {
    this.logger.warn(
      seconds === null
        ? `${queue} has a backlog and nothing consuming it, so it will never drain.`
        : `${queue} needs about ${seconds}s to drain, over its ${threshold}s threshold.`,
    );
    this.events.emit('long-wait', { queue, seconds, threshold });

    try {
      await this.options.onLongWait?.({ queue, seconds, threshold });
    } catch (error) {
      this.logger.error(`onLongWait threw: ${(error as Error).message}`);
    }
  }

  private alertedKey(queue: string): string {
    return `${this.prefix}:long-wait-alerted:${queue}`;
  }

  private thresholdFor(queue: string): number | undefined {
    return this.options.waits?.[queue] ?? this.options.waits?.default;
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }
}
