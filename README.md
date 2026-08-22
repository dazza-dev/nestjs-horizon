<p align="center">
  <img src="https://raw.githubusercontent.com/dazza-dev/nestjs-sentinel/main/assets/logo.svg" width="84" height="84" alt="" />
</p>

<h1 align="center">nestjs-sentinel</h1>

<p align="center">
  Redis-backed queues, <strong>job batches</strong> and a dashboard for NestJS,<br />
  driven by a single config object.
</p>

<p align="center">
  <a href="https://github.com/dazza-dev/nestjs-sentinel/actions/workflows/ci.yml"><img src="https://github.com/dazza-dev/nestjs-sentinel/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/nestjs-sentinel"><img src="https://img.shields.io/npm/v/nestjs-sentinel.svg" alt="npm" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT" /></a>
</p>

A sentinel watches the queues: what is waiting, what is running, what broke, and how long each queue
needs to drain. You declare supervisors and queues in configuration, guard the dashboard with a
callback, and group jobs into batches with `then` / `catch` / `finally` hooks.

Built on [BullMQ](https://docs.bullmq.io/), and inspired by
[Laravel Horizon](https://laravel.com/docs/horizon).

<p align="center">
  <img
    src="https://raw.githubusercontent.com/dazza-dev/nestjs-sentinel/main/assets/dashboard.jpeg"
    alt="The Sentinel dashboard: throughput and failure counters, a table of queues with their backlog, delayed jobs, processes and how long each needs to drain, and the worker with its supervisors"
    width="960"
  />
</p>

---

## Why

BullMQ already gives you queues, retries and priorities. What it leaves to you is everything around
them:

- **Configuration instead of decorators.** Concurrency belongs to the supervisor that owns the queue,
  not to a literal inside a class, so you can tune it per environment without touching code.
- **Batches.** BullMQ Flows can express "run this when those finish", but there is no batch to ask
  about: no progress, no failure count, no cancellation. This package adds one.
- **A guarded dashboard.** Mounting a queue UI is easy; mounting it _behind an auth gate that
  actually runs first_ is where people get it wrong and publish every job payload.
- **Numbers worth acting on.** Throughput and runtime per queue and per job name, a forecast of how
  long each queue needs to drain, and an alert when one falls behind.

## Install

```bash
npm install nestjs-sentinel bullmq ioredis
```

`bullmq` and `ioredis` are peer dependencies, so you control their versions.

The dashboard and its API are mounted on Express, so they need `@nestjs/platform-express` — Nest's
default adapter. Under Fastify set `board.enabled: false`; queues, batches and workers are
unaffected.

Needs NestJS 11, BullMQ 6, ioredis 6 and Node 22 or newer. The ranges are narrow on purpose:
they are the versions the test suite runs against, and BullMQ 5 in particular lacks two APIs
this package relies on — `RetryOptions.resetAttemptsMade`, so a manual retry could not hand a
job its attempts back, and the processor's abort signal.

## See it running

With a Redis on hand, `demo.ts` boots the whole thing against database 13 and fills it: three
supervisors, jobs that succeed and fail, batches that finish and batches that hang on a failure,
monitored tags, silenced jobs and a trickle of new work so the numbers move.

```bash
pnpm demo   # then open http://127.0.0.1:3333/sentinel
```

Its gate is open, which is fine on a laptop and is the one thing not to copy into an application.

## Quick start

### 1. Configure

One object holds everything:

```ts
// sentinel.config.ts
import { basicAuth, type SentinelOptions } from 'nestjs-sentinel';

export const sentinelOptions = (worker: boolean): SentinelOptions => ({
  // Individual fields, or a url — `rediss://` turns on TLS. An explicit field wins over
  // the url, so you can point at another database without rewriting the string.
  connection: { host: '127.0.0.1', port: 6379 },

  // Whether this process consumes jobs. Keep it false in the API.
  worker,

  supervisors: {
    'supervisor-fast': {
      queues: ['default', 'mail', 'notifications'],
      concurrency: 5,
    },
    'supervisor-heavy': {
      queues: ['reports'],
      concurrency: 1,
    },
  },

  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
  },

  board: {
    path: '/sentinel',
    auth: basicAuth({
      username: 'ops',
      password: process.env.SENTINEL_PASSWORD!,
    }),
  },
});
```

### 2. Register the module

```ts
@Module({
  imports: [SentinelModule.forRoot(sentinelOptions(false))],
})
export class AppModule {}
```

> **If your config reads `process.env`, use `forRootAsync`.** `forRoot` evaluates its argument when
> the module file is imported, which happens _before_ `ConfigModule` loads your `.env`. The symptom
> is nasty: everything starts fine and the workers quietly listen on the wrong Redis database.
>
> ```ts
> SentinelModule.forRootAsync({
>   imports: [ConfigModule],
>   useFactory: () => sentinelOptions(false),
> });
> ```

### 3. Mount the dashboard

```ts
// main.ts
const app = await NestFactory.create(AppModule);

