import { onUnmounted, watch, type WatchSource } from 'vue';

/**
 * Runs `fn` once the given sources stop changing.
 *
 * Unmounting drops the pending timer; it must not fire into a component that is gone.
 */
export const useDebounced = (
  sources: WatchSource | WatchSource[],
  fn: () => void,
  delayMs = 300,
): void => {
  let timer: number | undefined;

  watch(sources, () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(fn, delayMs);
  });

  onUnmounted(() => window.clearTimeout(timer));
};
