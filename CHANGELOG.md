# Changelog

Notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] — 2026-08-22

### Fixed

- A supervisor whose queues all lacked a processor announced itself at boot as though it were
  running, and every supervisor listed the queues it declared rather than the ones it opened.

## [1.0.0] — 2026-08-22

First release.

### Added

- Queues driven by a single config object: supervisors own queues, with concurrency, timeouts and
  job options resolved per supervisor and overridable per environment.
- **Job batches** with `then` / `catch` / `finally` hooks, progress, cancellation, chained jobs,
  and a failure list that can be retried as a whole.
- A **Vue 3 dashboard** served from the package with no build step, behind an auth gate that runs
  before the routes. Listings for pending, active, completed, silenced and failed jobs, batches,
  per-queue and per-job metrics, and a drain forecast per queue.
- **Tags and monitoring**: index a job under a tag and watch it, with failures counted apart.
- **Silenced jobs**: keep noisy successes out of the completed listing without hiding failures.
- `release()`, for work that is not ready rather than work that is broken, bounded by a release
  budget that a payload cannot raise.
- Timeouts that free the slot and tell the handler through `ctx.aborted`, and worker recycling on
  job count, lifetime or heap.
- Structured **failure context** read off the error, and a log of manual retries with their
  outcome.
- **Long-wait alerts** through a callback, raised once per fleet.
- Redis Cluster support, with one hash tag per queue so queues spread across nodes.
- Maintenance operations: pause, resume, terminate, clear a queue, forget failures, clear metrics.
- Age-based retention alongside BullMQ's count-based `removeOnComplete`.

[1.0.1]: https://github.com/dazza-dev/nestjs-sentinel/releases/tag/v1.0.1
[1.0.0]: https://github.com/dazza-dev/nestjs-sentinel/releases/tag/v1.0.0
