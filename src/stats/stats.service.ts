import { Inject, Injectable } from '@nestjs/common';
import { SENTINEL_OPTIONS } from '../sentinel.constants';
import type { SentinelOptions } from '../sentinel.types';
import { QueueRegistry } from '../queues/queue.registry';
import { MetricsService } from '../metrics/metrics.service';
import { WorkerRegistry } from '../worker/worker-registry.service';
import type { WorkerRecord } from '../worker/worker-registry.service';

export interface QueueWorkload {
  name: string;
  length: number;

  /** Jobs scheduled for later, which are not part of the backlog. */
  delayed: number;

  /**
   * Seconds this queue needs to drain at its current throughput, or null when there is
   * no answer: nothing is consuming it, or nothing has ever run on it to measure.
   */
  wait: number | null;
  processes: number;

  /** Whether every supervisor on this queue is paused. */
  paused: boolean;
}

export interface SupervisorView {
  name: string;
  queues: string[];

  /** Queues this supervisor declares that no worker started on, for want of a processor. */
  unconsumed: string[];
  concurrency: number;
  paused: boolean;

  /** False when nothing is running this supervisor right now. */
  running: boolean;
}

export interface Master {
  id: string;
  hostname: string;
  pid: number;
  startedAt: string;
  supervisors: SupervisorView[];
}

export interface DashboardStats {
  jobsPerMinute: number;
  /** Jobs that entered the system inside the recent-job retention window. */
  recentJobs: number;

  /** Failures inside the failed-job retention window. */
  failedJobs: number;
  processes: number;

  /**
   * Seconds the slowest queue needs to drain, or null when any queue has no forecast.
   */
  maxWait: number | null;

  /** Retention windows the dashboard labels its counters with, in minutes. */
  periods: { recentJobs: number; failedJobs: number };
  workers: number;
  paused: string[];
  status: 'running' | 'paused' | 'inactive';
  queueWithMaxRuntime: string | null;
  queueWithMaxThroughput: string | null;
}

/**
 * Assembles what the dashboard shows on its front page.
 */
@Injectable()
export class StatsService {
  constructor(
    @Inject(SENTINEL_OPTIONS) private readonly options: SentinelOptions,
    private readonly queues: QueueRegistry,
    private readonly metrics: MetricsService,
    private readonly workers: WorkerRegistry,
  ) {}

  async dashboard(): Promise<DashboardStats> {
    const [jobsPerMinute, recentJobs, failedJobs, workers, paused, measured] =
      await Promise.all([
        this.metrics.jobsPerMinute(),
        this.metrics.recentJobs(),
        this.metrics.recentlyFailed(),
        this.workers.all(),
        this.workers.paused(),
        this.metrics.measuredQueues(),
      ]);

    const workload = await this.workload(workers);

    const measurements = await Promise.all(
      measured.map(async (name) => ({
        name,
        ...(await this.metrics.lastSnapshotForQueue(name)),
      })),
    );

    // Snapshot to snapshot: mixing the live counter in pits a queue thirty seconds into
    // its window against another's full period.
    const byRuntime = [...measurements].sort((a, b) => b.runtime - a.runtime);
    const byThroughput = [...measurements].sort((a, b) => b.throughput - a.throughput);

    // Paused when any supervisor is, since a half-stopped fleet is not running normally.
    // Only those this config still declares, or a removed one pins it there for good.
    const declared = new Set(Object.keys(this.options.supervisors));
    const anyPaused = paused.some((name) => declared.has(name));

    return {
      jobsPerMinute,
      recentJobs,
      failedJobs,
      processes: workers.reduce((total, worker) => total + worker.concurrency, 0),
      // A queue with no forecast wins the maximum rather than being skipped: it will not
      // drain at all.
      maxWait: workload.some((queue) => queue.wait === null)
        ? null
        : workload.reduce((max, queue) => Math.max(max, queue.wait ?? 0), 0),
      // Straight from the service that counts: a label can never describe a different
      // window than the number beside it.
      periods: this.metrics.windows(),
      workers: workers.length,
      paused: paused.filter((name) => declared.has(name)),
      status: workers.length === 0 ? 'inactive' : anyPaused ? 'paused' : 'running',
      queueWithMaxRuntime: byRuntime[0]?.name ?? null,
      queueWithMaxThroughput: byThroughput[0]?.name ?? null,
    };
  }

