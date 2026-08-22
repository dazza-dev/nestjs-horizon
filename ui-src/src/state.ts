import { ref, watch } from 'vue';

const STORAGE_KEY = 'sentinelAutoLoadsNewEntries';

/**
 * Whether listing screens refresh themselves. When off they hold their rows and offer to
 * load what arrived, instead of moving a table someone is reading.
 */
export const autoLoad = ref(localStorage.getItem(STORAGE_KEY) === '1');

watch(autoLoad, (value) => localStorage.setItem(STORAGE_KEY, value ? '1' : '0'));

export const toggleAutoLoad = (): void => {
  autoLoad.value = !autoLoad.value;
};
