/** Thrown when a job outlives its timeout. */
export class JobTimeoutError extends Error {
  constructor(seconds: number) {
    super(`Job exceeded its timeout of ${seconds}s`);
    this.name = 'JobTimeoutError';
  }
}

/**
 * Fails a job that runs longer than `seconds`, and tells it so.
 *
 * Nothing in Node interrupts a running promise: the slot is released and the job marked
 * failed while the work carries on. `onExpire` raises the signal behind `ctx.aborted`,
 * which a long handler can watch to stop itself.
 */
export async function withTimeout<T>(
  work: Promise<T>,
  seconds: number | undefined,
  onExpire?: () => void,
): Promise<T> {
  if (!seconds || seconds <= 0) {
    return work;
  }

  let timer: NodeJS.Timeout | undefined;

  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onExpire?.();
      reject(new JobTimeoutError(seconds));
    }, seconds * 1000);
  });

  try {
    return await Promise.race([work, expiry]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/** One signal that fires when the worker is shutting down or the job ran out of time. */
export function abortSignalFor(shutdown?: AbortSignal): AbortController {
  const controller = new AbortController();

  if (!shutdown) {
    return controller;
  }

  if (shutdown.aborted) {
    controller.abort();

    return controller;
  }

  shutdown.addEventListener('abort', () => controller.abort(), { once: true });

  return controller;
}
