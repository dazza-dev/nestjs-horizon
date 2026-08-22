import { request } from 'http';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import {
  BoardSetup,
  SentinelModule,
  basicAuth,
  type BoardOptions,
  type SentinelOptions,
} from '../src';
import { Suite, connection, wipe } from './harness';

const SUITE = 'board';
const PREFIX = 'sentinel-board';
const PORT = 3987;

const options = (board: BoardOptions): SentinelOptions => ({
  name: 'Board Test',
  prefix: PREFIX,
  connection: connection(),
  worker: false,
  supervisors: { main: { queues: ['board'] } },
  board,
});

/** Boots a real HTTP server with the board mounted the way an app would mount it. */
const serve = async (board: BoardOptions): Promise<INestApplication> => {
  @Module({ imports: [SentinelModule.forRoot(options(board))] })
  class BoardModule {}

  const app = await NestFactory.create(BoardModule, { logger: false });

  app.setGlobalPrefix('api/v1', { exclude: ['sentinel', 'sentinel/*path'] });
  app.get(BoardSetup).mount(app);

  await app.listen(PORT);

  return app;
};

const get = async (
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: string; type: string }> => {
  // Connection: close. Several apps boot on the same port here, and fetch's pool would
  // otherwise reuse a socket left over from the previous one and fail with ECONNRESET.
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), connection: 'close' },
  });

  return {
    status: response.status,
    body: await response.text(),
    type: response.headers.get('content-type') ?? '',
  };
};

/**
 * fetch cannot set Host; it is a forbidden header. The domain check goes out as a raw
 * request instead, closer to what a reverse proxy sends anyway.
 */
const getWithHost = (
  path: string,
  host: string,
): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: PORT, path, headers: { host } },
      (res) => {
        let body = '';

        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );

    req.on('error', reject);
    req.end();
  });

const credentials = (user: string, password: string): RequestInit => ({
  headers: {
    authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
  },
});

