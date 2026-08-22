import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { SENTINEL_OPTIONS } from '../sentinel.constants';
import type { SentinelOptions } from '../sentinel.types';
import { SentinelEvents } from '../events/sentinel.events';

const CHECK_INTERVAL_MS = 10_000;

/**
 * Retires the worker process once it passes the configured limits.
 *
 * A clean shutdown: in-flight jobs finish and the process exits, leaving the restart
 * to whatever supervises it.
 */
@Injectable()
export class WorkerLimitsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Sentinel');
  private readonly startedAt = Date.now();
  private processed = 0;
  private timer?: NodeJS.Timeout;
  private retiring = false;

  constructor(
    @Inject(SENTINEL_OPTIONS) private readonly options: SentinelOptions,
    private readonly events: SentinelEvents,
  ) {}

  onApplicationBootstrap(): void {
    const limits = this.options.workerLimits;

    if (this.options.worker !== true || !limits) {
      return;
    }

    if (limits.maxLifetimeSeconds || limits.memoryLimitMb) {
      this.timer = setInterval(() => this.check(), CHECK_INTERVAL_MS);
      this.timer.unref();
    }
  }

  /**
   * Called by the worker manager on every attempt that finished, successful or not.
   *
   * Failures count too: a worker whose queue is failing everything still has to recycle.
   * Retries count as separate attempts.
   */
  countJob(): void {
    this.processed += 1;

    const max = this.options.workerLimits?.maxJobs;

    if (max && this.processed >= max) {
      this.retire(`processed ${this.processed} jobs`);
    }
  }

  private check(): void {
    const limits = this.options.workerLimits;

    if (!limits) {
      return;
    }

    const aliveSeconds = (Date.now() - this.startedAt) / 1000;

    if (limits.maxLifetimeSeconds && aliveSeconds >= limits.maxLifetimeSeconds) {
      this.retire(`alive for ${Math.round(aliveSeconds)}s`);

      return;
    }

    // Heap, not resident size. RSS on a bare Nest worker sits near 100MB and never
    // shrinks after GC, so a heap-tuned limit would retire it on the first check.
    const heapMb = process.memoryUsage().heapUsed / 1024 / 1024;

    if (limits.memoryLimitMb && heapMb >= limits.memoryLimitMb) {
      this.retire(`heap at ${Math.round(heapMb)}MB`);
    }
  }

  private retire(reason: string): void {
    if (this.retiring) {
      return;
    }

    this.retiring = true;
    this.logger.warn(
      `Worker retiring: ${reason}. Your process manager should restart it.`,
    );
    this.events.emit('worker.retiring', { reason });

    // SIGTERM so Nest runs its shutdown hooks and the workers drain first.
    process.kill(process.pid, 'SIGTERM');
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }
}
