import { onMounted, onUnmounted } from 'vue';

/**
 * Polls while the tab is visible and stops while it is not.
 *
 * `fn` must return its promise. The catch below misses it otherwise.
 */
export const usePoll = (fn: () => void | Promise<void>, everyMs = 5000): void => {
  const run = () => {
    // Unguarded, a rejected poll is an unhandled rejection every few seconds.
    void Promise.resolve(fn()).catch(() => undefined);
  };

  let timer: number | undefined;

  const stop = () => {
    window.clearInterval(timer);
    timer = undefined;
  };

  const start = () => {
    if (timer === undefined) {
      timer = window.setInterval(run, everyMs);
    }
  };

  const onVisibility = () => {
    if (document.hidden) {
      stop();

      return;
    }

    run();
    start();
  };

  onMounted(() => {
    // A tab restored in the background must not poll before anyone looks at it.
    if (!document.hidden) {
      start();
    }

    document.addEventListener('visibilitychange', onVisibility);
  });

  onUnmounted(() => {
    stop();
    document.removeEventListener('visibilitychange', onVisibility);
  });
};
