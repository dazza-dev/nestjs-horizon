import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A fetch that fails for the listed paths and succeeds for the rest. */
const stubFetch = (fail: string[], delayMs = 0) =>
  vi.fn((url: string) => {
    if (fail.some((path) => url.includes(path))) {
      return Promise.resolve({
        ok: false,
        status: 500,
        statusText: 'Server Error',
        json: () => Promise.resolve({ message: 'Redis is down' }),
      });
    }

    return new Promise((resolve) =>
      setTimeout(() => resolve({ ok: true, json: () => Promise.resolve([]) }), delayMs),
    );
  });

describe('api error banner', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it('keeps a failure visible when a parallel request succeeds after it', async () => {
    const { api, lastError } = await import('../ui-src/src/api');

    // The dashboard fires three at once; the slow success used to wipe the fast failure.
    vi.stubGlobal('fetch', stubFetch(['/stats'], 10));

    await Promise.all([
      api.get('/stats').catch(() => undefined),
      api.get('/workload').catch(() => undefined),
      api.get('/masters').catch(() => undefined),
    ]);

    expect(lastError.value).toBe('Redis is down');
  });

  it('clears once a whole round succeeds', async () => {
    const { api, lastError } = await import('../ui-src/src/api');

    vi.stubGlobal('fetch', stubFetch(['/stats']));
    await api.get('/stats').catch(() => undefined);

    expect(lastError.value).toBe('Redis is down');

    // Recovery has to be visible too, or the banner becomes noise nobody trusts.
    vi.stubGlobal('fetch', stubFetch([]));
    await Promise.all([api.get('/stats'), api.get('/workload')]);

    expect(lastError.value).toBeNull();
  });

  it('reports a network failure in words rather than a status code', async () => {
    const { api, lastError } = await import('../ui-src/src/api');

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('connection refused'))),
    );

    await api.get('/stats').catch(() => undefined);

    expect(lastError.value).toContain('Cannot reach');
  });
});

describe('action', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it('swallows a failed request instead of leaving it unhandled', async () => {
    const { action, api, lastError } = await import('../ui-src/src/api');

    vi.stubGlobal('fetch', stubFetch(['/jobs']));

    const unhandled = vi.fn();

    process.on('unhandledRejection', unhandled);

    // What a template does: call the handler and ignore what it returns.
    const remove = action(async () => {
      await api.del('/jobs/mail/7');
    });

    await remove();
    await new Promise((resolve) => setTimeout(resolve, 10));

    process.off('unhandledRejection', unhandled);

    expect(unhandled).not.toHaveBeenCalled();

    // Swallowed, not hidden: the banner is what tells the operator.
    expect(lastError.value).toBe('Redis is down');
  });

  it('passes its arguments through', async () => {
    const { action } = await import('../ui-src/src/api');
    const seen: unknown[] = [];

    const handler = action(async (a: string, b: number) => {
      seen.push(a, b);

      return Promise.resolve();
    });

    await handler('mail', 7);

    expect(seen).toEqual(['mail', 7]);
  });
});
