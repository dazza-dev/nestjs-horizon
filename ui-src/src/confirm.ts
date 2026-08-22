import { ref } from 'vue';

export interface ConfirmRequest {
  /** The question, as a short sentence. */
  title: string;

  /** What the action will do, when that is not obvious from the title. */
  body?: string;

  /** Names the action rather than saying "OK". */
  confirmLabel: string;

  /** `danger` for anything that destroys work or state. */
  tone?: 'danger' | 'primary';
}

interface PendingConfirm extends ConfirmRequest {
  settle: (confirmed: boolean) => void;
}

/** The request on screen, or null. One at a time: a modal cannot stack. */
export const pending = ref<PendingConfirm | null>(null);

/** Asks the operator before something irreversible. Resolves false when they decline. */
export const confirm = (request: ConfirmRequest): Promise<boolean> =>
  new Promise((resolve) => {
    // A second request while one is open would strand the first promise unresolved.
    pending.value?.settle(false);

    pending.value = {
      ...request,
      settle: (confirmed) => {
        pending.value = null;
        resolve(confirmed);
      },
    };
  });
