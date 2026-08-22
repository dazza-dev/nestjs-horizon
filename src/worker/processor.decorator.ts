import { Injectable, SetMetadata } from '@nestjs/common';
import type { Job } from 'bullmq';
import type { JobContext } from './job-context';
import { SENTINEL_PROCESSOR } from '../sentinel.constants';

export interface ProcessorMetadata {
  queue: string;
}

/**
 * Marks a provider as the handler for a queue.
 *
 * Concurrency belongs to the supervisor that owns the queue, not here, which keeps it
 * configurable without a code change.
 */
export const SentinelProcessor = (queue: string): ClassDecorator => {
  return (target) => {
    Injectable()(target);
    SetMetadata<symbol, ProcessorMetadata>(SENTINEL_PROCESSOR, { queue })(target);
  };
};

/** Contract every processor implements. */
// Defaults an implementation is meant to narrow; `unknown` would force a cast in every one.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface JobHandler<T = any, R = any> {
  /**
   * `context` is optional, so a handler that only needs the job can take one argument.
   * It carries `release()`, for work that is not ready yet.
   */
  handle(job: Job<T>, context?: JobContext): Promise<R>;
}
