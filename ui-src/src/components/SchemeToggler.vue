<template>
  <button
    type="button"
    class="btn btn-sm hz-scheme"
    title="Switch theme"
    :aria-label="`Switch theme, currently ${scheme}`"
    @click="cycle"
  >
    <svg
      v-if="scheme === 'system'"
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="currentColor"
      width="18"
      height="18"
    >
      <path
        fill-rule="evenodd"
        d="M2 4.25A2.25 2.25 0 014.25 2h11.5A2.25 2.25 0 0118 4.25v8.5A2.25 2.25 0 0115.75 15h-3.105a3.501 3.501 0 001.1 1.677A.75.75 0 0113.26 18H6.74a.75.75 0 01-.484-1.323A3.501 3.501 0 007.355 15H4.25A2.25 2.25 0 012 12.75v-8.5zm1.5 0a.75.75 0 01.75-.75h11.5a.75.75 0 01.75.75v7.5a.75.75 0 01-.75.75H4.25a.75.75 0 01-.75-.75v-7.5z"
        clip-rule="evenodd"
      />
    </svg>
    <svg
      v-if="scheme === 'dark'"
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="currentColor"
      width="18"
      height="18"
    >
      <path
        fill-rule="evenodd"
        d="M7.455 2.004a.75.75 0 01.26.77 7 7 0 009.958 7.967.75.75 0 011.067.853A8.5 8.5 0 116.647 1.921a.75.75 0 01.808.083z"
        clip-rule="evenodd"
      />
    </svg>
    <svg
      v-if="scheme === 'light'"
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="currentColor"
      width="18"
      height="18"
    >
      <path
        d="M10 2a.75.75 0 01.75.75v1.5a.75.75 0 01-1.5 0v-1.5A.75.75 0 0110 2zM10 15a.75.75 0 01.75.75v1.5a.75.75 0 01-1.5 0v-1.5A.75.75 0 0110 15zM10 7a3 3 0 100 6 3 3 0 000-6zM15.657 5.404a.75.75 0 10-1.06-1.06l-1.061 1.06a.75.75 0 001.06 1.06l1.06-1.06zM6.464 14.596a.75.75 0 10-1.06-1.06l-1.06 1.06a.75.75 0 001.06 1.06l1.06-1.06zM18 10a.75.75 0 01-.75.75h-1.5a.75.75 0 010-1.5h1.5A.75.75 0 0118 10zM5 10a.75.75 0 01-.75.75h-1.5a.75.75 0 010-1.5h1.5A.75.75 0 015 10zM14.596 15.657a.75.75 0 001.06-1.06l-1.06-1.061a.75.75 0 10-1.06 1.06l1.06 1.06zM5.404 6.464a.75.75 0 001.06-1.06l-1.06-1.06a.75.75 0 10-1.061 1.06l1.06 1.06z"
      />
    </svg>
  </button>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

type Scheme = 'system' | 'dark' | 'light';

const STORAGE_KEY = 'sentinelColorScheme';
const NEXT: Record<Scheme, Scheme> = { system: 'dark', dark: 'light', light: 'system' };

const scheme = ref<Scheme>('system');
const query = window.matchMedia('(prefers-color-scheme: dark)');

/** Bootstrap 5.3 reads the scheme from this attribute. */
const apply = () => {
  const dark = scheme.value === 'system' ? query.matches : scheme.value === 'dark';

  document.documentElement.setAttribute('data-bs-theme', dark ? 'dark' : 'light');
};

const cycle = () => {
  scheme.value = NEXT[scheme.value];
  localStorage.setItem(STORAGE_KEY, scheme.value);
  apply();
};

onMounted(() => {
  scheme.value = (localStorage.getItem(STORAGE_KEY) as Scheme | null) ?? 'system';
  // The listener only changes anything while the choice is still 'system'.
  query.addEventListener('change', apply);
  apply();
});

onBeforeUnmount(() => query.removeEventListener('change', apply));
</script>
