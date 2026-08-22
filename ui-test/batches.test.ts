import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, RouterLinkStub, type VueWrapper } from '@vue/test-utils';
import { acceptConfirm, job, settle, stubApi, type ApiStub } from './helpers';
import type { Batch } from '../ui-src/src/api';

const route = { params: { id: 'abc-123' } };

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router');

  return { ...actual, useRoute: () => route };
});

const batch = (overrides: Partial<Batch> = {}): Batch => ({
  id: 'abc-123',
  name: 'Monthly reports',
  totalJobs: 10,
  pendingJobs: 0,
  processedJobs: 8,
  failedJobs: 2,
  skippedJobs: 0,
  allowFailures: false,
  cancelled: false,
  cancelledAt: null,
  finished: true,
  progress: 100,
  createdAt: '2026-01-01T10:00:00.000Z',
  finishedAt: '2026-01-01T10:05:00.000Z',
  ...overrides,
});

describe('BatchDetail', () => {
  let stub: ApiStub;

  beforeEach(() => {
    vi.resetModules();
    stub = stubApi();
  });

  afterEach(() => {
    vi.doUnmock('../ui-src/src/api');
  });

  const mountDetail = async (): Promise<VueWrapper> => {
    const BatchDetail = (await import('../ui-src/src/screens/BatchDetail.vue')).default;
    const wrapper = mount(BatchDetail, {
      global: { stubs: { RouterLink: RouterLinkStub } },
    });

    await settle();
    await wrapper.vm.$nextTick();

    return wrapper;
  };

  it('shows the failed jobs of a batch', async () => {
    stub.on('/batches/abc-123/failed', {
      jobs: [job({ name: 'report', queue: 'reports', failedReason: 'boom' })],
      total: 2,
    });
    stub.on('/batches/abc-123', batch());

    const wrapper = await mountDetail();

    expect(wrapper.text()).toContain('Monthly reports');
    expect(wrapper.text()).toContain('Failed Jobs (2)');
    expect(wrapper.text()).toContain('boom');
  });

  it('retries every failure of the batch in one call', async () => {
    stub.on('/batches/abc-123/failed', {
      jobs: [job({ failedReason: 'boom' })],
      total: 2,
    });
    stub.on('/batches/abc-123', batch());

    const wrapper = await mountDetail();
    const retry = wrapper
      .findAll('button')
      .find((button) => button.text().includes('Retry Failed Jobs'));

    expect(retry).toBeDefined();

    await retry!.trigger('click');
    await acceptConfirm();

    expect(stub.calls.post).toContain('/batches/abc-123/retry');
  });

  it('hides the failures card when nothing failed', async () => {
    stub.on('/batches/abc-123/failed', { jobs: [], total: 0 });
    stub.on('/batches/abc-123', batch({ failedJobs: 0, processedJobs: 10 }));

    const wrapper = await mountDetail();
    const retry = wrapper
      .findAll('button')
      .find((button) => button.text().includes('Retry Failed Jobs'));

    // The summary keeps its "Failed Jobs: 0" row; the card is what disappears.
    expect(retry).toBeUndefined();
    expect(wrapper.text()).not.toContain('Failed Jobs (');
  });

  it('says when a batch has expired', async () => {
    stub.on('/batches/abc-123', null);

    const wrapper = await mountDetail();

    expect(wrapper.text()).toContain('Batch not found');
  });
});
