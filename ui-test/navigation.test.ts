import { describe, expect, it } from 'vitest';
import { mount, RouterLinkStub } from '@vue/test-utils';
import { createRouter, createWebHistory } from 'vue-router';
import Sidebar from '../ui-src/src/components/Sidebar.vue';
import Pager from '../ui-src/src/components/Pager.vue';

/** The routes as router.ts declares them, resolved without mounting the whole app. */
const routes = async () => {
  const module = await import('../ui-src/src/router');

  return module.router.getRoutes().map((route) => route.path);
};

const mountSidebar = () => {
  const router = createRouter({ history: createWebHistory(), routes: [] });

  return mount(Sidebar, {
    global: { stubs: { RouterLink: RouterLinkStub }, plugins: [router] },
  });
};

describe('Sidebar', () => {
  const items = [
    ['Dashboard', '/'],
    ['Monitoring', '/monitoring'],
    ['Metrics', '/metrics/jobs'],
    ['Batches', '/batches'],
    ['Pending Jobs', '/jobs/pending'],
    ['Completed Jobs', '/jobs/completed'],
    ['Silenced Jobs', '/jobs/silenced'],
    ['Failed Jobs', '/jobs/failed'],
  ];

  it('lists every screen, in the order the sidebar declares them', () => {
    const wrapper = mountSidebar();
    const labels = wrapper.findAll('.nav-link span').map((span) => span.text());

    expect(labels).toEqual(items.map(([label]) => label));
  });

  it('points each entry at its screen', () => {
    const wrapper = mountSidebar();
    const targets = wrapper
      .findAllComponents(RouterLinkStub)
      .map((link) => link.props('to'));

    expect(targets).toEqual(items.map(([, to]) => to));
  });

  it('gives every entry an icon', () => {
    const paths = mountSidebar().findAll('svg path');

    expect(paths.length).toBeGreaterThanOrEqual(items.length);
  });
});

describe('router', () => {
  it('routes every screen the sidebar links to', async () => {
    const paths = await routes();

    for (const path of [
      '/',
      '/monitoring',
      '/monitoring/:tag',
      '/batches',
      '/batches/:id',
      '/metrics/:kind(jobs|queues)',
    ]) {
      expect(paths).toContain(path);
    }
  });

  it('accepts the silenced listing', async () => {
    const module = await import('../ui-src/src/router');
    const resolved = module.router.resolve('/jobs/silenced');

    expect(resolved.matched).toHaveLength(1);
    expect(resolved.params.listing).toBe('silenced');
  });

  it('tells a listing apart from a job detail', async () => {
    const module = await import('../ui-src/src/router');

    expect(module.router.resolve('/jobs/failed').params.listing).toBe('failed');

    const detail = module.router.resolve('/jobs/mail/7');
    expect(detail.params.queue).toBe('mail');
    expect(detail.params.id).toBe('7');
  });

  it('rejects a listing it does not have', async () => {
    const module = await import('../ui-src/src/router');
    const resolved = module.router.resolve('/jobs/nonsense');

    // It falls through to the job-detail route, not to the listing one.
    expect(resolved.params.listing).toBeUndefined();
  });
});

describe('Pager', () => {
  it('stays hidden when everything fits on one page', () => {
    const wrapper = mount(Pager, { props: { page: 0, perPage: 25, total: 10 } });

    expect(wrapper.find('button').exists()).toBe(false);
  });

  it('reports the range it is showing', () => {
    const wrapper = mount(Pager, { props: { page: 1, perPage: 25, total: 60 } });

    expect(wrapper.text()).toContain('26–50 of 60');
  });

  it('disables the edges', () => {
    const first = mount(Pager, { props: { page: 0, perPage: 25, total: 60 } });
    const last = mount(Pager, { props: { page: 2, perPage: 25, total: 60 } });

    expect(first.findAll('button')[0].attributes('disabled')).toBeDefined();
    expect(first.findAll('button')[1].attributes('disabled')).toBeUndefined();
    expect(last.findAll('button')[1].attributes('disabled')).toBeDefined();
  });

  it('emits which way it moved', async () => {
    const wrapper = mount(Pager, { props: { page: 1, perPage: 25, total: 60 } });

    await wrapper.findAll('button')[0].trigger('click');
    await wrapper.findAll('button')[1].trigger('click');

    expect(wrapper.emitted('go')).toEqual([[-1], [1]]);
  });
});
