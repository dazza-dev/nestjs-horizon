import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { DiscoveryService, Reflector } from '@nestjs/core';
import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import {
  DEFAULT_MAX_RELEASES,
  SENTINEL_OPTIONS,
  SENTINEL_PROCESSOR,
} from '../sentinel.constants';
import type { SentinelOptions, SupervisorOptions } from '../sentinel.types';
import type { JobHandler, ProcessorMetadata } from './processor.decorator';
import { MetricsService } from '../metrics/metrics.service';
import { WorkerRegistry } from './worker-registry.service';
import { abortSignalFor, withTimeout } from './job-timeout';
import { jobContext } from './job-context';
import { WorkerLimitsService } from './worker-limits.service';
import { connectionFor, queuePrefix } from '../sentinel.options';
import { ClientRegistry } from '../redis/client';
import { SilencedService } from '../silenced/silenced.service';
import { RetryLogService } from '../retries/retry-log.service';
import { FailureContextService } from '../failures/failure-context.service';
import { TagsService } from '../tags/tags.service';
import { SentinelEvents } from '../events/sentinel.events';

/**
 * The release budget for one job: its own if the payload declares a usable one, the
 * supervisor's otherwise.
 *
 * A bad value falls back to the configured ceiling, never to the package default, which a
 * job could use to raise a limit the operator set deliberately.
 */
const releaseCap = (job: Job, configured: number): number => {
  const declared = (job.data as { maxReleases?: unknown } | undefined)?.maxReleases;

  return typeof declared === 'number' && Number.isFinite(declared) && declared >= 0
    ? Math.floor(declared)
    : configured;
};

interface WorkerEntry {
  worker: Worker;
  supervisor: string;

  /** Whether `run()` was called. A worker held closed at boot has not been. */
  started: boolean;
}

/**
 * Starts one worker per queue, with the concurrency its supervisor declares.
 */