  /**
   * Per-queue backlog, with a forecast of how long each queue needs to drain.
   */
  async workload(known?: WorkerRecord[]): Promise<QueueWorkload[]> {
    const workers = known ?? (await this.workers.all());
    const halted = new Set(await this.workers.paused());

    // A queue is paused when every supervisor that declares it is. One live supervisor
    // on it is enough for the work to keep moving.
    const consumers = (queue: string): string[] =>
      Object.entries(this.options.supervisors)
        .filter(([, supervisor]) => supervisor.queues.includes(queue))
        .map(([name]) => name);

    return Promise.all(
      this.queues.names().map(async (name) => {
        const queue = this.queues.get(name);
        // `getWaitingCount` covers `waiting` only; a job given a `priority` lives in its
        // own set. This package recommends that topology.
        const [waiting, prioritized, delayed, active] = await Promise.all([
          queue.getWaitingCount(),
          queue.getJobCountByTypes('prioritized'),
          queue.getDelayedCount(),
          queue.getActiveCount(),
        ]);

        const ready = waiting + prioritized;

        const processes = workers.reduce(
          (total, worker) => total + (worker.slots?.[name] ?? 0),
          0,
        );

        const on = consumers(name);

        return {
          name,
          paused: on.length > 0 && on.every((supervisor) => halted.has(supervisor)),

          // Ready plus in flight. Delayed jobs are counted apart: work scheduled for
          // next month is not a backlog, and would contradict the wait beside it.
          length: ready + active,
          delayed,
          wait: await this.timeToClear(name, ready + active, processes),
          processes,
        };
      }),
    );
  }

  /**
   * Seconds the queue needs to drain: work ready now, times what a job costs, spread
   * over the workers on it.
   *
   * Not the age of the oldest job: that says how late you already are, this how late you
   * are about to be.
   */
  private async timeToClear(
    name: string,
    ready: number,
    processes: number,
  ): Promise<number | null> {
    if (ready === 0) {
      return 0;
    }

    // Null, not zero: a backlog with nothing consuming it never drains, and zero would
    // read as "no wait".
    if (processes === 0) {
      return null;
    }

    const { runtime } = await this.metrics.summaryForQueue(name);

    if (!runtime) {
      return null;
    }

    return Math.round((ready * runtime) / processes / 1000);
  }

  /**
   * One entry per worker process, with the supervisors it is running.
   */
  async masters(): Promise<Master[]> {
    const [workers, paused] = await Promise.all([
      this.workers.all(),
      this.workers.paused(),
    ]);

    // Queues some worker actually started on. A queue with no processor is configured
    // but not consumed, and the panel would show it green while it piles up.
    const consumed = new Set(
      workers.flatMap((worker) => Object.keys(worker.slots ?? {})),
    );

    const masters = workers.map((worker) => ({
      id: worker.id,
      hostname: worker.hostname,
      pid: worker.pid,
      startedAt: worker.startedAt,
      supervisors: worker.supervisors.map((name) =>
        this.supervisorView(name, paused, true, consumed),
      ),
    }));

    // A supervisor nobody is running is listed as inactive rather than left out.
    const live = new Set(workers.flatMap((worker) => worker.supervisors));
    const idle = Object.keys(this.options.supervisors).filter((name) => !live.has(name));

    if (idle.length) {
      masters.push({
        id: 'inactive',
        hostname: '—',
        pid: 0,
        startedAt: '',
        supervisors: idle.map((name) => this.supervisorView(name, paused, false)),
      });
    }

    return masters;
  }

  private supervisorView(
    name: string,
    paused: string[],
    running: boolean,
    consumed = new Set<string>(),
  ): SupervisorView {
    const queues = this.options.supervisors[name]?.queues ?? [];

    return {
      name,
      queues,
      unconsumed: queues.filter((queue) => !consumed.has(queue)),
      concurrency: this.options.supervisors[name]?.concurrency ?? 1,
      paused: paused.includes(name),
      running,
    };
  }
}