export async function run(): Promise<Suite> {
  const suite = new Suite(SUITE);
  const check = suite.check.bind(suite);

  await wipe(PREFIX);

  // --- With basic auth ---
  let app = await serve({
    path: '/sentinel',
    auth: basicAuth({ username: 'ops', password: 'secret' }),
  });

  const anonymous = await get('/sentinel/');
  check('the dashboard is closed without credentials', anonymous.status === 401);

  const wrong = await get('/sentinel/', credentials('ops', 'nope'));
  check('wrong credentials do not open it', wrong.status === 401);

  const page = await get('/sentinel/', credentials('ops', 'secret'));
  check(
    'the dashboard is served with the right credentials',
    page.status === 200 && page.type.includes('html'),
    `${page.status} ${page.type}`,
  );

  check(
    'the mount path is written into the page',
    page.body.includes('content="/sentinel"') && !page.body.includes('__SENTINEL_BASE__'),
  );
  check(
    'the instance name is written into the page',
    page.body.includes('Board Test') && !page.body.includes('__SENTINEL_NAME__'),
  );
  check(
    'assets are rewritten to the mount path',
    page.body.includes('"/sentinel/assets/') && !page.body.includes('"/assets/'),
  );

  const nested = await get('/sentinel/jobs/failed', credentials('ops', 'secret'));
  check(
    'a nested route falls back to the page, so the router owns the URL',
    nested.status === 200 && nested.body.includes('/sentinel/assets/'),
    `${nested.status}`,
  );

  const api = await get('/sentinel/api/status', credentials('ops', 'secret'));
  check(
    'the API rides behind the same gate',
    api.status === 200 && api.body.includes('"status"'),
    `${api.status} ${api.body.slice(0, 60)}`,
  );

  const closedApi = await get('/sentinel/api/status');
  check('the API is closed without credentials', closedApi.status === 401);

  const outside = await get('/api/v1/anything');
  check(
    'the board does not swallow the application routes',
    outside.status === 404,
    `${outside.status}`,
  );

  await app.close();

  // --- An empty configured password ---
  app = await serve({
    path: '/sentinel',
    auth: basicAuth({ username: 'ops', password: '' }),
  });

  const empty = await get('/sentinel/', credentials('ops', ''));
  check('an unconfigured password closes the dashboard', empty.status === 401);

  await app.close();

  // --- A custom path and a domain ---
  app = await serve({
    path: '/queues',
    domain: 'queues.example.com',
    auth: () => true,
  });

  const wrongHost = await get('/queues/');
  check('another host gets nothing', wrongHost.status === 404, `${wrongHost.status}`);

  const rightHost = await getWithHost('/queues/', 'queues.example.com');
  check(
    'the configured domain is served',
    rightHost.status === 200 && rightHost.body.includes('content="/queues"'),
    `${rightHost.status}`,
  );

  await app.close();

  // --- Board middleware ---
  const seen: string[] = [];

  app = await serve({
    path: '/sentinel',
    auth: () => true,
    middleware: [
      (_req, _res, next) => {
        seen.push('first');
        next();
      },
      (_req, _res, next) => {
        seen.push('second');
        next();
      },
    ],
  });

  await get('/sentinel/api/status');
  check(
    'board middleware runs in order, before the gate',
    seen.join(',') === 'first,second',
    seen.join(','),
  );

  await app.close();

  // --- CSP nonce ---
  app = await serve({
    path: '/sentinel',
    auth: () => true,
    cspNonce: () => 'r4nd0mNonceValue123',
  });

  const withNonce = await get('/sentinel/');
  const inlineScripts = withNonce.body.match(/<script/g) ?? [];
  const noncedScripts =
    withNonce.body.match(/<script nonce="r4nd0mNonceValue123"/g) ?? [];

  // Nothing inline means `script-src 'self'` is enough. Behind helmet's defaults an
  // inline script gets blocked, and the theme paints light before flipping.
  const inline = withNonce.body.match(/<script(?![^>]*\ssrc=)[^>]*>/g) ?? [];

  check(
    'the page carries no inline script, so a strict CSP needs no exception',
    inline.length === 0,
    inline.join(' ') || 'none',
  );

  check(
    'every script tag carries the nonce',
    inlineScripts.length > 0 && noncedScripts.length === inlineScripts.length,
    `${noncedScripts.length}/${inlineScripts.length}`,
  );

  await app.close();

  // A nonce with markup inside it must never reach the page.
  app = await serve({
    path: '/sentinel',
    auth: () => true,
    cspNonce: () => '"><script>alert(1)</script>',
  });

  const injected = await get('/sentinel/');
  check(
    'a nonce that is not base64-ish is refused',
    !injected.body.includes('alert(1)') && !injected.body.includes('nonce='),
  );

  await app.close();

  // --- The API over HTTP ---
  app = await serve({ auth: () => true });

  const json = async (path: string, init: RequestInit = {}) => {
    const response = await get(path, init);

    try {
      return { status: response.status, body: JSON.parse(response.body) as unknown };
    } catch {
      return { status: response.status, body: null };
    }
  };

  const base = '/sentinel/api';

  // Status codes first: the screens read them to tell "gone" from "broken".
  const routes: [string, RequestInit, number][] = [
    [`${base}/stats`, {}, 200],
    [`${base}/workload`, {}, 200],
    [`${base}/masters`, {}, 200],
    [`${base}/jobs/pending`, {}, 200],
    [`${base}/jobs/failed`, {}, 200],
    [`${base}/batches`, {}, 200],
    [`${base}/metrics/queues`, {}, 200],
    [`${base}/metrics/jobs`, {}, 200],
    [`${base}/monitoring`, {}, 200],
    [`${base}/status`, {}, 200],
    // Unknown things are 404, not 500.
    [`${base}/jobs/nonsense`, {}, 404],
    [`${base}/batches/does-not-exist`, {}, 404],
    [`${base}/jobs/board/does-not-exist`, {}, 404],
    // A tag is required to write the monitoring list.
    [`${base}/monitoring`, { method: 'POST' }, 400],
  ];

  let wrongStatus = '';

  for (const [path, init, expected] of routes) {
    const response = await get(path, init);

    if (response.status !== expected) {
      wrongStatus = `${path} -> ${response.status}, expected ${expected}`;
      break;
    }
  }

  check(
    'every API route answers with the status its screen expects',
    !wrongStatus,
    wrongStatus,
  );

  const listing = await json(`${base}/jobs/pending`);
  check(
    'a listing answers with jobs and a total',
    Array.isArray((listing.body as { jobs?: unknown }).jobs) &&
      typeof (listing.body as { total?: unknown }).total === 'number',
    JSON.stringify(listing.body).slice(0, 60),
  );

  const monitored = await json(`${base}/monitoring?tag=billing`, { method: 'POST' });
  const listed = await json(`${base}/monitoring`);
  check(
    'monitoring a tag over HTTP lists it back',
    monitored.status === 200 &&
      (listed.body as { tag: string }[]).some((entry) => entry.tag === 'billing'),
    JSON.stringify(listed.body).slice(0, 60),
  );

  const unmonitored = await json(`${base}/monitoring?tag=billing`, { method: 'DELETE' });
  check(
    'and unmonitoring it removes it again',
    unmonitored.status === 200 &&
      !((await json(`${base}/monitoring`)).body as { tag: string }[]).some(
        (entry) => entry.tag === 'billing',
      ),
  );

  // The router clamps what becomes a Redis range; without it `perPage=0` asks for 0..-1.
  const hostile = await json(`${base}/jobs/pending?perPage=0&page=-3`);
  check(
    'a hostile page size is clamped rather than passed through',
    hostile.status === 200 && (hostile.body as { jobs: unknown[] }).jobs.length <= 25,
    `${(hostile.body as { jobs: unknown[] }).jobs.length} rows`,
  );

  const capped = await json(`${base}/jobs/pending?perPage=9999`);
  check('and a huge one is capped', capped.status === 200);

  await app.close();

  // --- A gate that refuses outright ---
  app = await serve({ auth: () => false });

  const forbidden = await get('/sentinel/api/status');
  check(
    'a non-credential gate answers 403, not a login prompt',
    forbidden.status === 403 && forbidden.body === 'Forbidden.',
    `${forbidden.status} ${forbidden.body}`,
  );

  await app.close();

  // --- Disabled entirely ---
  app = await serve({ enabled: false });

  const off = await get('/sentinel/');
  check(
    'board.enabled false leaves nothing mounted',
    off.status === 404,
    `${off.status}`,
  );

  await app.close();
  await wipe(PREFIX);

  return suite;
}
