import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The screens poll; a request that starts failing has nowhere to surface on its own.
 * These cover the one place that decides whether the operator hears about it.
 */
describe('API errors', () => {
  beforeEach(() => {
    vi.resetModules();

    const meta = document.createElement('meta');

    meta.setAttribute('name', 'sentinel-base');
    meta.setAttribute('content', '/sentinel');
    document.head.appendChild(meta);
  });

  afterEach(() => {
    document.head.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('reports the server message rather than the status line', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: () => Promise.resolve({ message: 'Job 7 not found in queue mail.' }),
      }),
    );

    const { api, lastError } = await import('../ui-src/src/api');

    await expect(api.get('/jobs/mail/7')).rejects.toThrow();
    expect(lastError.value).toBe('Job 7 not found in queue mail.');
  });

  it('reports an unreachable API instead of failing silently', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    const { api, lastError } = await import('../ui-src/src/api');

    await expect(api.get('/stats')).rejects.toThrow();
    expect(lastError.value).toBe('Cannot reach the Sentinel API.');
  });

  it('clears itself once a request succeeds again', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        json: () => Promise.reject(new Error('no body')),
      })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) });

    vi.stubGlobal('fetch', fetchMock);

    const { api, lastError } = await import('../ui-src/src/api');

    await expect(api.get('/stats')).rejects.toThrow();
    expect(lastError.value).toBe('500 Internal Server Error');

    await api.get('/stats');
    expect(lastError.value).toBeNull();
  });
});
