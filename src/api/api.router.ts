import { BadRequestException, HttpException, Injectable } from '@nestjs/common';
import { Router, type Request, type Response } from 'express';
import { StatsService } from '../stats/stats.service';
import { MetricsService } from '../metrics/metrics.service';
import { WorkerRegistry } from '../worker/worker-registry.service';
import { BatchService } from '../batch/batch.service';
import { JobsService } from './jobs.service';
import { TagsService } from '../tags/tags.service';
import { MaintenanceService } from '../maintenance/maintenance.service';

/** Express 5 types a route param as string | string[]; ours are always single values. */
const param = (req: Request, name: string): string => String(req.params[name] ?? '');

/**
 * A query value is trusted only when it arrives as a string. `?search[x]=y` parses into
 * an object, which would reach the services as `[object Object]`.
 */
const query = (req: Request, name: string): string => {
  const value = req.query[name];

  return typeof value === 'string' ? value : '';
};

/** A whole number from the query string, clamped to `min..max`, or the fallback. */
const num = (
  req: Request,
  name: string,
  fallback: number,
  max = 200,
  min = 0,
): number => {
  const value = Number(query(req, name));

  if (!Number.isInteger(value) || value < min) {
    return fallback;
  }

  return Math.min(value, max);
};

/** A zero-based page number, with no ceiling of its own. */
const page = (req: Request): number => num(req, 'page', 0, Number.MAX_SAFE_INTEGER);

/**
 * A page size, never zero: these become Redis ranges, and `perPage=0` asks for `0..-1`,
 * the whole index in one response.
 */
const perPage = (req: Request, fallback: number): number =>
  num(req, 'perPage', fallback, 200, 1);

/** A tag, free text but never empty: the empty tag is un-listable. */
const tag = (req: Request): string => {
  const value = query(req, 'tag');

  if (!value) {
    throw new BadRequestException('A tag is required.');
  }

  return value;
};

/**
 * The REST API the dashboard talks to. It sits behind the same gate as the UI: access is
 * decided in one place.
 */
@Injectable()
export class ApiRouter {
  constructor(
    private readonly stats: StatsService,
    private readonly metrics: MetricsService,
    private readonly workers: WorkerRegistry,
    private readonly batches: BatchService,
    private readonly jobs: JobsService,
    private readonly tags: TagsService,
    private readonly maintenance: MaintenanceService,
  ) {}

