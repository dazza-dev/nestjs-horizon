import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Job, JobState } from 'bullmq';
import { Redis } from 'ioredis';
import { SENTINEL_OPTIONS, SENTINEL_REDIS } from '../sentinel.constants';
import type { SentinelOptions } from '../sentinel.types';
import { QueueRegistry } from '../queues/queue.registry';
import { MetricsService } from '../metrics/metrics.service';
import { SilencedService } from '../silenced/silenced.service';
import { SentinelEvents } from '../events/sentinel.events';
import { RetryLogService } from '../retries/retry-log.service';
import { FailureContextService } from '../failures/failure-context.service';
import type { FailureContext } from '../failures/failure-context.service';
import type { ManualRetry } from '../retries/retry-log.service';
import { TagsService } from '../tags/tags.service';
import type { TaggedJobRef } from '../tags/tags.service';
import { resolvePrefix } from '../sentinel.options';

export interface JobView {
  id: string;
  queue: string;
  name: string;
  state: string;
  /** Times this job has been picked up, failures and releases alike. */
  attempts: number;
  data: unknown;

  /** Explicit tags from the job payload. */
  tags: string[];
  failedReason?: string;
  stacktrace?: string[];

  /** One entry per attempt, oldest first. BullMQ appends a trace on every failure. */
  attemptTraces: string[];

  /** When someone pressed Retry. Automatic retries are not in here. */
  manualRetries: ManualRetry[];

  /** Error metadata. Populated on the job detail only. */
  context?: FailureContext | null;
  createdAt: number | null;
  startedAt: number | null;
  finishedAt: number | null;

  /** When a delayed job becomes due, or null when it is not scheduled. */
  scheduledFor: number | null;
  runtime: number | null;
}

export interface JobPage {
  jobs: JobView[];
  total: number;

  /** Rows this listing can page through, when the merge window holds fewer than `total`. */
  reachable?: number;
}

/** The listings the dashboard offers, mapped onto BullMQ's own states. */
export const LISTINGS = {
  /**
   * Waiting to run, whatever is holding them.
   *
   * BullMQ keeps a job given a `priority` in its own set, and the workload figure counts
   * it. Leaving `prioritized` out would have the two disagree.
   */
  pending: ['waiting', 'prioritized', 'delayed', 'paused'],
  active: ['active'],
  completed: ['completed'],
  failed: ['failed'],

  /**
   * Silenced jobs: successes moved out of the way.
   *
   * Completed only. Silencing hides noise, not errors; a silenced job that failed stays
   * in the failed listing.
   */
  silenced: ['completed'],
} as const;

export type Listing = keyof typeof LISTINGS;

/**
 * How many jobs per queue a search scans. Jobs beyond this are not searched; raise it
 * only alongside `removeOnComplete` / `removeOnFail`, which bound what Redis keeps.
 */
const SEARCH_WINDOW = 1000;

/** Failed jobs pulled per round when retrying a whole queue. */
const RETRY_CHUNK = 100;

/**
 * Reads jobs out of the queues for the dashboard listings.
 */
@Injectable()
export class JobsService {
  private readonly prefix: string;

  constructor(
    @Inject(SENTINEL_OPTIONS) options: SentinelOptions,
    @Inject(SENTINEL_REDIS) private readonly redis: Redis,
    private readonly queues: QueueRegistry,
    private readonly metrics: MetricsService,
    private readonly silencing: SilencedService,
    private readonly events: SentinelEvents,
    private readonly retries: RetryLogService,
    private readonly failures: FailureContextService,
  ) {
    this.prefix = resolvePrefix(options);
  }