// Keep the dashboard out of your API prefix: it is not part of your API.
app.setGlobalPrefix('api/v1', { exclude: ['sentinel', 'sentinel/*path'] });

setupSentinelBoard(app);

await app.listen(3000);
```

### 4. Write a processor

```ts
@SentinelProcessor('reports')
export class BuildReport implements JobHandler {
  async handle(job: Job) {
    // ...
  }
}
```

### 5. Run the worker

The worker is a separate process. Your API produces jobs;
it
should not compete with them for CPU.

```ts
// worker.ts
import 'dotenv/config';

@Module({
  imports: [SentinelModule.forRoot(sentinelOptions(true)), ProcessorsModule],
})
class WorkerModule {}

const app = await NestFactory.createApplicationContext(WorkerModule);

// Required: without it the workers never drain on SIGTERM, so a deploy, a
// `terminate()` or a `workerLimits` retirement drops whatever was running.
app.enableShutdownHooks();
```

```bash
nest start --entryFile worker
```

> **Run the worker through the Nest compiler, not `tsx` or `ts-node` with esbuild.** esbuild does not
> emit `emitDecoratorMetadata`, so Nest sees constructors with no parameters and injects nothing. The
> failure shows up at runtime as an undefined dependency inside a processor, not at startup.

---

## Batches

The reason this package exists. Dispatch a group of jobs and follow it as one unit:

```ts
const batch = await this.batches.dispatch({
  name: 'Monthly reports',
  jobs: customers.map((c) => ({
    queue: 'reports',
    name: 'report',
    data: { id: c.id },
  })),

  then: { queue: 'default', name: 'reports-done' },
  catch: { queue: 'default', name: 'reports-failed' },
  finally: { queue: 'default', name: 'reports-closed' },
});

await this.batches.find(batch.id);
// { id, name, totalJobs, pendingJobs, processedJobs, failedJobs, skippedJobs,
//   cancelled, cancelledAt, finished, finishedAt, allowFailures, progress, createdAt }

await this.batches.cancel(batch.id);
```

The rules:

| Hook      | When it runs                                                  |
| --------- | ------------------------------------------------------------- |
| `then`    | every job finished and none failed                            |
| `catch`   | on the **first** failure, whether or not failures are allowed |
| `finally` | always, once the batch is done                                |

By default one failure cancels the jobs still pending. Pass `allowFailures: true` to let the batch
run to the end.

### Chaining jobs inside a batch

Batch jobs run in parallel. Nest an array to run those particular jobs **one after another**,
— the next link is only queued once the previous
one finished:

```ts
await this.batches.dispatch({
  name: 'Export',
  jobs: [
    sendNotice, // runs in parallel
    [chunk1, chunk2, chunk3], // strictly sequential
  ],
});
```

Use it when the steps would step on each other: chunks appended to the same spreadsheet, migrations
that must keep their order, anything writing to one shared resource.

A chain counts towards `totalJobs` in full even though only its first link is queued. If a link
fails or the batch is cancelled, the rest of that chain never runs and is written off, so the batch
still reaches `finished` instead of hanging at a pending count that can never drop.

### Cancellation

`BatchedProcessor` checks the batch before every job and skips it when the batch was cancelled, so
you do not have to write that check in each job.

A job already running is not interrupted. For a long `process()`, check between steps:

```ts
protected async process(job: Job<ExportData>) {
  for (const row of job.data.rows) {
    if (await this.cancelled(job)) return;   // like $this->batch()->cancelled()
    await write(row);
  }
}
```

**Callbacks are jobs, not closures.** A function cannot be serialized into Redis, so each hook
declares the queue and job name to enqueue.

### Processors that take part in a batch

Extend `BatchedProcessor` and write `process()`. The base class does the bookkeeping — counting
successes and failures, and skipping the job when the batch was cancelled:

The payload type extends `BatchedJobData`, which is what carries `batchId` and the chain:

```ts
interface ReportData extends BatchedJobData {
  id: number;
}

