import { vi } from 'vitest';
import type { JobView } from '../ui-src/src/api';

/** Every request a screen made, in order. */
export interface ApiCalls {
  get: string[];
  post: string[];
  del: string[];
}

export interface ApiStub {
  calls: ApiCalls;

  /** Answers a GET whose path starts with `prefix`. */
  on(prefix: string, body: unknown): void;
}

/**
 * Replaces the api module for one test file.
 *
 * Only the transport is stubbed. The screens keep running their real watchers, filters
 * and click handlers.
 */
export const stubApi = (): ApiStub => {
  const calls: ApiCalls = { get: [], post: [], del: [] };
  const routes: { prefix: string; body: unknown }[] = [];

  const answer = (path: string): unknown => {
    const match = routes
      .filter((route) => path.startsWith(route.prefix))
      .sort((a, b) => b.prefix.length - a.prefix.length)[0];

    return match ? match.body : {};
  };

  vi.doMock('../ui-src/src/api', async () => {
    const actual =
      await vi.importActual<typeof import('../ui-src/src/api')>('../ui-src/src/api');

    return {
      ...actual,
      api: {
        get: (path: string) => {
          calls.get.push(path);

          return Promise.resolve(answer(path));
        },
        post: (path: string) => {
          calls.post.push(path);

          return Promise.resolve({});
        },
        del: (path: string) => {
          calls.del.push(path);

          return Promise.resolve({});
        },
      },
    };
  });

  return {
    calls,
    on: (prefix, body) => routes.push({ prefix, body }),
  };
};

/** A job as the API returns it; overrides spell out what a test cares about. */
export const job = (overrides: Partial<JobView> = {}): JobView => ({
  id: '1',
  queue: 'default',
  name: 'send-email',
  state: 'completed',
  attempts: 1,
  data: {},
  tags: [],
  attemptTraces: [],
  manualRetries: [],
  createdAt: 1_700_000_000_000,
  startedAt: 1_700_000_000_000,
  finishedAt: 1_700_000_001_000,
  runtime: 1000,
  ...overrides,
});

/** Lets the component finish the promises it kicked off on mount. */
export const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

/**
 * Answers the confirmation the action just raised.
 *
 * Imported at call time, not at the top. The screens are imported after
 * `vi.resetModules()`, and a static import here would pin the previous instance of the
 * module they talk to.
 */
const answerConfirm = async (confirmed: boolean): Promise<void> => {
  const { pending } = await import('../ui-src/src/confirm');

  await settle();
  pending.value?.settle(confirmed);
  await settle();
};

export const acceptConfirm = (): Promise<void> => answerConfirm(true);

export const declineConfirm = (): Promise<void> => answerConfirm(false);

/** Whether an action is waiting on the operator. */
export const confirmPending = async (): Promise<boolean> => {
  const { pending } = await import('../ui-src/src/confirm');

  return pending.value !== null;
};