  /**
   * One page of jobs in the given state, newest first, across every queue or just one.
   */
  async list(
    listing: Listing,
    {
      queue,
      search = '',
      page = 0,
      perPage = 25,
    }: { queue?: string; search?: string; page?: number; perPage?: number },
  ): Promise<JobPage> {
    const names = queue ? [queue] : this.queues.names();
    const states = [...LISTINGS[listing]] as JobState[];
    const needle = search.trim().toLowerCase();

    // `perPage` of zero becomes the Redis range `0..-1`: the whole queue. The router
    // clamps too, but this class is exported and callable directly.
    page = Number.isInteger(page) && page > 0 ? page : 0;
    perPage = Number.isInteger(perPage) && perPage > 0 ? Math.min(perPage, 200) : 25;

    // The silenced listing is its own index, not a filter over the completed one. An
    // unfiltered read has no ceiling; a search still scans at most `SEARCH_WINDOW`.
    if (listing === 'silenced') {
      // Search before the slice. Otherwise the footer counts matches on this page only,
      // and a match on page 2 makes page 1 report none.
      const wide = needle
        ? await this.silencing.page(0, SEARCH_WINDOW, queue)
        : await this.silencing.page(page, perPage, queue);

      const resolved = await Promise.all(
        wide.refs.map(async (ref) => ({
          ref,
          job: await this.find(ref.queue, ref.jobId).catch(() => null),
        })),
      );

      // `removeOnComplete` drops finished jobs silently; no write can keep the index in
      // step. It heals as it is read.
      const gone = resolved.filter((entry) => !entry.job).map((entry) => entry.ref);

      await Promise.all(gone.map((ref) => this.silencing.forget(ref.queue, ref.jobId)));

      const jobs = resolved
        .map((entry) => entry.job)
        .filter((job): job is JobView => job !== null);

      if (!needle) {
        return {
          jobs,
          total: Math.max(jobs.length, wide.total - gone.length),
          reachable: wide.reachable,
        };
      }

      const matched = jobs.filter((job) => this.matches(job, needle));

      return {
        jobs: matched.slice(page * perPage, (page + 1) * perPage),
        total: matched.length,
      };
    }

    const hiding = listing === 'completed';

    // Jobs that already ran, ordered by when they finished.
    const terminal = listing === 'completed' || listing === 'failed';

    // Scanning wide costs a thousand jobs per queue on every poll. Only a search pays
    // it; everything else reads at its own offset.
    const filtering = needle !== '';

    // A single queue needs no merge and pages at constant cost. Single state only:
    // `getJobs` applies the range once per state and concatenates, which would return
    // perPage rows each and skip whole pages.
    if (names.length === 1 && !filtering && !hiding && states.length === 1) {
      const q = this.queues.get(names[0]);
      const from = page * perPage;
      const jobs = await q.getJobs(states, from, from + perPage - 1);

      return {
        jobs: jobs.map((job) => this.toView(job, names[0], listing)),
        total: await q.getJobCountByTypes(...states),
      };
    }

    const collected: JobView[] = [];
    let total = 0;

    // Whether any queue was read through the bounded window rather than at its own offset.
    let bounded = false;

    for (const name of names) {
      const q = this.queues.get(name);

      total += await q.getJobCountByTypes(...states);

      // A partial read needs the native order to match the sort below, and BullMQ orders
      // the delayed set by due date, not by age. Asked of the queue rather than of the
      // listing, which names `delayed` whether or not any exist.
      const partial =
        !filtering &&
        !hiding &&
        (!states.includes('delayed') || !(await q.getDelayedCount()));

      if (!partial) {
        bounded = true;
      }

      const upTo = Math.min(
        partial ? (page + 1) * perPage : SEARCH_WINDOW,
        SEARCH_WINDOW,
      );
      const jobs = await q.getJobs(states, 0, upTo - 1);

      collected.push(...jobs.map((job) => this.toView(job, name, listing)));
    }

    // Newest first, matching the order the single-queue path returns: filtering by queue
    // must not reorder the same rows.
    const at = (job: JobView): number =>
      (terminal ? (job.finishedAt ?? job.createdAt) : job.createdAt) ?? 0;

    collected.sort((a, b) => at(b) - at(a));

    if (hiding) {
      const quiet = await this.silencing.members();
      const kept = collected.filter((job) => !quiet.has(`${job.queue}:${job.id}`));

      collected.length = 0;
      collected.push(...kept);

      // Counted from the index, not from what the window reached, and clamped to the rows
      // on screen: a drifted count must not leave a footer smaller than the page.
      total = Math.max(
        collected.length,
        Math.max(0, total - (await this.silencing.count(queue))),
      );
    }

    if (needle) {
      const matched = collected.filter((job) => this.matches(job, needle));

      return {
        jobs: matched.slice(page * perPage, (page + 1) * perPage),
        total: matched.length,
      };
    }

    return {
      jobs: collected.slice(page * perPage, (page + 1) * perPage),
      total,

      // Only a bounded read has a ceiling. A partial one asks for more on every page, and
      // its `collected.length` describes this request rather than the size of the listing.
      reachable: bounded ? Math.min(total, collected.length) : undefined,
    };
  }

  /** Whether a name is one of the listings, without inheriting Object's own keys. */
  static isListing(name: string): name is Listing {
    return Object.hasOwn(LISTINGS, name);
  }

  /**
   * Resolves a list of queue/id pairs, falling back to the stored copy of any whose job
   * the queue has already trimmed.
   */
  async findMany(refs: TaggedJobRef[]): Promise<JobView[]> {
    const jobs = await Promise.all(
      refs.map(async (ref) => {
        try {
          return await this.find(ref.queue, ref.jobId);
        } catch {
          // Trimmed from the queue: fall back to the copy taken when it was indexed. A
          // monitored tag that counts a job must be able to show it.
          return ref.snapshot ? this.fromSnapshot(ref) : null;
        }
      }),
    );

    return jobs.filter((job): job is JobView => job !== null);
  }