@Injectable()
export class WorkerManager implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Sentinel');
  private readonly workers: WorkerEntry[] = [];
  private pauseTimer?: NodeJS.Timeout;
  private startedAt = Date.now();
  private checkingPause = false;

  constructor(
    @Inject(SENTINEL_OPTIONS) private readonly options: SentinelOptions,
    private readonly discovery: DiscoveryService,
    private readonly reflector: Reflector,
    private readonly metrics: MetricsService,
    private readonly registry: WorkerRegistry,
    private readonly limits: WorkerLimitsService,
    private readonly tags: TagsService,
    private readonly events: SentinelEvents,
    private readonly clients: ClientRegistry,
    private readonly silencing: SilencedService,
    private readonly retries: RetryLogService,
    private readonly failures: FailureContextService,
  ) {}

  onApplicationBootstrap(): void {
    // Only the worker process consumes; the API just produces.
    if (this.options.worker !== true) {
      return;
    }

    // Redis's clock: a terminate raised on another machine is stamped by the same one.
    void this.registry
      .now()
      .then((now) => {
        this.startedAt = now;
      })
      .catch((error: Error) => {
        // Falls back to the local clock, which skew can make disagree about terminate.
        this.logger.warn(`Could not read the Redis clock: ${error.message}`);
      });

    const handlers = this.discoverHandlers();

    // Only what actually started is announced. The wait forecast divides a backlog by
    // these slots.
    const slots: Record<string, number> = {};
    const running: string[] = [];

    for (const [name, supervisor] of Object.entries(this.options.supervisors)) {
      for (const queue of supervisor.queues) {
        const handler = handlers.get(queue);

        if (!handler) {
          this.logger.warn(`Queue "${queue}" has no processor; jobs will pile up.`);
          continue;
        }

        this.workers.push({
          worker: this.createWorker(queue, handler, supervisor),
          supervisor: name,
          started: false,
        });

        slots[queue] = (slots[queue] ?? 0) + (supervisor.concurrency ?? 1);

        if (!running.includes(name)) {
          running.push(name);
        }
      }

      this.logger.log(
        `${name}: ${supervisor.queues.join(', ')} (concurrency ${supervisor.concurrency ?? 1} per queue)`,
      );
    }

    this.registry.declareRunning(running, slots);

    // Read the flags before opening anything, then follow them from here on.
    void this.startUnpaused()
      .catch((error: Error) => {
        this.logger.error(`Could not read the pause flags: ${error.message}`);

        // Better consuming than stalled: a Redis blink must not idle a worker for good.
        // The watcher below pauses it on the next tick if it should be.
        for (const entry of this.workers) {
          this.open(entry);
        }
      })
      .finally(() => this.watchPauseFlags());
  }

  private async startUnpaused(): Promise<void> {
    const paused = new Set(await this.registry.paused());

    for (const entry of this.workers) {
      if (paused.has(entry.supervisor)) {
        this.logger.warn(`${entry.supervisor} starts paused`);
        continue;
      }

      this.open(entry);
    }
  }

  /** Follows the pause flags the dashboard writes: pausing works without a restart. */
  private watchPauseFlags(): void {
    this.pauseTimer = setInterval(() => {
      void this.applyPauseFlags();
    }, 3000);

    this.pauseTimer.unref();
  }

  private async applyPauseFlags(): Promise<void> {
    // `worker.pause()` waits for the current job, which can take minutes. Without this
    // guard the 3s tick stacks overlapping passes on top of that wait.
    if (this.checkingPause) {
      return;
    }

    this.checkingPause = true;

    try {
      await this.readPauseFlags();
    } catch (error) {
      this.logger.error(`Pause check failed: ${(error as Error).message}`);
    } finally {
      this.checkingPause = false;
    }
  }

  private async readPauseFlags(): Promise<void> {
    if (await this.shouldTerminate()) {
      return;
    }

    const paused = new Set(await this.registry.paused());

    for (const entry of this.workers) {
      const { worker, supervisor } = entry;
      const shouldPause = paused.has(supervisor);

      // A worker held closed at boot was never started, so BullMQ does not consider it
      // paused and `resume()` does nothing. Opening it is the resume.
      if (!shouldPause && !entry.started) {
        this.open(entry);
        this.logger.log(`${supervisor} resumed`);
        this.events.emit('supervisor.resumed', { supervisor });

        continue;
      }

      // A worker that never opened is already not consuming, and pausing it sets the flag
      // that makes a later `run()` return early.
      if (shouldPause && entry.started && !worker.isPaused()) {
        await worker.pause();
        this.logger.warn(`${supervisor} paused`);
        this.events.emit('supervisor.paused', { supervisor });
      }

      if (!shouldPause && worker.isPaused()) {
        await worker.resume();
        this.logger.log(`${supervisor} resumed`);
        this.events.emit('supervisor.resumed', { supervisor });
      }
    }
  }

  /**
   * Honours the `terminate` flag a deploy raises: finish what is in hand and exit,
   * leaving the restart to the process manager. A worker started after the flag was
   * raised ignores it, or a deploy would kill its own replacements.
   */
  private async shouldTerminate(): Promise<boolean> {
    const requestedAt = await this.registry.terminateRequestedAt();

    if (!requestedAt || requestedAt < this.startedAt) {
      return false;
    }

    this.logger.warn('Terminate requested. Draining and exiting.');
    process.kill(process.pid, 'SIGTERM');

    return true;
  }

  /**
   * Maps every queue to the provider that declared it with `@SentinelProcessor`.
   */
  private discoverHandlers(): Map<string, JobHandler> {
    const handlers = new Map<string, JobHandler>();

    for (const wrapper of this.discovery.getProviders()) {
      const instance = wrapper.instance as Partial<JobHandler> | null | undefined;

      if (!instance || typeof instance !== 'object') {
        continue;
      }

      const metadata = this.reflector.get<ProcessorMetadata>(
        SENTINEL_PROCESSOR,
        instance.constructor,
      );

      if (!metadata) {
        continue;
      }

      if (typeof instance.handle !== 'function') {
        throw new Error(
          `${instance.constructor.name} is a @SentinelProcessor but has no handle() method.`,
        );
      }

      handlers.set(metadata.queue, instance as JobHandler);
    }

    return handlers;
  }

  private createWorker(
    queue: string,
    handler: JobHandler,
    supervisor: SupervisorOptions,
  ): Worker {
    const timeout = supervisor.timeoutSeconds ?? this.options.timeoutSeconds;
    const maxReleases =
      supervisor.maxReleases ?? this.options.maxReleases ?? DEFAULT_MAX_RELEASES;

    const worker = new Worker(
      queue,
      // Three parameters: BullMQ hands over the lock token and the abort signal only when
      // the processor's arity asks for them.
      (job: Job, token?: string, signal?: AbortSignal) => {
        // BullMQ's signal fires on shutdown and the timeout raises the same one, so a
        // handler reads `ctx.aborted` without knowing which happened.
        const abort = abortSignalFor(signal);

        return withTimeout(
          handler.handle(
            job,
            jobContext(job, token, abort.signal, releaseCap(job, maxReleases), (delay) =>
              this.events.emit('job.released', {
                queue,
                name: job.name,
                jobId: String(job.id),
                delay,
              }),
            ),
          ),
          timeout,
          () => abort.abort(),
        );
      },
      {
        connection: connectionFor(this.options, this.clients, supervisor),
        prefix: queuePrefix(this.options, queue, supervisor),
        concurrency: supervisor.concurrency ?? 1,

        // Started by hand, once the pause flags have been read. Left to itself a worker
        // consumes for a whole poll interval before the first check.
        autorun: false,
      },
    );

    // BullMQ re-emits connection failures here, and EventEmitter throws any 'error' event
    // left without a listener, taking the host application down with it.
    worker.on('error', (error: Error) => {
      this.logger.error(`${queue}: ${error.message}`);
    });

    // Indexed at the start, not the end. A tag is there to watch a long or stuck job, and
    // that job never reaches 'completed'.
    worker.on('active', (job) => {
      this.record(
        this.tags.index(queue, String(job.id), TagsService.of(job), {
          name: job.name,
          state: 'active',
          tags: TagsService.of(job),
          createdAt: job.timestamp ?? null,
          finishedAt: null,
          runtime: null,
        }),
      );
      // Counted here too, or a job pushed with `queue.add()` rather than `dispatch()`
      // misses the recent-jobs figure. The member is keyed by job id, so the two records
      // collapse into one.
      this.record(
        this.metrics.recordPushed(queue, job.name, String(job.id), job.timestamp),
      );

      this.events.emit('job.started', {
        queue,
        name: job.name,
        jobId: String(job.id),
        attempt: job.attemptsMade + 1,
      });
    });

    worker.on('completed', (job) => {
      const runtime =
        job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : 0;

      this.record(
        this.metrics.recordCompleted(
          queue,
          job.name,
          runtime,
          Date.now(),
          String(job.id),
        ),
      );
      this.record(
        this.tags.index(queue, String(job.id), TagsService.of(job), {
          name: job.name,
          state: 'completed',
          tags: TagsService.of(job),
          createdAt: job.timestamp ?? null,
          finishedAt: job.finishedOn ?? null,
          runtime,
        }),
      );
      // Closes the open entry in the manual-retry log, if someone pressed the button.
      this.record(this.retries.settle(queue, String(job.id), 'completed'));

      // The same job can succeed after failing, and a completed job should not still show
      // the failure it recovered from.
      this.record(this.failures.forget(queue, String(job.id)));

      // Decided once and written down. The completed and silenced listings partition the
      // completions between them.
      if (this.silencing.decide(job)) {
        this.record(this.silencing.record(queue, String(job.id), job.finishedOn));
      }

      this.limits.countJob();
      this.events.emit('job.completed', {
        queue,
        name: job.name,
        jobId: String(job.id),
        runtime,
      });
    });

    worker.on('failed', (job, error) => {
      this.logger.error(`${queue}#${job?.id ?? '?'} failed: ${error.message}`);

      if (job) {
        this.limits.countJob();
      }

      // BullMQ stamps finishedOn only when it is done retrying. Counting attempts instead
      // misses UnrecoverableError and a backoff that returns -1, which stop early with
      // attempts to spare.
      const exhausted = !!job?.finishedOn;

      if (job) {
        const snapshot = {
          name: job.name,
          state: exhausted ? ('failed' as const) : ('pending' as const),
          tags: TagsService.of(job),
          createdAt: job.timestamp ?? null,
          finishedAt: exhausted ? (job.finishedOn ?? null) : null,
          runtime:
            job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : null,
        };

        // Overwrites the monitored copy too, which otherwise still shows the 'active'
        // written when the job started.
        this.record(this.tags.index(queue, String(job.id), snapshot.tags, snapshot));

        if (exhausted) {
          this.record(this.retries.settle(queue, String(job.id), 'failed'));

          this.record(
            this.failures.record(queue, String(job.id), this.failures.read(error)),
          );
          this.record(
            this.metrics.recordFailed(queue, job.name, Date.now(), String(job.id)),
          );
          this.record(
            this.tags.indexFailure(queue, String(job.id), snapshot.tags, snapshot),
          );
        }
      }

      if (job) {
        this.events.emit('job.failed', {
          queue,
          name: job.name,
          jobId: String(job.id),
          error: error.message,
          exhausted,
          attempts: job.attemptsMade,
        });
      }
    });

    return worker;
  }

  /**
   * Opens a worker. `run()` rejects on a fatal loop error, which must never reach Node
   * unhandled.
   */
  private open(entry: WorkerEntry): void {
    entry.started = true;
    entry.worker.run().catch((error: Error) => {
      this.logger.error(`${entry.supervisor} stopped: ${error.message}`);
    });
  }

  /**
   * Bookkeeping must not take the worker down. An unhandled rejection ends the process on
   * modern Node, and one lost metric is not worth the jobs in flight.
   */
  private record(work: Promise<unknown>): void {
    work.catch((error: Error) =>
      this.logger.error(`Bookkeeping failed: ${error.message}`),
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pauseTimer) {
      clearInterval(this.pauseTimer);
    }

    await Promise.all(this.workers.map(({ worker }) => worker.close()));
  }
}
