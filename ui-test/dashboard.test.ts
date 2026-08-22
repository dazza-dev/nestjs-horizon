import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, RouterLinkStub, type VueWrapper } from '@vue/test-utils';
import { acceptConfirm, settle, stubApi, type ApiStub } from './helpers';
import type { Master, Stats, Workload } from '../ui-src/src/api';

const stats = (overrides: Partial<Stats> = {}): Stats => ({
  jobsPerMinute: 12,
  recentJobs: 340,
  failedJobs: 5,
  processes: 8,
  maxWait: 0,
  periods: { recentJobs: 60, failedJobs: 60 * 24 * 7 },
  workers: 2,
  paused: [],
  status: 'running',
  queueWithMaxRuntime: 'reports',
  queueWithMaxThroughput: 'default',
  ...overrides,
});

const master = (overrides: Partial<Master> = {}): Master => ({
  id: 'host:1',
  hostname: 'host',
  pid: 1,
  startedAt: '2026-01-01T10:00:00.000Z',
  supervisors: [
    {
      name: 'supervisor-fast',
      queues: ['default'],
      concurrency: 5,
      paused: false,
      running: true,
    },
  ],
  ...overrides,
});

describe('Dashboard', () => {
  let stub: ApiStub;

  beforeEach(() => {
    vi.resetModules();
    stub = stubApi();
  });

  afterEach(() => {
    vi.doUnmock('../ui-src/src/api');
  });

  const mountDashboard = async (): Promise<VueWrapper> => {
    const Dashboard = (await import('../ui-src/src/screens/Dashboard.vue')).default;
    const wrapper = mount(Dashboard, {
      global: { stubs: { RouterLink: RouterLinkStub } },
    });

    await settle();
    await wrapper.vm.$nextTick();

    return wrapper;
  };

  const card = (wrapper: VueWrapper, label: string): string | undefined =>
    wrapper
      .findAll('.hz-overview-item')
      .map((el) => el.text())
      .find((text) => text.includes(label));

  it('labels the counters from the configured retention windows', async () => {
    stub.on('/stats', stats());
    stub.on('/workload', [] as Workload[]);
    stub.on('/masters', [] as Master[]);

    const wrapper = await mountDashboard();

    expect(wrapper.text()).toContain('Jobs Past Hour');
    expect(wrapper.text()).toContain('Failed Jobs Past 7 Days');
  });

  it('follows the window when it is not an hour', async () => {
    stub.on('/stats', stats({ periods: { recentJobs: 30, failedJobs: 60 * 24 } }));
    stub.on('/workload', [] as Workload[]);
    stub.on('/masters', [] as Master[]);

    const wrapper = await mountDashboard();

    expect(wrapper.text()).toContain('Jobs Past 30 Minutes');
    expect(wrapper.text()).toContain('Failed Jobs Past Day');
    expect(wrapper.text()).not.toContain('Past Hour');
  });

  it('shows the numbers it was given', async () => {
    stub.on('/stats', stats());
    stub.on('/workload', [] as Workload[]);
    stub.on('/masters', [] as Master[]);

    const wrapper = await mountDashboard();

    expect(card(wrapper, 'Jobs Per Minute')).toContain('12');
    expect(card(wrapper, 'Total Processes')).toContain('8');
    expect(card(wrapper, 'Max Runtime')).toContain('reports');
  });

  it('reports the workload per queue', async () => {
    stub.on('/stats', stats());
    stub.on('/workload', [
      { name: 'default', length: 12, delayed: 3, wait: 45, processes: 5 },
      { name: 'reports', length: 0, delayed: 0, wait: 0, processes: 1 },
    ] as Workload[]);
    stub.on('/masters', [] as Master[]);

    const wrapper = await mountDashboard();
    const rows = wrapper.findAll('tbody tr').map((row) => row.text());

    expect(rows[0]).toContain('default');
    expect(rows[0]).toContain('12');
    expect(rows[1]).toContain('reports');

    // Delayed work is scheduled, not backed up. It gets a column of its own.
    expect(wrapper.findAll('thead th').map((th) => th.text())).toContain('Delayed');
    expect(rows[0]).toContain('3');
  });

  it('marks a configured supervisor that nothing is running', async () => {
    stub.on('/stats', stats({ status: 'inactive', workers: 0, processes: 0 }));
    stub.on('/workload', [] as Workload[]);
    stub.on('/masters', [
      master({
        id: 'inactive',
        hostname: '—',
        pid: 0,
        startedAt: '',
        supervisors: [
          {
            name: 'supervisor-fast',
            queues: ['default'],
            concurrency: 5,
            paused: false,
            running: false,
          },
        ],
      }),
    ]);

    const wrapper = await mountDashboard();

    // No hostname-0 card pretending to be a healthy worker, and no pause button for a
    // supervisor whose flag nobody would read.
    expect(wrapper.text()).toContain('Not running');
    expect(wrapper.text()).not.toContain('—-0');
    expect(wrapper.text()).toContain('Inactive');
    expect(wrapper.find('.hz-action').exists()).toBe(false);
  });

  it('says when nothing is consuming', async () => {
    stub.on('/stats', stats({ status: 'inactive', workers: 0, processes: 0 }));
    stub.on('/workload', [] as Workload[]);
    stub.on('/masters', [] as Master[]);

    const wrapper = await mountDashboard();

    expect(wrapper.text()).toContain('Inactive');
    expect(wrapper.text()).toContain('No workers running');
  });

  it('pauses and resumes a supervisor', async () => {
    stub.on('/stats', stats());
    stub.on('/workload', [] as Workload[]);
    stub.on('/masters', [master()]);

    const wrapper = await mountDashboard();
    const action = wrapper.find('.hz-action');

    expect(action.exists()).toBe(true);

    await action.trigger('click');
    await acceptConfirm();

    expect(stub.calls.post).toContain('/supervisors/supervisor-fast/pause');
  });

  it('offers resume on a paused supervisor', async () => {
    stub.on('/stats', stats({ status: 'paused', paused: ['supervisor-fast'] }));
    stub.on('/workload', [] as Workload[]);
    stub.on('/masters', [
      master({
        supervisors: [
          {
            name: 'supervisor-fast',
            queues: ['default'],
            concurrency: 5,
            paused: true,
            running: true,
          },
        ],
      }),
    ]);

    const wrapper = await mountDashboard();

    await wrapper.find('.hz-action').trigger('click');
    await settle();

    expect(stub.calls.post).toContain('/supervisors/supervisor-fast/resume');
  });

  it('says "1 minute", not "1 minutes"', async () => {
    stub.on('/stats', stats({ maxWait: 60 }));
    stub.on('/workload', [
      { name: 'reports', length: 40, delayed: 4, wait: 60, processes: 2, paused: false },
      { name: 'mail', length: 0, delayed: 0, wait: 7200, processes: 3, paused: false },
    ] as Workload[]);
    stub.on('/masters', [master()]);

    const wrapper = await mountDashboard();
    const text = wrapper.text();

    expect(text).toContain('1 minute');
    expect(text).not.toContain('1 minutes');
    expect(text).toContain('2 hours');
  });
});
