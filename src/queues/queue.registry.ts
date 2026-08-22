import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import type { Job, JobsOptions } from 'bullmq';
import { SENTINEL_OPTIONS } from '../sentinel.constants';
import type { SentinelOptions } from '../sentinel.types';
import { TagsService } from '../tags/tags.service';
import { SentinelEvents } from '../events/sentinel.events';
import { MetricsService } from '../metrics/metrics.service';
import { connectionFor, queuePrefix } from '../sentinel.options';
import { ClientRegistry } from '../redis/client';

/** Holds one Queue instance per configured queue and hands them out by name. */
@Injectable()
export class QueueRegistry implements OnModuleDestroy {
  private readonly logger = new Logger('Sentinel');
  private readonly queues = new Map<string, Queue>();

  constructor(
    @Inject(SENTINEL_OPTIONS) private readonly options: SentinelOptions,
    private readonly tags: TagsService,
    private readonly events: SentinelEvents,
    private readonly metrics: MetricsService,
    clients: ClientRegistry,
  ) {
    const owner = new Map<string, string | undefined>();

    for (const [label, supervisor] of Object.entries(options.supervisors)) {
      for (const name of supervisor.queues) {
        if (this.queues.has(name)) {
          // Two supervisors on one queue adds processes to it; two on different
          // connections is a typo, and only one of them would receive the work.
          if (owner.get(name) !== supervisor.connection) {
            throw new Error(
              `Queue "${name}" is declared in supervisor "${label}" on connection ` +
                `"${supervisor.connection ?? 'default'}", and elsewhere on ` +
                `"${owner.get(name) ?? 'default'}". A queue lives on one connection.`,
            );
          }

          continue;
        }

        owner.set(name, supervisor.connection);

        this.queues.set(
          name,
          new Queue(name, {
            connection: connectionFor(options, clients, supervisor),
            prefix: queuePrefix(options, name, supervisor),
            defaultJobOptions: {
              ...options.defaultJobOptions,
              ...supervisor.defaultJobOptions,
            },
          }),
        );
      }
    }
  }

  /** Every queue name, in the order the supervisors declare them. */
  names(): string[] {
    return [...this.queues.keys()];
  }

  all(): Queue[] {
    return [...this.queues.values()];
  }

  /** Returns the queue, or throws when it is not declared in any supervisor. */
  get(name: string): Queue {
    const queue = this.queues.get(name);

    if (!queue) {
      // Reachable from a query parameter, so BadRequest: the dashboard asking for a queue
      // that is not configured is bad input, not a broken server.
      throw new BadRequestException(
        `Queue "${name}" is not declared in any supervisor. Add it to the Sentinel config.`,
      );
    }

    return queue;
  }

  /**
   * Adds a job and indexes its tags. Calling `get(queue).add(...)` still works; the tags
   * of a job pushed that way are only indexed once a worker picks it up.
   */
  async dispatch(
    queue: string,
    name: string,
    data: Record<string, unknown>,
    opts?: JobsOptions,
  ): Promise<Job> {
    const job = await this.get(queue).add(name, data, opts);

    // The job is already enqueued; a failure indexing it must not make the caller
    // believe the dispatch failed and send it twice.
    await this.tags
      .index(queue, String(job.id), TagsService.of(job))
      .catch((error: Error) =>
        this.logger.error(`Could not index tags: ${error.message}`),
      );

    // Counted on the way in; the dashboard's recent-jobs card reports this number.
    await this.metrics
      .recordPushed(queue, name, String(job.id))
      .catch((error: Error) =>
        this.logger.error(`Could not count job: ${error.message}`),
      );

    this.events.emit('job.pushed', { queue, name, jobId: String(job.id) });

    return job;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.all().map((queue) => queue.close()));
  }
}
