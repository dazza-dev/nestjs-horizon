import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, RouterLinkStub, type VueWrapper } from '@vue/test-utils';
import {
  acceptConfirm,
  confirmPending,
  declineConfirm,
  job,
  settle,
  stubApi,
  type ApiStub,
} from './helpers';

const stubs = { RouterLink: RouterLinkStub };

describe('confirmation', () => {
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

  const failedListing = () =>
    stub.on('/jobs/failed', {
      jobs: [job({ id: '7', queue: 'mail', name: 'send-invoice', state: 'failed' })],
      total: 1,
    });

  it('does not delete until the operator says so', async () => {
    failedListing();

    const wrapper = await mountJobs('failed');

    await wrapper.find('.hz-action-danger').trigger('click');
    await settle();

    expect(await confirmPending()).toBe(true);
    expect(stub.calls.del).toHaveLength(0);

    await declineConfirm();

    expect(stub.calls.del).toHaveLength(0);
    expect(await confirmPending()).toBe(false);
  });

  it('deletes once it is confirmed', async () => {
    failedListing();

    const wrapper = await mountJobs('failed');

    await wrapper.find('.hz-action-danger').trigger('click');
    await acceptConfirm();

    expect(stub.calls.del).toContain('/jobs/mail/7');
  });

  it('does not retry every failure until it is confirmed', async () => {
    failedListing();

    const wrapper = await mountJobs('failed');
    const retryAll = wrapper
      .findAll('button')
      .find((button) => button.text().includes('Retry all'));

    expect(retryAll).toBeDefined();

    await retryAll!.trigger('click');
    await declineConfirm();

    expect(stub.calls.post).toHaveLength(0);
  });

  it('names the job in the question, so the wrong row is obvious', async () => {
    failedListing();

    const wrapper = await mountJobs('failed');

    await wrapper.find('.hz-action-danger').trigger('click');
    await settle();

    const { pending } = await import('../ui-src/src/confirm');

    expect(pending.value?.title).toContain('send-invoice');
    expect(pending.value?.confirmLabel).toBe('Delete job');

    await declineConfirm();
  });
});

describe('ConfirmDialog', () => {
  beforeEach(() => vi.resetModules());

  const mountDialog = async (): Promise<VueWrapper> => {
    const ConfirmDialog = (await import('../ui-src/src/components/ConfirmDialog.vue'))
      .default;

    // jsdom implements <dialog> without its methods.
    HTMLDialogElement.prototype.showModal = vi.fn();
    HTMLDialogElement.prototype.close = vi.fn();

    return mount(ConfirmDialog, { attachTo: document.body });
  };

  it('shows the question and resolves what the operator chose', async () => {
    const wrapper = await mountDialog();
    const { confirm } = await import('../ui-src/src/confirm');

    const answer = confirm({
      title: 'Delete send-invoice?',
      body: 'This cannot be undone.',
      confirmLabel: 'Delete job',
    });

    await wrapper.vm.$nextTick();

    expect(wrapper.text()).toContain('Delete send-invoice?');
    expect(wrapper.text()).toContain('This cannot be undone.');

    const buttons = wrapper.findAll('button');
    const confirmButton = buttons.find((b) => b.text() === 'Delete job');

    // A destructive action must not wear the same colour as a safe one.
    expect(confirmButton?.classes()).toContain('hz-confirm-danger');

    await confirmButton!.trigger('click');

    expect(await answer).toBe(true);

    wrapper.unmount();
  });

  it('resolves false on Cancel', async () => {
    const wrapper = await mountDialog();
    const { confirm } = await import('../ui-src/src/confirm');

    const answer = confirm({ title: 'Pause main?', confirmLabel: 'Pause supervisor' });

    await wrapper.vm.$nextTick();
    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Cancel')!
      .trigger('click');

    expect(await answer).toBe(false);

    wrapper.unmount();
  });

  it('resolves false when Escape closes it', async () => {
    const wrapper = await mountDialog();
    const { confirm } = await import('../ui-src/src/confirm');

    const answer = confirm({ title: 'Delete?', confirmLabel: 'Delete' });

    await wrapper.vm.$nextTick();

    // The browser fires `cancel` on Escape; the dialog must settle rather than strand it.
    await wrapper.find('dialog').trigger('cancel');

    expect(await answer).toBe(false);

    wrapper.unmount();
  });

  it('is labelled by its own title', async () => {
    const wrapper = await mountDialog();
    const { confirm } = await import('../ui-src/src/confirm');

    const answer = confirm({ title: 'Cancel batch?', confirmLabel: 'Cancel batch' });

    await wrapper.vm.$nextTick();

    const dialog = wrapper.find('dialog');
    const labelledBy = dialog.attributes('aria-labelledby');

    expect(labelledBy).toBeTruthy();
    expect(wrapper.find(`#${labelledBy}`).text()).toBe('Cancel batch?');

    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Cancel')!
      .trigger('click');
    await answer;

    wrapper.unmount();
  });

  it('replaces a question already on screen without reopening the dialog', async () => {
    const ConfirmDialog = (await import('../ui-src/src/components/ConfirmDialog.vue'))
      .default;

    // jsdom ships <dialog> without its methods. The mock keeps `open` in step the way a
    // browser does, or the guard under test is never reached.
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
      if (this.open) {
        throw new Error('InvalidStateError: dialog is already open');
      }

      this.open = true;
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
      this.open = false;
    });

    const wrapper = mount(ConfirmDialog, { attachTo: document.body });
    const { confirm } = await import('../ui-src/src/confirm');

    const first = confirm({ title: 'Delete one?', confirmLabel: 'Delete' });

    await wrapper.vm.$nextTick();

    const second = confirm({ title: 'Delete two?', confirmLabel: 'Delete' });

    await wrapper.vm.$nextTick();

    // The first is answered for the operator rather than stranded.
    expect(await first).toBe(false);
    expect(wrapper.text()).toContain('Delete two?');

    // Opened once for both questions: a second showModal() on an open dialog throws.
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledTimes(1);

    await wrapper
      .findAll('button')
      .find((b) => b.text() === 'Cancel')!
      .trigger('click');

    expect(await second).toBe(false);

    wrapper.unmount();
  });

  it('settles a pending question when it is unmounted', async () => {
    const wrapper = await mountDialog();
    const { confirm } = await import('../ui-src/src/confirm');

    const answer = confirm({ title: 'Cancel batch?', confirmLabel: 'Cancel batch' });

    await wrapper.vm.$nextTick();
    wrapper.unmount();

    // Otherwise the caller waits on a promise nothing can resolve.
    expect(await answer).toBe(false);
  });
});