@SentinelProcessor('reports')
export class BuildReport extends BatchedProcessor<ReportData> {
  constructor(batches: BatchService) {
    super(batches);
  }

  protected async process(job: Job<ReportData>) {
    return generate(job.data.id);
  }
}
```

A failure is recorded **only on the last attempt**, so retries do not corrupt the counters.

### How the state is stored

Batch state lives in a Redis hash and the counters move with `HINCRBY`, which is atomic: two workers
finishing at the same moment cannot both see the batch as complete. State expires after seven days
by
default (`batchTtlSeconds`).

---

## Dashboard

A Vue 3 dashboard, served from the package with no build step on your side.

| Screen     | What it shows                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Dashboard  | Jobs per minute, jobs past hour, failures past week, processes, busiest queues, per-queue backlog and wait, and the supervisors with pause/resume |
| Monitoring | Tags being watched and the jobs collected under each                                                                                             |
| Metrics    | Throughput and average runtime per queue and per job, with a chart of the snapshot series                                                         |
| Batches    | Every batch with its progress, failures and status, and a cancel button on the detail                                                            |
| Jobs       | Pending, active, completed, silenced and failed listings, with retry, retry-all and delete                                                       |

Mount it in `bootstrap()`:

```ts
const app = await NestFactory.create(AppModule);

// Keep it out of your API prefix: the dashboard is not part of your API.
app.setGlobalPrefix('api/v1', { exclude: ['sentinel', 'sentinel/*path'] });

