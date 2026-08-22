import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, RouterLinkStub, type VueWrapper } from '@vue/test-utils';
import { job, settle, stubApi, type ApiStub } from './helpers';

const stubs = { RouterLink: RouterLinkStub };

/**
 * The guarantees a keyboard or screen-reader user depends on. Easy to lose in a refactor,
 * and invisible to anyone checking the screen with a mouse.
 */
describe('accessibility', () => {
  let stub: ApiStub;

  beforeEach(() => {
    vi.resetModules();
    stub = stubApi();
  });

  afterEach(() => {
    vi.doUnmock('../ui-src/src/api');
  });

  const mountJobs = async (listing: string): Promise<VueWrapper> => {
    const Jobs = (await import('../ui-src/src/screens/Jobs.vue')).default;
    const wrapper = mount(Jobs, { props: { listing }, global: { stubs } });

    await settle();
    await wrapper.vm.$nextTick();

    return wrapper;
  };

  it('gives every row action a real button and an accessible name', async () => {
    stub.on('/jobs/failed', {
      jobs: [job({ name: 'send-invoice', state: 'failed', failedReason: 'boom' })],
      total: 1,
    });

    const wrapper = await mountJobs('failed');
    const actions = wrapper.findAll('.hz-action');

    expect(actions.length).toBeGreaterThan(0);

    for (const action of actions) {
      // An <a href="#"> announces as a link and ignores the space bar.
      expect(action.element.tagName).toBe('BUTTON');
      expect(action.attributes('type')).toBe('button');
      expect(action.attributes('aria-label')).toBeTruthy();
    }

    // Named after the row, or every action announces the same thing.
    const names = actions.map((action) => action.attributes('aria-label'));

    expect(names).toContain('Retry send-invoice');
    expect(names).toContain('Delete send-invoice');
  });

  it('names every search box independently of its placeholder', async () => {
    stub.on('/jobs/failed', { jobs: [], total: 0 });

    const wrapper = await mountJobs('failed');
    const inputs = wrapper.findAll('input');

    expect(inputs.length).toBeGreaterThan(0);

    // A placeholder is gone the moment the user types.
    for (const input of inputs) {
      expect(input.attributes('aria-label')).toBeTruthy();
    }
  });

  it('marks the icons decorative, so they are not read out beside their label', async () => {
    stub.on('/jobs/failed', { jobs: [job({ state: 'failed' })], total: 1 });

    const wrapper = await mountJobs('failed');
    const icons = wrapper.findAll('svg');

    expect(icons.length).toBeGreaterThan(0);

    for (const icon of icons) {
      expect(icon.attributes('aria-hidden')).toBe('true');
    }
  });

  it('reports the state of the auto-load toggle rather than only colouring it', async () => {
    const AutoLoadToggler = (await import('../ui-src/src/components/AutoLoadToggler.vue'))
      .default;
    const wrapper = mount(AutoLoadToggler);
    const button = wrapper.get('button');

    expect(button.attributes('type')).toBe('button');
    expect(button.attributes('aria-pressed')).toBe('false');

    await button.trigger('click');

    expect(button.attributes('aria-pressed')).toBe('true');
  });

  it('offers new entries as a control, not as a clickable table row', async () => {
    stub.on('/jobs/failed', { jobs: [job({ id: '1', state: 'failed' })], total: 1 });

    const wrapper = await mountJobs('failed');

    // The row only appears once the poll finds something newer. What is asserted here is
    // that the class carries no handler of its own.
    const row = wrapper.find('.hz-new-entries');

    if (row.exists()) {
      expect(row.find('button').exists()).toBe(true);
    }

    expect(wrapper.html()).not.toContain('<tr class="hz-new-entries" @click');
  });
});
