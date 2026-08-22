import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, RouterLinkStub, type VueWrapper } from '@vue/test-utils';
import { acceptConfirm, job, settle, stubApi, type ApiStub } from './helpers';

const mountJobs = async (listing: string): Promise<VueWrapper> => {
  const Jobs = (await import('../ui-src/src/screens/Jobs.vue')).default;

  const wrapper = mount(Jobs, {
    props: { listing },
    global: { stubs: { RouterLink: RouterLinkStub } },
  });

  await settle();
  await wrapper.vm.$nextTick();

  return wrapper;
};

describe('Jobs', () => {
  let stub: ApiStub;

  beforeEach(() => {
    vi.resetModules();
    stub = stubApi();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('../ui-src/src/api');
  });

  it('lists what the API returns', async () => {
    stub.on('/jobs/completed', {
      jobs: [job({ name: 'send-email' }), job({ id: '2', name: 'build-report' })],
      total: 2,
    });

    const wrapper = await mountJobs('completed');

    expect(wrapper.text()).toContain('Completed Jobs (2)');
    expect(wrapper.text()).toContain('send-email');
    expect(wrapper.text()).toContain('build-report');
  });

  it('shows the tags of a job as badges', async () => {
    stub.on('/jobs/completed', {
      jobs: [job({ tags: ['customer:42', 'monthly-close'] })],
      total: 1,
    });

    const wrapper = await mountJobs('completed');
    const tags = wrapper.findAll('.hz-tag').map((tag) => tag.text());

    expect(tags).toEqual(['customer:42', 'monthly-close']);
  });

  it('offers the tag filter only on the failed listing', async () => {
    stub.on('/jobs/completed', { jobs: [], total: 0 });
    stub.on('/jobs/failed', { jobs: [], total: 0 });

    const completed = await mountJobs('completed');
    const failed = await mountJobs('failed');

    const placeholders = (wrapper: VueWrapper) =>
      wrapper.findAll('input').map((input) => input.attributes('placeholder'));

    expect(placeholders(completed)).toEqual(['Search Jobs']);
    expect(placeholders(failed)).toEqual(['Search Tags', 'Search Jobs']);
  });

  it('sends the tag filter to the API', async () => {
    stub.on('/jobs/failed', { jobs: [], total: 0 });

    const wrapper = await mountJobs('failed');
    const tagInput = wrapper.findAll('input')[0];

    await tagInput.setValue('customer:42');
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(stub.calls.get.some((path) => path.includes('tag=customer%3A42'))).toBe(true);
  });

  it('only offers retry on failed jobs', async () => {
    stub.on('/jobs/completed', { jobs: [job()], total: 1 });
    stub.on('/jobs/failed', {
      jobs: [job({ state: 'failed', failedReason: 'boom' })],
      total: 1,
    });

    const completed = await mountJobs('completed');
    const failed = await mountJobs('failed');

    expect(completed.find('.hz-action-primary').exists()).toBe(false);
    expect(failed.find('.hz-action-primary').exists()).toBe(true);
    expect(failed.text()).toContain('Retry all');
  });

  it('retries and deletes through the API', async () => {
    stub.on('/jobs/failed', {
      jobs: [job({ id: '7', queue: 'mail', state: 'failed', failedReason: 'boom' })],
      total: 1,
    });

    const wrapper = await mountJobs('failed');

    await wrapper.find('.hz-action-primary').trigger('click');
    await acceptConfirm();
    expect(stub.calls.post).toContain('/jobs/mail/7/retry');

    await wrapper.find('.hz-action-danger').trigger('click');
    await acceptConfirm();
    expect(stub.calls.del).toContain('/jobs/mail/7');
  });

  it('names the silenced listing', async () => {
    stub.on('/jobs/silenced', { jobs: [], total: 0 });

    const wrapper = await mountJobs('silenced');

    expect(wrapper.text()).toContain('Silenced Jobs (0)');
    expect(wrapper.text()).toContain('Nothing here.');
  });
});
