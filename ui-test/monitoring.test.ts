import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, RouterLinkStub, type VueWrapper } from '@vue/test-utils';
import { acceptConfirm, job, settle, stubApi, type ApiStub } from './helpers';

const route = { params: { tag: 'customer:42' }, query: {} as Record<string, string> };
const replace = vi.fn();

vi.mock('vue-router', async () => {
  const actual = await vi.importActual<typeof import('vue-router')>('vue-router');

  return {
    ...actual,
    useRoute: () => route,
    useRouter: () => ({ replace }),
  };
});

const stubs = { RouterLink: RouterLinkStub };

describe('Monitoring', () => {
  let stub: ApiStub;

  beforeEach(() => {
    vi.resetModules();
    stub = stubApi();
    replace.mockClear();
    route.query = {};
  });

  afterEach(() => {
    vi.doUnmock('../ui-src/src/api');
  });

  const mountIndex = async (): Promise<VueWrapper> => {
    const Monitoring = (await import('../ui-src/src/screens/Monitoring.vue')).default;
    const wrapper = mount(Monitoring, { global: { stubs } });

    await settle();
    await wrapper.vm.$nextTick();

    return wrapper;
  };

  const mountTag = async (): Promise<VueWrapper> => {
    const MonitoredTag = (await import('../ui-src/src/screens/MonitoredTag.vue')).default;
    const wrapper = mount(MonitoredTag, { global: { stubs } });

    await settle();
    await wrapper.vm.$nextTick();

    return wrapper;
  };

  it('counts jobs and failures apart', async () => {
    stub.on('/monitoring', [
      { tag: 'customer:42', count: 12, failed: 3 },
      { tag: 'nightly', count: 4, failed: 0 },
    ]);

    const wrapper = await mountIndex();
    const rows = wrapper.findAll('tbody tr');

    expect(wrapper.text()).toContain('Monitored Tags (2)');
    expect(rows[0].text()).toContain('12');
    expect(rows[0].text()).toContain('3');
    expect(rows[0].find('.hz-failed-count').exists()).toBe(true);

    // A tag with no failures must not shout in red.
    expect(rows[1].find('.hz-failed-count').exists()).toBe(false);
  });

  it('explains itself when nothing is monitored', async () => {
    stub.on('/monitoring', []);

    const wrapper = await mountIndex();

    expect(wrapper.text()).toContain('No tags are being monitored');
  });

  it('monitors and stops monitoring a tag', async () => {
    stub.on('/monitoring', [{ tag: 'nightly', count: 1, failed: 0 }]);

    const wrapper = await mountIndex();

    await wrapper.find('input').setValue('customer:42');
    await wrapper.find('form').trigger('submit');
    await settle();

    expect(stub.calls.post).toContain('/monitoring?tag=customer%3A42');

    await wrapper.find('.hz-action-danger').trigger('click');
    await acceptConfirm();

    expect(stub.calls.del).toContain('/monitoring?tag=nightly');
  });

  it('will not monitor an empty tag', async () => {
    stub.on('/monitoring', []);

    const wrapper = await mountIndex();
    const button = wrapper.find('button');

    expect(button.attributes('disabled')).toBeDefined();

    await wrapper.find('input').setValue('  ');
    expect(wrapper.find('button').attributes('disabled')).toBeDefined();
  });

  it('opens a tag on its recent jobs', async () => {
    stub.on('/monitoring/jobs', { jobs: [job({ name: 'invoice' })], total: 1 });

    const wrapper = await mountTag();

    expect(wrapper.text()).toContain('Recent Jobs for "customer:42"');
    expect(wrapper.text()).toContain('invoice');
    expect(stub.calls.get[0]).toContain('tag=customer%3A42');
    expect(stub.calls.get[0]).toContain('type=jobs');
  });

  it('marks the tab the query string asks for', async () => {
    stub.on('/monitoring/jobs', { jobs: [], total: 0 });
    route.query = { type: 'failed' };

    const wrapper = await mountTag();
    const active = wrapper.findAll('.hz-tab').filter((tab) => tab.classes('hz-tab-on'));

    expect(active).toHaveLength(1);
    expect(active[0].text()).toBe('Failed Jobs');
    expect(stub.calls.get[0]).toContain('type=failed');
    expect(wrapper.text()).toContain('No failures carrying this tag.');
  });

  it('points each tab at its own query, so both are real links', async () => {
    stub.on('/monitoring/jobs', { jobs: [], total: 0 });

    const wrapper = await mountTag();
    const tabs = wrapper
      .findAllComponents(RouterLinkStub)
      .filter((tab) => tab.classes().includes('hz-tab'));

    expect(tabs).toHaveLength(2);
    expect(tabs[0].props('to')).toEqual({ query: {} });
    expect(tabs[1].props('to')).toEqual({ query: { type: 'failed' } });

    expect(tabs[0].attributes('aria-current')).toBe('page');
    expect(tabs[1].attributes('aria-current')).toBeUndefined();
  });
});
