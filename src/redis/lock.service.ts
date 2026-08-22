import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Redis } from 'ioredis';
import { SENTINEL_OPTIONS, SENTINEL_REDIS } from '../sentinel.constants';
import type { SentinelOptions } from '../sentinel.types';
import { resolvePrefix } from '../sentinel.options';

/**
 * Picks one process to do a job the whole fleet must only do once.
 *
 * Snapshots and wait alerts run on a timer; without this every process would fire them.
 * A plain `SET NX PX`: a process that dies holding the lock blocks nobody past its TTL.
 */
@Injectable()
export class LockService {
  private readonly prefix: string;
  private readonly owner = randomUUID();

  constructor(
    @Inject(SENTINEL_OPTIONS) options: SentinelOptions,
    @Inject(SENTINEL_REDIS) private readonly redis: Redis,
  ) {
    this.prefix = resolvePrefix(options);
  }

  /**
   * Runs `work` only if this process wins the lock for `name`.
   *
   * `ttlMs` should sit just under the interval that calls it, so a dead leader is
   * replaced by the next tick.
   */
  async once(name: string, ttlMs: number, work: () => Promise<void>): Promise<boolean> {
    const key = `${this.prefix}:lock:${name}`;
    const won = await this.redis.set(key, this.owner, 'PX', Math.max(1000, ttlMs), 'NX');

    if (won !== 'OK') {
      return false;
    }

    await work();

    return true;
  }
}
