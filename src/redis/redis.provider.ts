import { Provider } from '@nestjs/common';
import { Redis } from 'ioredis';
import { SENTINEL_OPTIONS, SENTINEL_REDIS } from '../sentinel.constants';
import type { SentinelOptions } from '../sentinel.types';
import { ClientRegistry, createClient } from './client';

/** One shared client for everything that is not a queue: metrics, batches, registry. */
export const redisProvider: Provider = {
  provide: SENTINEL_REDIS,
  inject: [SENTINEL_OPTIONS, ClientRegistry],
  useFactory: (options: SentinelOptions, clients: ClientRegistry): Redis =>
    createClient(options.connection, clients),
};
