import { Inject, Injectable, Logger } from '@nestjs/common';
import { SENTINEL_OPTIONS } from '../sentinel.constants';
import type { SentinelOptions } from '../sentinel.types';
import { QueueRegistry } from '../queues/queue.registry';
import { StatsService } from '../stats/stats.service';
import { MetricsService } from '../metrics/metrics.service';
import { TagsService } from '../tags/tags.service';
import { FailureContextService } from '../failures/failure-context.service';
import { SilencedService } from '../silenced/silenced.service';
import { RetryLogService } from '../retries/retry-log.service';
import { WorkerRegistry } from '../worker/worker-registry.service';

export interface SentinelStatus {
  status: 'running' | 'paused' | 'inactive';
  workers: number;
  processes: number;
  paused: string[];
}

/** How many jobs one trim round removes per queue and type. */
const TRIM_BATCH = 1000;

@Injectable()
export class MaintenanceService {
  private readonly logger = new Logger('Sentinel');

  constructor(
    @Inject(SENTINEL_OPTIONS) private readonly options: SentinelOptions,
    private readonly queues: QueueRegistry,
    private readonly stats: StatsService,
    private readonly metrics: MetricsService,
    private readonly workers: WorkerRegistry,
    private readonly tags: TagsService,
    private readonly failures: FailureContextService,
    private readonly silencing: SilencedService,
    private readonly retries: RetryLogService,
  ) {}

  /**
   * Empties a queue of work that has not run: waiting and delayed jobs are dropped and a
   * job already being processed runs to the end.
   *
   * The failure history is left alone: clearing a backlog and erasing the record of what
   * went wrong are different decisions, and only one of them is reversible.
   */
  async clear(name: string): Promise<number> {
    const queue = this.queues.get(name);
    const before = await queue.getJobCountByTypes('waiting', 'prioritized', 'delayed');

    await queue.drain(true);
    this.logger.warn(`Queue ${name} cleared: ${before} jobs`);

    return before;
  }

  async clearAll(): Promise<Record<string, number>> {
    const cleared: Record<string, number> = {};

    for (const name of this.queues.names()) {
      cleared[name] = await this.clear(name);
    }

    return cleared;
  }

  /**
   * Deletes every failed job.
   *
   * Without it the only way out of a flood of failures is one click per job.
   */
  async forgetFailed(name?: string): Promise<number> {
    const names = name ? [name] : this.queues.names();
    let removed = 0;

    for (const queue of names) {
      removed += (await this.queues.get(queue).clean(0, 0, 'failed')).length;
    }

    // The counter and the tag index are part of the same record; left behind, they
    // report failures whose listing is already empty.
    await this.metrics.forgetFailures(name);
    await this.tags.forgetFailures(name);
    await this.failures.clear(name);
    await this.retries.clear(name);

    this.logger.warn(`Forgot ${removed} failed jobs`);

    return removed;
  }

  /** Drops every measurement and snapshot. */
  async clearMetrics(): Promise<void> {
    await this.metrics.clearAll();
    this.logger.warn('Metrics cleared');
  }

  /** Pauses every supervisor. */
  async pauseAll(): Promise<string[]> {
    return this.workers.pauseAll();
  }

  /** Resumes every supervisor. */
  async resumeAll(): Promise<void> {
    await this.workers.resumeAll();
  }

  /** Asks every worker to finish and exit. The process manager starts the new ones. */
  async terminate(): Promise<void> {
    await this.workers.terminate();
    this.logger.warn('Terminate requested for every worker');
  }

  /**
   * Drops jobs older than the configured windows.
   *
   * `removeOnComplete` bounds the listings by count; this bounds them by age. `delayed`
   * goes by creation age, not by due date. Read its doc before enabling it.
   */
  async trim(): Promise<number> {
    const trim = this.options.trim;

    if (!trim) {
      return 0;
    }

    const windows: [number | undefined, 'completed' | 'failed' | 'delayed'][] = [
      [trim.completed, 'completed'],
      [trim.failed, 'failed'],
      [trim.delayed, 'delayed'],
    ];

    let removed = 0;

    for (const name of this.queues.names()) {
      const queue = this.queues.get(name);

      for (const [minutes, type] of windows) {
        if (!minutes) {
          continue;
        }

        const gone = await queue.clean(minutes * 60_000, TRIM_BATCH, type);

        removed += gone.length;

        // The silenced index points at completed jobs. Drop what this sweep took, or the
        // completed total subtracts entries that are no longer there.
        if (type === 'completed' && gone.length) {
          await this.silencing.forgetMany(name, gone.map(String));
        }
      }
    }

    return removed;
  }

  async status(): Promise<SentinelStatus> {
    const { status, workers, processes, paused } = await this.stats.dashboard();

    return { status, workers, processes, paused };
  }
}
