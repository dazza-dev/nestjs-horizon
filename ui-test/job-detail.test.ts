import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, RouterLinkStub, type VueWrapper } from '@vue/test-utils';
import { acceptConfirm, job, settle, stubApi, type ApiStub } from './helpers';

const route = { params: { queue: 'mail', id: '7' } };
const push = vi.fn();

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router');

  return { ...actual, useRoute: () => route, useRouter: () => ({ push }) };
});

describe('JobDetail', () => {
  let stub: ApiStub;

  beforeEach(() => {
    vi.resetModules();
    stub = stubApi();
    push.mockClear();
  });

  afterEach(() => {
    vi.doUnmock('../ui-src/src/api');
  });

  const mountDetail = async (): Promise<VueWrapper> => {
    const JobDetail = (await import('../ui-src/src/screens/JobDetail.vue')).default;
    const wrapper = mount(JobDetail, {
      global: { stubs: { RouterLink: RouterLinkStub } },
    });

    await settle();
    await wrapper.vm.$nextTick();

    return wrapper;
  };

  const rows = (wrapper: VueWrapper): Record<string, string> =>
    Object.fromEntries(
      wrapper
        .findAll('.hz-detail-row')
        .map((row) => [
          row.find('.hz-detail-label').text(),
          row.find('.hz-detail-value').text(),
        ]),
    );

  it('shows the tags of the job', async () => {
    stub.on('/jobs/mail/7', job({ tags: ['customer:42', 'invoices'] }));

    expect(rows(await mountDetail()).Tags).toBe('customer:42, invoices');
  });

  it('says so when the job has no tags', async () => {
    stub.on('/jobs/mail/7', job({ tags: [] }));

    expect(rows(await mountDetail()).Tags).toBe('-');
  });

  it('reports queue, attempts and runtime', async () => {
    stub.on('/jobs/mail/7', job({ queue: 'mail', attempts: 3, runtime: 1500 }));

    const detail = rows(await mountDetail());

    expect(detail.Queue).toBe('mail');
    expect(detail.Attempts).toBe('3');
    expect(detail.Runtime).toBe('1.50s');
  });

  it('links to the batch a job belongs to', async () => {
    stub.on('/jobs/mail/7', job({ data: { batchId: 'abc-123' } }));

    const wrapper = await mountDetail();
    const link = wrapper.findComponent(RouterLinkStub);

    expect(link.props('to')).toBe('/batches/abc-123');
  });

  it('offers retry only on a failed job', async () => {
    stub.on('/jobs/mail/7', job());
    const clean = await mountDetail();

    expect(clean.find('button').exists()).toBe(false);

    vi.resetModules();
    stub = stubApi();
    stub.on('/jobs/mail/7', job({ state: 'failed', failedReason: 'boom' }));

    const failed = await mountDetail();
    await failed.find('button').trigger('click');
    await acceptConfirm();

    expect(stub.calls.post).toContain('/jobs/mail/7/retry');

    // Back to the listing, where the job now is.
    expect(push).toHaveBeenCalledWith('/jobs/failed');
  });

  it('keeps one stack trace per attempt', async () => {
    stub.on(
      '/jobs/mail/7',
      job({
        state: 'failed',
        failedReason: 'boom',
        attemptTraces: ['Error: first\n  at a', 'Error: second\n  at b'],
      }),
    );

    const wrapper = await mountDetail();
    const buttons = wrapper.findAll('.btn-group button').map((btn) => btn.text());

    expect(buttons).toEqual(['#1', '#2']);
    expect(wrapper.text()).toContain('Error: first');

    await wrapper.findAll('.btn-group button')[1].trigger('click');
    expect(wrapper.text()).toContain('Error: second');
  });

  it('lists the manual retries and what each one led to', async () => {
    stub.on(
      '/jobs/mail/7',
      job({
        manualRetries: [
          { at: '2026-01-01T10:00:00.000Z', outcome: 'failed' },
          { at: '2026-01-01T11:00:00.000Z', outcome: null },
        ],
      }),
    );

    const wrapper = await mountDetail();

    expect(wrapper.text()).toContain('Retries');

    // The log has to carry the outcome. Timestamps alone cannot say which press was the
    // one that failed.
    expect(wrapper.text()).toContain('failed');
    expect(wrapper.text()).toContain('running');
  });
});