setupSentinelBoard(app);
```

Top right there is a system / dark / light switch, cycling in that order and
remembering the choice in `localStorage`. In system mode it follows the OS and reacts when the OS
changes. The scheme is applied before the bundle loads, so there is no flash of the wrong theme.

Next to it sits **auto load new entries**, off by default. With it off the listings keep polling but
leave the rows where they are, showing a _Load new entries_ notice instead — a table you are reading
never shifts under the cursor. Turn it on and the listings refresh themselves.

Anything that destroys work asks first. Retrying a job, retrying every failure, deleting a job,
cancelling a batch, pausing a supervisor and dropping a monitored tag all raise a dialog that names
what is about to happen — the queue, the job, how many rows — with Cancel focused, so the
destructive button is never one Enter away. Resuming a supervisor does not ask: it is what undoes a
pause.

The mount path is written into the page when the dashboard is mounted, so `board.path` can be
anything and the
assets and the router follow it. The REST API lives under `{path}/api` behind the same gate.

`board.auth` is a callback. It receives the raw request and
returns a boolean:

```ts
board: {
  path: '/sentinel',
  auth: (req) =>
    // Without the `!!`, an unset TOKEN matches an absent header and opens the gate.
    !!process.env.TOKEN && req.headers['x-internal-token'] === process.env.TOKEN,
}
```

`basicAuth()` ships as a helper. It compares in constant time and **denies everything when either
credential is empty**, so a deployment that forgot to configure it does not expose the dashboard.

**Content-Security-Policy.** The page carries no inline script, so `script-src 'self'` — helmet's
default, and most hardened setups — serves it as is, with the colour scheme applied before first
paint. The one thing a strict policy does block is the favicon, which is an inline SVG; allow
`img-src 'self' data:` for it, or live without a tab icon.

If your policy is stricter still and you use nonces, hand yours to the page:

```ts
board: {
  // Whatever your CSP middleware put on the request.
  cspNonce: (req) => (req as { nonce?: string }).nonce,
}
```

It is a callback rather than a string because a nonce reused across requests is not a nonce.

The dashboard also refuses to serve itself unguarded outside development: with no `board.auth`, it
mounts only when `NODE_ENV` (or the `env` option) is `development`, `test`, `local`, or unset. Any
other value — `staging`, `ci`, `production` — logs a warning and mounts nothing, API included.

Serve it over HTTPS only: basic auth sends the credentials on every request.

---

## Tags and monitoring

Tags travel in the job payload and group jobs that belong together — a customer, an import, a
tenant. Monitor a tag from the dashboard and every job carrying it is collected under it:

```ts
await this.queues.dispatch('reports', 'report', {
  customerId: 42,
  tags: ['customer:42', 'monthly-close'],
});
```

There are two indexes:

- **Monitored tags** collect every job carrying them, and only while someone is watching — indexing
  every tag would grow Redis without anyone reading it. `queues.dispatch()` indexes at push time, so
  a pending job already shows under its tag; a job added with `queues.get(q).add(...)` is indexed
  when a worker starts it. Either way it is there before it finishes, which is the point — the job
  you want to watch is the one that is taking too long. The monitored index is permanent, capped at
  the last 1000 jobs per tag,
  and dropped when you stop monitoring.
- **Failures** are indexed under every one of their tags, monitored or not, expiring with
  `metrics.trimFailedMinutes`. That is what lets the Failed Jobs screen filter by tag across the
  whole retention window instead of the page in front of you.

A monitored tag's screen has two tabs — **Recent Jobs** and **Failed Jobs** — and the Monitoring
listing counts them separately.

A BullMQ payload is plain JSON with no type information, so nothing is derived from it: tags are
always explicit.

## Silenced jobs

A job that runs constantly and never fails buries everything else in the listings. Silencing it
keeps it running, just out of the way. Three ways to do it:

```ts
// By job name.
silenced: ['heartbeat', 'refresh-cache'],

// By tag.
silencedTags: ['cron'],
```

```ts
// Or the job declares itself in its payload.
await this.queues.dispatch('default', 'heartbeat', { silenced: true });
```

Silenced jobs leave the completed listing and get their own **Silenced Jobs** screen.

**The decision is made once, when the job finishes**, and written to an index — one key
per queue. Adding a name to `silenced` therefore governs what
happens next, not what already happened: yesterday's completions stay where they are.

The index is kept for `metrics.trimRecentMinutes` (60 minutes by default), so the Silenced screen is
a recent window rather than a permanent partition — raise that window to keep silenced jobs listed
for longer.

**Silencing hides the noise, never the failures.** A silenced job that fails appears in Failed Jobs
and *only* there — not in the Silenced listing. A job goes into its
silenced set from the completion path and never from the failure one. You silence a job's successes,
not its errors. Pending and active listings show everything too: a job waiting to run belongs in the
workload no matter how noisy it is.

## Detail an error carries about itself

An error can bring structured detail along, and the failed-job screen shows it beside the
stack trace instead of leaving you to read it out of the message:

```ts
class PaymentError extends Error {
  constructor(readonly context: Record<string, unknown>) {
    super('Payment declined');
  }
}