  private fromSnapshot(ref: TaggedJobRef): JobView {
    const snapshot = ref.snapshot!;

    return {
      id: ref.jobId,
      queue: ref.queue,
      name: snapshot.name,
      state: snapshot.state,
      attempts: 0,
      data: {},
      tags: snapshot.tags,
      attemptTraces: [],
      manualRetries: [],
      createdAt: snapshot.createdAt,
      scheduledFor: null,
      startedAt: null,
      finishedAt: snapshot.finishedAt,
      runtime: snapshot.runtime,
    };
  }

  async find(queue: string, id: string): Promise<JobView> {
    const job = await this.queues.get(queue).getJob(id);

    if (!job) {
      throw new NotFoundException(`Job ${id} not found in queue ${queue}.`);
    }

    // getState is the authoritative answer; the listings only know the bucket they queried.
    const [state, manualRetries, context] = await Promise.all([
      job.getState(),
      this.retriesOf(queue, id),
      this.failures.of(queue, id),
    ]);

    return { ...this.toView(job, queue, state, manualRetries), context };
  }

  async retriesOf(queue: string, id: string): Promise<ManualRetry[]> {
    return this.retries.of(queue, id);
  }

  /**
   * Puts a failed job back on its queue.
   */
  async retry(queue: string, id: string): Promise<void> {
    const job = await this.queues.get(queue).getJob(id);

    if (!job) {
      throw new NotFoundException(`Job ${id} not found in queue ${queue}.`);
    }

    if (!(await job.isFailed())) {
      throw new BadRequestException(
        `Job ${id} in queue ${queue} is not failed, so there is nothing to retry.`,
      );
    }

    // Reset the counters, or a job that exhausted its attempts gets just one more.
    await job.retry('failed', {
      resetAttemptsMade: true,
      resetAttemptsStarted: true,
    });

    // BullMQ re-queues the same job; nothing distinguishes a manual retry from an
    // automatic one. This is the only record that someone pressed the button.
    const count = await this.retries.record(queue, id);

    // The member needs the retry count. BullMQ re-runs the same job id, and a queue that
    // lives on retries would otherwise report no traffic.
    await this.metrics.recordPushed(queue, job.name, `${id}:retry:${count}`);
  }

  async remove(queue: string, id: string): Promise<void> {
    const job = await this.queues.get(queue).getJob(id);

    if (!job) {
      throw new NotFoundException(`Job ${id} not found in queue ${queue}.`);
    }

    await job.remove();
    await this.retries.forget(queue, id);
    await this.failures.forget(queue, id);
    await this.silencing.forget(queue, id);

    this.events.emit('job.deleted', { queue, name: job.name, jobId: id });
  }

  /**
   * Retries every failed job in a queue, or in all of them.
   */
  async retryAll(queue?: string): Promise<number> {
    const names = queue ? [queue] : this.queues.names();
    let retried = 0;

    for (const name of names) {
      const q = this.queues.get(name);

      // In chunks, and always from the start: retried jobs leave the failed set. `seen`
      // stops the loop if one of them refuses to move.
      const seen = new Set<string>();

      for (;;) {
        const jobs = await q.getJobs(['failed'], 0, RETRY_CHUNK - 1);
        const fresh = jobs.filter((job) => !seen.has(String(job.id)));

        if (!fresh.length) {
          break;
        }

        for (const job of fresh) {
          seen.add(String(job.id));

          try {
            await this.retry(name, String(job.id));
            retried += 1;
          } catch {
            // Someone else retried or removed it between the read and here. Skipping it
            // beats abandoning the rest of the queue.
          }
        }
      }
    }

    return retried;
  }

  /** What a free-text search looks at: the job, its queue and its tags. */
  private matches(job: JobView, needle: string): boolean {
    return (
      job.name.toLowerCase().includes(needle) ||
      job.id.toLowerCase().includes(needle) ||
      job.queue.toLowerCase().includes(needle) ||
      job.tags.some((tag) => tag.toLowerCase().includes(needle))
    );
  }

  private toView(
    job: Job,
    queue: string,
    state?: string,
    manualRetries: ManualRetry[] = [],
  ): JobView {
    const runtime =
      job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : null;

    return {
      id: String(job.id),
      queue,
      name: job.name,
      tags: TagsService.of(job),
      state:
        state ??
        (job.finishedOn ? (job.failedReason ? 'failed' : 'completed') : 'pending'),
      // Times the job has run, not times it has failed. A job that keeps releasing itself
      // shows a rising number.
      attempts: job.attemptsStarted || job.attemptsMade,
      data: job.data,
      failedReason: job.failedReason,
      stacktrace: job.stacktrace ?? undefined,
      attemptTraces: job.stacktrace ?? [],
      manualRetries,
      createdAt: job.timestamp ?? null,
      startedAt: job.processedOn ?? null,
      finishedAt: job.finishedOn ?? null,

      scheduledFor:
        job.delay && job.timestamp && !job.finishedOn ? job.timestamp + job.delay : null,
      runtime,
    };
  }
}
