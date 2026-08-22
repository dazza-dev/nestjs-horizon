<template>
  <!-- Native dialog: focus trap, Escape to close and an inert page behind, none of it
       hand-rolled. -->
  <dialog
    ref="dialog"
    class="hz-confirm"
    aria-labelledby="hz-confirm-title"
    @cancel.prevent="decline"
    @click="onBackdrop"
  >
    <div v-if="pending" class="hz-confirm-body">
      <h2 id="hz-confirm-title" class="hz-confirm-title">{{ pending.title }}</h2>
      <p v-if="pending.body" class="hz-confirm-text">{{ pending.body }}</p>

      <div class="hz-confirm-actions">
        <button
          ref="cancel"
          type="button"
          class="btn btn-sm btn-outline-secondary"
          @click="decline"
        >
          Cancel
        </button>
        <button
          type="button"
          class="btn btn-sm"
          :class="pending.tone === 'primary' ? 'btn-primary' : 'hz-confirm-danger'"
          @click="accept"
        >
          {{ pending.confirmLabel }}
        </button>
      </div>
    </div>
  </dialog>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { pending } from '../confirm';

const dialog = ref<HTMLDialogElement | null>(null);
const cancel = ref<HTMLButtonElement | null>(null);

const decline = () => pending.value?.settle(false);

// Unmounting with a question on screen would leave its promise unresolved for good.
onBeforeUnmount(() => pending.value?.settle(false));
const accept = () => pending.value?.settle(true);

/** Clicking the backdrop declines. */
const onBackdrop = (event: MouseEvent) => {
  if (event.target === dialog.value) {
    decline();
  }
};

watch(pending, async (request) => {
  if (!request) {
    dialog.value?.close();

    return;
  }

  // showModal() throws on an open dialog, and a second request replaces the first
  // without closing in between.
  if (!dialog.value?.open) {
    dialog.value?.showModal();
  }

  await nextTick();

  // Cancel takes focus: the destructive button should never be one Enter away.
  cancel.value?.focus();
});
</script>
