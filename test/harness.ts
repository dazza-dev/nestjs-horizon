import { Redis } from 'ioredis';
import type { SentinelConnection } from '../src';

/**
 * Integration tests, not unit tests. Atomic counters, TTLs and locks are the behaviour
 * under test; a mocked client would only assert that we call the methods we call.
 */
export const connection = (): SentinelConnection => ({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: Number(process.env.REDIS_PORT ?? 6379),
  db: Number(process.env.REDIS_TEST_DB ?? 15),
});

export const client = (): Redis => new Redis(connection());

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface Result {
  label: string;
  ok: boolean;
  detail: string;

  /** A check that did not run. Counted apart from the passes. */
  skipped?: boolean;
}

/** Collects the assertions of one suite. */
export class Suite {
  readonly results: Result[] = [];

  constructor(readonly name: string) {}

  check(label: string, ok: boolean, detail = ''): void {
    this.results.push({ label, ok, detail });
  }

  /** Marks a check as not run, instead of quietly passing it. */
  skip(label: string, detail = ''): void {
    this.results.push({ label, ok: true, detail, skipped: true });
  }

  get failed(): number {
    return this.results.filter((result) => !result.ok).length;
  }

  get skipped(): number {
    return this.results.filter((result) => result.skipped).length;
  }
}

/** Deletes every key a suite wrote. Reruns start from a clean db. */
export const wipe = async (prefix: string): Promise<void> => {
  const redis = client();
  const keys = await redis.keys(`${prefix}*`);

  if (keys.length) {
    await redis.del(...keys);
  }

  await redis.quit();
};