throw new PaymentError({ orderId: order.id, gateway: 'stripe', code: 'card_declined' });
```

A method works as well as a property, so a custom error class can compute it. Anything that is not a
plain object is ignored, and a context
that cannot be serialised is replaced by a note rather than taking the failure down with
it. It is kept for as long as the failure is, and only on the detail of one job — the
listings do not read it.

## Putting a job back without failing it

Some work is not broken, just not ready: the API answered 429, the lock is held, the file
is still uploading. Throwing would requeue the job, but it also writes a stack trace and a
failure an operator then has to read and dismiss.

`release()` puts it back, as a second argument to the handler:

```ts
@SentinelProcessor('mail')
export class MailProcessor {
  async handle(job: Job, ctx: JobContext) {
    const response = await api.send(job.data);

    if (response.status === 429) {
      await ctx.release(Number(response.headers['retry-after'] ?? 60));
    }
  }
}
```

The call never returns — it ends the handler. Nothing is written to the failed listing, no
stack trace is kept, the failure counters do not move, and a `job.released` event fires.

The second argument is optional, so a handler that only needs the job keeps taking one. A
`BatchedProcessor` gets it too, and a release inside a batch counts as neither a success
nor a failure — the job is still pending, which is what it is.

`attempts` on the job detail counts every run, releases included.
A job quietly bouncing on a rate limit shows a rising number there instead of looking
untouched.

**It is bounded.** A handler that releases forever would never finish, so `maxReleases`
(25 by default, set globally, per supervisor, or in a job's own payload — a payload that is
not a whole non-negative number falls back to the configured ceiling rather than raising it) fails the
job once it runs out. That is a
separate dial from `attempts`, which stays what it says: how many times a job that *failed*
is retried. Two dials rather than one, so rescheduling work that is not ready and retrying work
that broke stay separate decisions.

## Timeouts and worker recycling

BullMQ has stall detection, which catches a frozen worker but not a job that is merely slow. A slow
job holds its concurrency slot for as long as it runs:

```ts
timeoutSeconds: 60,
supervisors: {
  'supervisor-heavy': { queues: ['reports'], timeoutSeconds: 300 },
},
```

The job is failed and its concurrency slot released on time, **and the handler is told**:

```ts
async handle(job: Job, ctx: JobContext) {
  for (const row of rows) {
    if (ctx.aborted) return;          // out of time, or the worker is shutting down
    await send(row);
  }

  await fetch(url, { signal: ctx.signal });   // or hand the signal over
}
```

`ctx.aborted` is raised on the timeout and on shutdown alike, so a handler does not have to know
which happened. It is cooperative: **the work is not killed**. A handler that never looks, or that
sits inside a call with no signal of its own, runs to the end while its slot has already been freed
and the job already marked failed. Killing it outright is possible in BullMQ only with sandboxed
processors, which are standalone files with no dependency injection — a worse trade than the one
this package exists to offer.

`workerLimits` retires a worker process that has done enough:
`maxTime` and `memory`:

```ts
workerLimits: {
  maxJobs: 1000,
  maxLifetimeSeconds: 3600,
  memoryLimitMb: 512,
},
```

Retiring is a clean shutdown: in-flight jobs finish and the process exits. **Something has to start
a
new one** — pm2, systemd, a Docker restart policy or a Kubernetes Deployment. Without a process
manager in front, a retired worker simply stays down.

## Events

The package announces what it does, so you can plug in your own logging or alerting:

```ts
constructor(events: SentinelEvents) {
  events.on('job.failed', ({ queue, name, error, exhausted }) => {
    if (exhausted) this.sentry.captureMessage(`${queue}/${name}: ${error}`);
  });
}
```

| Event                 | Payload                                                    |
| --------------------- | ---------------------------------------------------------- |
| `job.pushed`          | `queue`, `name`, `jobId`                                   |
| `job.started`         | `queue`, `name`, `jobId`, `attempt`                        |
| `job.completed`       | `queue`, `name`, `jobId`, `runtime`                        |
| `job.failed`          | `queue`, `name`, `jobId`, `error`, `exhausted`, `attempts` |
| `job.released`        | `queue`, `name`, `jobId`, `delay`                          |
| `job.deleted`         | `queue`, `name`, `jobId`                                   |
| `long-wait`           | `queue`, `seconds`, `threshold`                  |
| `supervisor.paused`   | `supervisor`                                     |
| `supervisor.resumed`  | `supervisor`                                     |
| `worker.retiring`     | `reason`                                         |
| `batch.finished`      | `batchId`, `name`                                |
| `batch.cancelled`     | `batchId`, `name`                                |

It is a plain Node emitter rather than `@nestjs/event-emitter`, so the package adds no dependency to
your app. A listener that throws is swallowed and never takes the worker down.

## Long-wait alerts

`waits` sets how long a queue may take to **drain** before it is worth telling someone. That is
The wait is a forecast rather than a symptom: ready jobs × average
runtime ÷ workers on the queue. The age of the oldest job tells you how late you already are; this
tells you how late you are about to be, which is what a threshold should watch.

A threshold applies out of the box: with no `waits` of your own every queue gets 60
seconds. Pass `waits: {}` to turn the check off entirely.

`default` covers every queue that has no entry of its own:

```ts
waits: { default: 60, reports: 300 },
onLongWait: ({ queue, seconds }) => slack.post(`${queue} is ${seconds}s behind`),
```

Delivery is a callback, so where the alert goes is yours to decide. The check runs in the worker
process, so an app behind several API instances alerts once, and a queue that stays over its
threshold re-alerts every five minutes.

A queue with a backlog and no worker on it reports `seconds: null` rather than a number: it will not
drain at all, so there is no forecast to give. It alerts regardless of the threshold.

## Environments

Overrides merged on top of `supervisors` for the current `NODE_ENV`, so the queue topology can
`environments` block:

```ts
supervisors: {
  'supervisor-fast': { queues: ['default', 'mail'], concurrency: 3 },
},

