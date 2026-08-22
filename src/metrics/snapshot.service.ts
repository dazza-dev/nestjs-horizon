import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { SENTINEL_OPTIONS } from '../sentinel.constants';
import type { SentinelOptions } from '../sentinel.types';
import { MetricsService } from './metrics.service';
import { StatsService } from '../stats/stats.service';
import { MaintenanceService } from '../maintenance/maintenance.service';
import { LockService } from '../redis/lock.service';
import { SilencedService } from '../silenced/silenced.service';

const DEFAULT_INTERVAL_SECONDS = 300;

/**
 * Rolls the counters into the time series on a timer.
 *
 * Every instance ticks and a lock picks one, since rolling up deletes what it reads.
 */
@Injectable()
export class SnapshotService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Sentinel');
  private timer?: NodeJS.Timeout;

  private intervalMs = DEFAULT_INTERVAL_SECONDS * 1000;

  constructor(
    @Inject(SENTINEL_OPTIONS) private readonly options: SentinelOptions,
    private readonly metrics: MetricsService,
    private readonly stats: StatsService,
    private readonly maintenance: MaintenanceService,
    private readonly lock: LockService,
    private readonly silencing: SilencedService,
  ) {}

  onApplicationBootstrap(): void {
    const seconds =
      this.options.metrics?.snapshotIntervalSeconds ?? DEFAULT_INTERVAL_SECONDS;

    this.intervalMs = seconds * 1000;

    this.timer = setInterval(() => {
      void this.run();
    }, this.intervalMs);

    // Nothing here should hold the process open on its own.
    this.timer.unref();

    this.logger.log(`Snapshots every ${seconds}s`);
  }

  private async run(): Promise<void> {
    try {
      // Held for most of the interval: one worker owns the tick, and the lock is free
      // again by the next one.
      await this.lock.once('snapshot', this.intervalMs * 0.8, async () => {
        const workload = await this.stats.workload();
        const waits = new Map(workload.map((queue) => [queue.name, queue.wait]));

        await this.metrics.snapshot(Date.now(), (queue) =>
          Promise.resolve(waits.get(queue) ?? 0),
        );
        await this.metrics.trim();
        await this.silencing.trim();

        // Age-based retention rides the same tick; one worker does it for the fleet.
        const removed = await this.maintenance.trim();

        if (removed) {
          this.logger.log(`Trimmed ${removed} finished jobs`);
        }
      });
    } catch (error) {
      this.logger.error(`Snapshot failed: ${(error as Error).message}`);
    }
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }
}