  build(): Router {
    const router = Router();

    // Errors become JSON instead of an HTML stack trace in the middle of the UI.
    const wrap =
      (handler: (req: Request, res: Response) => Promise<unknown>) =>
      (req: Request, res: Response) => {
        handler(req, res)
          .then((body) => {
            if (!res.headersSent) {
              res.json(body);
            }
          })
          .catch((error: Error) => {
            // A missing job is a 404, not a server error. The screens read the status to
            // tell "gone" from "broken".
            const status = error instanceof HttpException ? error.getStatus() : 500;

            res.status(status).json({ message: error.message });
          });
      };

    router.get(
      '/stats',
      wrap(() => this.stats.dashboard()),
    );
    router.get(
      '/workload',
      wrap(() => this.stats.workload()),
    );
    router.get(
      '/masters',
      wrap(() => this.stats.masters()),
    );

    router.post(
      '/supervisors/:name/pause',
      wrap(async (req) => {
        await this.workers.pause(param(req, 'name'));

        return { paused: true };
      }),
    );

    router.post(
      '/supervisors/:name/resume',
      wrap(async (req) => {
        await this.workers.resume(param(req, 'name'));

        return { paused: false };
      }),
    );

    router.get(
      '/metrics/queues',
      wrap(async () => {
        const names = await this.metrics.measuredQueues();

        return Promise.all(
          names.map(async (name) => ({
            name,
            ...(await this.metrics.summaryForQueue(name)),
          })),
        );
      }),
    );

    router.get(
      '/metrics/queues/:name',
      wrap(async (req) => ({
        name: param(req, 'name'),
        measurement: await this.metrics.measurementForQueue(param(req, 'name')),
        snapshots: await this.metrics.snapshotsForQueue(param(req, 'name')),
      })),
    );

    router.get(
      '/metrics/jobs',
      wrap(async () => {
        const names = await this.metrics.measuredJobs();

        return Promise.all(
          names.map(async (name) => ({
            name,
            ...(await this.metrics.summaryForJob(name)),
          })),
        );
      }),
    );

    router.get(
      '/metrics/jobs/:name',
      wrap(async (req) => ({
        name: param(req, 'name'),
        measurement: await this.metrics.measurementForJob(param(req, 'name')),
        snapshots: await this.metrics.snapshotsForJob(param(req, 'name')),
      })),
    );

    router.get(
      '/batches',
      wrap((req) =>
        this.batches.list({
          search: query(req, 'search'),
          page: page(req),
          perPage: perPage(req, 25),
        }),
      ),
    );

    router.get(
      '/batches/:id/failed',
      wrap(async (req) => {
        const refs = await this.batches.failedJobs(param(req, 'id'));
        const at = page(req);
        const size = perPage(req, 10);
        const slice = refs.slice(at * size, (at + 1) * size);

        const jobs = await Promise.all(
          slice.map(async (ref) => {
            try {
              return await this.jobs.find(ref.queue, ref.jobId);
            } catch {
              // The job may have aged out of its queue while the batch record lives on.
              return { ...ref, id: ref.jobId, missing: true };
            }
          }),
        );

        return { jobs, total: refs.length };
      }),
    );

    router.get(
      '/batches/:id',
      wrap(async (req, res) => {
        const batch = await this.batches.find(param(req, 'id'));

        if (!batch) {
          res.status(404).json({ message: 'Batch not found.' });

          return;
        }

        return batch;
      }),
    );

    router.post(
      '/batches/:id/retry',
      wrap(async (req) => {
        const refs = await this.batches.failedJobs(param(req, 'id'));
        let retried = 0;

        for (const ref of refs) {
          try {
            await this.jobs.retry(ref.queue, ref.jobId);
            await this.batches.recordRetry(param(req, 'id'));
            retried += 1;
          } catch {
            // Gone from its queue, or no longer failed. Neither stops the rest.
          }
        }

        return { retried };
      }),
    );

    router.post(
      '/batches/:id/cancel',
      wrap(async (req) => {
        await this.batches.cancel(param(req, 'id'));

        return { cancelled: true };
      }),
    );

    router.get(
      '/status',
      wrap(() => this.maintenance.status()),
    );

    router.post(
      '/pause',
      wrap(async () => ({ paused: await this.maintenance.pauseAll() })),
    );

    router.post(
      '/resume',
      wrap(async () => {
        await this.maintenance.resumeAll();

        return { paused: [] };
      }),
    );

    router.post(
      '/terminate',
      wrap(async () => {
        await this.maintenance.terminate();

        return { terminating: true };
      }),
    );

    router.delete(
      '/metrics',
      wrap(async () => {
        await this.maintenance.clearMetrics();

        return { cleared: true };
      }),
    );

    router.delete(
      '/queues/:name/jobs',
      wrap(async (req) => ({
        cleared: await this.maintenance.clear(param(req, 'name')),
      })),
    );

    router.delete(
      '/jobs/failed',
      wrap(async (req) => ({
        removed: await this.maintenance.forgetFailed(query(req, 'queue') || undefined),
      })),
    );

    router.get(
      '/monitoring',
      wrap(() => this.tags.monitoredWithCounts()),
    );

    // The tag travels in the query string: it is free text and may contain slashes.
    router.post(
      '/monitoring',
      wrap(async (req) => {
        await this.tags.monitor(tag(req));

        return { monitored: true };
      }),
    );

    router.delete(
      '/monitoring',
      wrap(async (req) => {
        await this.tags.stopMonitoring(tag(req));

        return { monitored: false };
      }),
    );

    router.get(
      '/monitoring/jobs',
      wrap(async (req) => {
        const { refs, total } = await this.tags.jobsFor(
          query(req, 'tag'),
          query(req, 'type') === 'failed' ? 'failed' : 'jobs',
          page(req),
          perPage(req, 25),
        );

        return { jobs: await this.jobs.findMany(refs), total };
      }),
    );

    router.post(
      '/jobs/retry-all',
      wrap(async (req) => ({
        retried: await this.jobs.retryAll(query(req, 'queue') || undefined),
      })),
    );

    router.post(
      '/jobs/:queue/:id/retry',
      wrap(async (req) => {
        await this.jobs.retry(param(req, 'queue'), param(req, 'id'));

        return { retried: true };
      }),
    );

    router.delete(
      '/jobs/:queue/:id',
      wrap(async (req) => {
        await this.jobs.remove(param(req, 'queue'), param(req, 'id'));

        return { removed: true };
      }),
    );

    router.get(
      '/jobs/:listing',
      wrap(async (req, res) => {
        const listing = param(req, 'listing');

        if (!JobsService.isListing(listing)) {
          res.status(404).json({ message: `Unknown listing "${listing}".` });

          return;
        }

        // Filtering failures by tag reads the index instead of the scanned window: it
        // covers the whole retention period.
        const filter = query(req, 'tag');

        if (listing === 'failed' && filter) {
          const { refs, total } = await this.tags.jobsFor(
            filter,
            'failed',
            page(req),
            perPage(req, 25),
          );

          return { jobs: await this.jobs.findMany(refs), total };
        }

        return this.jobs.list(listing, {
          queue: query(req, 'queue') || undefined,
          search: query(req, 'search'),
          page: page(req),
          perPage: perPage(req, 25),
        });
      }),
    );

    router.get(
      '/jobs/:queue/:id',
      wrap((req) => this.jobs.find(param(req, 'queue'), param(req, 'id'))),
    );

    return router;
  }
}