environments: {
  production: {
    'supervisor-fast': { concurrency: 20 },
  },
},
```

`NODE_ENV` is read when the module is built, so with `forRootAsync` make sure it is set before the
factory runs.

## Multiple Redis connections

Name extra connections and point a supervisor at one. This package's own bookkeeping — metrics,
batches, worker registry — always stays on the main connection:

```ts
connection: { host: '127.0.0.1', port: 6379 },
connections: {
  reports: { host: 'redis-reports', port: 6379 },
},

supervisors: {
  'supervisor-heavy': { queues: ['reports'], connection: 'reports' },
},
```

## Maintenance

`MaintenanceService` is the operational surface, injectable anywhere:

```ts
await this.maintenance.clear('reports'); // drop what has not run on one queue
await this.maintenance.clearAll(); // the same, every queue
await this.maintenance.clearMetrics(); // drop every measurement and snapshot
await this.maintenance.pauseAll(); // stop consuming, fleet-wide
await this.maintenance.resumeAll(); // start again
await this.maintenance.terminate(); // finish what is in hand and exit
await this.maintenance.forgetFailed(); // delete every failed job
await this.maintenance.status(); // what the dashboard's header shows
```

`terminate()` asks every worker to finish what it holds and exit — the deploy story. As with
`workerLimits`, **starting the new ones is your process manager's job**. A worker that started after
the request ignores it, so a rolling deploy does not kill its own replacements.

## Redis Cluster

Give it the nodes — any of them, the rest are discovered:

```ts
connection: { cluster: [{ host: 'redis-1', port: 6379 }, { host: 'redis-2', port: 6379 }] },
```

Two different key layouts, on purpose:

- **Each queue gets its own hash tag** — `{sentinel:mail}`, `{sentinel:reports}` — so the queues, which
  hold nearly all the volume, spread across the nodes. One tag for everything also works, but then
  three machines hold one machine's worth of data and losing that node loses every queue.
- **This package's own keys share one tag** — `{sentinel}:metrics:*` and so on. Reading them takes
  pipelines and MGETs across unrelated keys, which a cluster only allows within a slot. They are
  counters, sets and short lists; the volume is negligible.

A prefix that already carries a hash tag is left exactly as you wrote it — that is your decision
about co-location. A prefix with an unbalanced or empty tag, or with a glob character in it, is
refused at boot rather than failing later as CROSSSLOT on every job or as a key sweep that matches
another application's keys. A cluster has no databases, so `db` is ignored.

Queues and workers get their own cluster clients, all of them closed on shutdown, and `SCAN` — the
one command with no key to route by — is walked per master node.

```bash
pnpm cluster:up    # three throwaway nodes from the redis you already have
pnpm test
pnpm cluster:down
```

The cluster suite skips itself when no cluster is running, so `pnpm test` stays green either way.

## Retention

Two independent bounds on how much history the listings keep:

```ts
defaultJobOptions: { removeOnComplete: 500, removeOnFail: 5000 },  // by count, BullMQ
trim: { completed: 60, failed: 10080 },                            // by age, in minutes
```

`trim.delayed` also exists, but read it twice before using it: BullMQ removes delayed jobs by **when
they were created**, not by when they are due, so `trim: { delayed: 1440 }` deletes a job created
yesterday and scheduled for next month. It is there for queues that use delays as short retries.

Age-based trimming rides the snapshot tick, which every process runs; a lock picks one per tick, so
it happens once for the fleet whether or not a worker is up. Each tick removes up to a thousand jobs
per queue and type, so a large backlog drains over several ticks rather than in one. The metrics
windows are separate again — `metrics.trimRecentFailedMinutes` is what the
dashboard's failure card counts over, kept apart from how long failures are retained so you can show
an hour of failures while keeping a week of them.

## Running more than one worker

Scaling means more worker processes, and two of them must not both do the fleet-wide work. Snapshots
and long-wait alerts take a short Redis lock, so each tick belongs to one process: metrics are
counted once and an alert arrives once. Nothing to configure — it happens as soon as a second worker
starts.

Workers announce themselves into an index with a TTL, so the dashboard reads who is alive with a
`SMEMBERS` and an `MGET` rather than scanning the keyspace. Nothing in this package ever issues
`KEYS`: it blocks Redis for as long as it runs, and on a shared instance that is your application
stalling, not just the dashboard.

## Tests

```bash
pnpm test              # both
pnpm test:ui           # dashboard components, no Redis needed
pnpm test:integration  # queues, batches, board — needs Redis
```

**Integration** (`test/`) runs real workers against a real Redis, because everything on that side is
Redis semantics — atomic counters, TTLs, locks — and a mocked client would only assert that we call
the methods we call. It covers the config surface, batches, tags and silencing, timeouts and worker
recycling, the async
boot, the maintenance commands, what happens with **two worker contexts sharing one Redis**, and the
board over HTTP: the auth gate, the domain check, middleware order and every API route. It uses
`REDIS_TEST_DB` (15 by default) and cleans up after itself. A Redis Cluster suite runs when one is
up and reports as skipped when it is not, rather than passing quietly.

**Dashboard** (`ui-test/`) mounts the real screens with Vitest against a stubbed API, so a change to
a listing, a filter or a button is caught here instead of in a browser. It also pins the
accessibility guarantees: every row action is a real button with a name, the icons stay decorative,
and a destructive action does nothing until it is confirmed.

---

## Configuration reference

| Option                              | Default    | What it does                                            |
| ----------------------------------- | ---------- | ------------------------------------------------------- |
| `connection`                        | —          | Redis connection: a `url`, individual fields, or both   |
| `connection.cluster`                | —          | Cluster nodes; the key prefix is hash-tagged for you    |
| `env`                               | `NODE_ENV` | Which `environments` key applies                        |
| `connections`                       | —          | Extra named connections a supervisor can point at       |
| `name`                              | `Sentinel` | Instance name, shown in the dashboard                   |
| `prefix`                            | `sentinel` | Key prefix for everything this package writes           |
| `supervisors`                       | —          | Named groups of queues, each with its own concurrency   |
| `supervisors.*.queues`              | —          | Queues the supervisor owns                              |
| `supervisors.*.concurrency`         | `1`        | Jobs each of its queues runs at once, per process       |
| `supervisors.*.timeoutSeconds`      | —          | Overrides the global timeout                            |
| `supervisors.*.connection`          | —          | Name of an entry in `connections`                       |
| `supervisors.*.defaultJobOptions`   | —          | Job options for this supervisor's queues                |
| `supervisors.*.maxReleases`         | `maxReleases` | Overrides the global release budget                  |
| `environments`                      | —          | Supervisor overrides merged in by `NODE_ENV`            |
| `defaultJobOptions`                 | —          | Applied to every queue; a supervisor can override it    |
| `timeoutSeconds`                    | —          | Seconds a job may run before it is failed               |
| `silenced`                          | `[]`       | Job names kept out of the completed listing             |
| `board.cspNonce`                    | —          | Per-request CSP nonce, for policies that require one    |
| `silencedTags`                      | `[]`       | Same, by tag                                            |
| `maxReleases`                       | `25`       | Times a handler may call `ctx.release()` on one job |
| `waits`                             | `{ default: 60 }` | Seconds a queue may take to drain before alerting; `{}` turns it off |
| `onLongWait`                        | —          | Called when a queue passes its threshold                |
| `worker`                            | `false`    | Whether this process consumes jobs                      |
| `workerLimits.maxJobs`              | —          | Retire the process after this many jobs                 |
| `workerLimits.maxLifetimeSeconds`   | —          | Retire the process after this long                      |
| `workerLimits.memoryLimitMb`        | —          | Retire the process over this heap size (V8 heap, not RSS) |
| `metrics.snapshotIntervalSeconds`   | `300`      | How often a snapshot is taken                           |
| `metrics.trimSnapshots`             | `24`       | Snapshots kept, a number or `{ job, queue }`            |
| `metrics.trimRecentFailedMinutes`   | `trimFailedMinutes` | Window the failure counter reads, apart from retention |
| `trim.completed` / `trim.failed`    | —          | Age-based retention for finished jobs, in minutes       |
| `trim.delayed`                      | —          | Age-based removal of **scheduled** jobs, by creation age |
| `metrics.trimRecentMinutes`         | `60`       | How long recent-job records are kept                    |
| `metrics.trimFailedMinutes`         | `10080`    | How long failed-job records are kept                    |
| `metrics.trimMonitoredMinutes`      | `10080`    | How long the copies under a monitored tag are kept      |
| `board.enabled`                     | `true`     | Set `false` to leave the dashboard out entirely         |
| `board.path`                        | `/sentinel` | Where the dashboard is mounted                         |
| `board.proxyPath`                   | —          | Public prefix when a proxy serves it under another path |
| `board.domain`                      | —          | Only serve the dashboard on this host                   |
| `board.auth`                        | —          | The gate. Without it, no dashboard in production        |
| `board.middleware`                  | `[]`       | Middleware run before the dashboard                     |
| `board.title`                       | `name`     | Title shown in the UI, falling back to `Sentinel`       |
| `batchTtlSeconds`                   | `604800`   | How long batch state survives in Redis                  |

## Design decisions

A few behaviours are worth stating outright, because they are the ones people ask about:

- **A retried failure leaves the failed listing once it succeeds.** The alternative — keeping the
  original there forever — makes "retry all" re-run work that has already been done.
- **A queue with a backlog and nothing consuming it reports no forecast at all**, not `0`. Zero reads
  as "no wait" in the one case that most deserves an alarm.
- **A failure never decrements a batch's pending count.** A batch holding an unretried failure settles
  at `pending === failed` and fires `finally`; only a success, or a retry that succeeds, closes it.
- **A broken chain writes off the links that can never run**, so the batch settles instead of hanging
  on jobs that will never be queued.
- **`attempts` counts runs, not failures.** A job that puts itself back with `release()` shows a
  rising number without ever having failed.
- **Concurrency is per queue, not per supervisor.** A supervisor with three queues and
  `concurrency: 5` runs up to fifteen jobs at once in one process — size your database pool for
  that.
- **The dashboard fails closed.** Without `board.auth` it refuses to mount outside development, and it
  warns when it serves unguarded only because no environment is set.

## Scope

This package runs queues; it does not supervise processes. There is no autoscaling and no process
balancing: how many worker processes you run is a job for pm2, systemd, Docker replicas or
Kubernetes, which already handle restarts and health checks. Concurrency here is promises inside one
event loop, not processes across cores, and the two are not interchangeable.

A timeout frees the slot and fails the job, but it does not kill the handler — nothing in Node
interrupts a running promise. The handler is told through `ctx.aborted` and has to stop itself.

Tags are the ones you put on the payload; nothing is derived from it automatically. For queue
precedence, use BullMQ job priorities.

## Contributing

Issues and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for how to run the
suites, including the three-node Redis Cluster. Security reports go through
[SECURITY.md](SECURITY.md) rather than a public issue.

## License

MIT
