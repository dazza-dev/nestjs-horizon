import type { Redis } from 'ioredis';
import { eachNode } from './client';

/** Keys per SCAN round. COUNT is a hint, not a guarantee. */
const BATCH = 500;

/** Every key matching a pattern, walked with SCAN rather than KEYS. */
export const scanKeys = async (redis: Redis, pattern: string): Promise<string[]> => {
  const perNode = await eachNode(redis, async (node) => {
    let cursor = '0';
    const found: string[] = [];

    do {
      const [next, keys] = await node.scan(cursor, 'MATCH', pattern, 'COUNT', BATCH);

      cursor = next;
      found.push(...keys);
    } while (cursor !== '0');

    return found;
  });

  return perNode.flat();
};

/**
 * Deletes every key matching a pattern with SCAN rather than KEYS, which blocks Redis
 * for as long as it runs.
 */
export const deleteMatching = async (redis: Redis, pattern: string): Promise<number> => {
  const counts = await eachNode(redis, async (node) => {
    let cursor = '0';
    let removed = 0;

    do {
      const [next, keys] = await node.scan(cursor, 'MATCH', pattern, 'COUNT', BATCH);

      cursor = next;

      if (keys.length) {
        // One key per DEL: a multi-key DEL is refused when the keys span cluster slots.
        const results = await Promise.all(keys.map((key) => node.del(key)));

        removed += results.reduce((total, n) => total + n, 0);
      }
    } while (cursor !== '0');

    return removed;
  });

  return counts.reduce((total, n) => total + n, 0);
};
