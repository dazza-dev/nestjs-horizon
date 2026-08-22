import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, RouterLinkStub, type VueWrapper } from '@vue/test-utils';
import { settle, stubApi, type ApiStub } from './helpers';
import type { Batch } from '../ui-src/src/api';

const route = { params: { kind: 'jobs', name: 'send-email' }, query: {} };

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router');

  return { ...actual, useRoute: () => route };
});

const stubs = { RouterLink: RouterLinkStub, SnapshotChart: true };

describe('Metrics', () => {
  let stub: ApiStub;

  beforeEach(() => {
    vi.resetModules();
    stub = stubApi();
    route.params = { kind: 'jobs', name: 'send-email' };
  });

  afterEach(() => {
    vi.doUnmock('../ui-src/src/api');
  });

  const mountList = async (): Promise<VueWrapper> => {
    const Metrics = (await import('../ui-src/src/screens/Metrics.vue')).default;
    const wrapper = mount(Metrics, { global: { stubs } });

    await settle();
    await wrapper.vm.$nextTick();

    return wrapper;
  };

  // One column: the numbers live on the detail screen.
  it('lists what is being measured', async () => {
    stub.on('/metrics/jobs', [
      { name: 'send-email', throughput: 120, runtime: 45 },
      { name: 'build-report', throughput: 3, runtime: 9000 },
    ]);

    const wrapper = await mountList();
    const rows = wrapper.findAll('tbody tr').map((row) => row.text().trim());

    expect(rows).toEqual(['send-email', 'build-report']);
    expect(wrapper.findAll('thead th').map((th) => th.text())).toEqual(['Job']);
  });

  it('asks for the kind the route names', async () => {
    route.params = { kind: 'queues', name: '' };
    stub.on('/metrics/queues', []);

    await mountList();

    expect(stub.calls.get[0]).toBe('/metrics/queues');
  });

  it('offers both tabs', async () => {
    stub.on('/metrics/jobs', []);

    const wrapper = await mountList();
    const tabs = wrapper.findAll('.hz-tab').map((tab) => tab.text());

    expect(tabs).toEqual(['Jobs', 'Queues']);
  });
});

describe('MetricDetail', () => {
  let stub: ApiStub;

  beforeEach(() => {
    vi.resetModules();
    stub = stubApi();
    route.params = { kind: 'jobs', name: 'send-email' };
  });

  afterEach(() => {
    vi.doUnmock('../ui-src/src/api');
  });

  it('loads the series for the name in the route', async () => {
    stub.on('/metrics/jobs/send-email', {
      name: 'send-email',
      measurement: { throughput: 10, runtime: 50 },
      snapshots: [{ time: 1, throughput: 10, runtime: 50 }],
    });

    const MetricDetail = (await import('../ui-src/src/screens/MetricDetail.vue')).default;
    const wrapper = mount(MetricDetail, { global: { stubs } });

    await settle();
    await wrapper.vm.$nextTick();

    expect(stub.calls.get[0]).toBe('/metrics/jobs/send-email');
    expect(wrapper.text()).toContain('send-email');
  });
});

describe('Batches', () => {
  let stub: ApiStub;

  beforeEach(() => {
    vi.resetModules();
    stub = stubApi();
  });

  afterEach(() => {
    vi.doUnmock('../ui-src/src/api');
  });

  const batch = (overrides: Partial<Batch> = {}): Batch => ({
    id: 'abc',
    name: 'Monthly reports',
    totalJobs: 10,
    pendingJobs: 0,
    processedJobs: 10,
    failedJobs: 0,
    skippedJobs: 0,
    allowFailures: false,
    cancelled: false,
    finished: true,
    progress: 100,
    createdAt: '2026-01-01T10:00:00.000Z',
    finishedAt: '2026-01-01T10:05:00.000Z',
    cancelledAt: null,
    ...overrides,
  });

  const mountBatches = async (): Promise<VueWrapper> => {
    const Batches = (await import('../ui-src/src/screens/Batches.vue')).default;
    const wrapper = mount(Batches, { global: { stubs } });

    await settle();
    await wrapper.vm.$nextTick();

    return wrapper;
  };

  it('labels each batch by its state', async () => {
    stub.on('/batches', {
      batches: [
        batch({ id: 'a', name: 'Done' }),
        batch({
          id: 'b',
          name: 'Failing',
          failedJobs: 2,
          pendingJobs: 3,
          finished: false,
        }),
        batch({ id: 'c', name: 'Stopped', cancelled: true, finished: false }),
        batch({
          id: 'd',
          name: 'Running',
          pendingJobs: 5,
          processedJobs: 5,
          finished: false,
        }),
      ],
      total: 4,
    });

    const wrapper = await mountBatches();
    const pills = wrapper.findAll('.hz-pill');

    expect(pills.map((pill) => pill.text())).toEqual([
      'Finished',
      'Running',
      'Cancelled',
      'Running',
    ]);

    // Tinted, not filled. The hue is a per-theme token, and one markup reads right in
    // both; a row of solid blocks makes every batch look like an alarm.
    expect(
      pills.map((pill) => pill.classes().find((name) => name !== 'hz-pill')),
    ).toEqual([
      'hz-pill-ok',
      // Failing but still running: busy, not dead. The failures decide the colour once
      // there is nothing left to wait for.
      'hz-pill-busy',
      'hz-pill-warn',
      'hz-pill-busy',
    ]);
  });

  it('searches by name', async () => {
    stub.on('/batches', { batches: [], total: 0 });

    const wrapper = await mountBatches();

    await wrapper.find('input').setValue('reports');
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(stub.calls.get.some((path) => path.includes('search=reports'))).toBe(true);
  });

  it('says so when there are no batches', async () => {
    stub.on('/batches', { batches: [], total: 0 });

    expect((await mountBatches()).text()).toContain('No batches yet.');
  });
});
