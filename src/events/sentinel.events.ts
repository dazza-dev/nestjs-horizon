import { EventEmitter } from 'events';
import { Injectable, Logger } from '@nestjs/common';

export interface JobPushedEvent {
  queue: string;
  name: string;
  jobId: string;
}

/** Fired when a handler puts its job back on the queue. */
export interface JobReleasedEvent {
  queue: string;
  name: string;
  jobId: string;

  /** How long it asked to wait, in seconds. */
  delay: number;
}

/** Fired when a job is removed from the dashboard. */
export interface JobDeletedEvent {
  queue: string;
  name: string;
  jobId: string;
}

export interface JobStartedEvent {
  queue: string;
  name: string;
  jobId: string;

  /** Attempt number, starting at 1. */
  attempt: number;
}

export interface JobCompletedEvent {
  queue: string;
  name: string;
  jobId: string;
  runtime: number;
}

export interface JobFailedEvent {
  queue: string;
  name: string;
  jobId: string;
  error: string;

  /** True when the job has no attempts left; this failure is final. */
  exhausted: boolean;
  attempts: number;
}

export interface LongWaitEvent {
  queue: string;

  /**
   * Seconds the queue needs to drain at its current throughput, or null when it has a
   * backlog and nothing consuming it.
   */
  seconds: number | null;
  threshold: number;
}

export interface SupervisorEvent {
  supervisor: string;
}

export interface WorkerRetiringEvent {
  reason: string;
}

export interface BatchEvent {
  batchId: string;
  name: string;
}

/** Every event the package emits, with its payload. */
export interface SentinelEventMap {
  'job.pushed': JobPushedEvent;
  'job.started': JobStartedEvent;
  'job.completed': JobCompletedEvent;
  'job.failed': JobFailedEvent;
  'job.released': JobReleasedEvent;
  'job.deleted': JobDeletedEvent;
  'long-wait': LongWaitEvent;
  'supervisor.paused': SupervisorEvent;
  'supervisor.resumed': SupervisorEvent;
  'worker.retiring': WorkerRetiringEvent;
  'batch.finished': BatchEvent;
  'batch.cancelled': BatchEvent;
}

export type SentinelEventName = keyof SentinelEventMap;

/**
 * What the package announces as it works, so an application can plug in its own logging
 * or alerting. Inject it and call `on()` from anywhere.
 */
@Injectable()
export class SentinelEvents {
  private readonly logger = new Logger('Sentinel');
  private readonly emitter = new EventEmitter();

  constructor() {
    // No cap: an application may attach a listener per integration.
    this.emitter.setMaxListeners(0);
  }

  on<E extends SentinelEventName>(
    event: E,
    listener: (payload: SentinelEventMap[E]) => void,
  ): () => void {
    this.emitter.on(event, listener as (payload: unknown) => void);

    return () => this.emitter.off(event, listener as (payload: unknown) => void);
  }

  emit<E extends SentinelEventName>(event: E, payload: SentinelEventMap[E]): void {
    // Each listener is isolated. Node's emit runs them in a bare loop, where one that
    // throws silently cancels every listener registered after it.
    for (const listener of this.emitter.listeners(event)) {
      try {
        const result = (listener as (value: unknown) => unknown)(payload);

        // An async listener rejects after emit() has returned, which would reach Node
        // as an unhandled rejection and take the host process down.
        if (result instanceof Promise) {
          result.catch((error: Error) => this.report(event, error));
        }
      } catch (error) {
        this.report(event, error as Error);
      }
    }
  }

  /** A listener is the application's business, but a silent one is undebuggable. */
  private report(event: string, error: Error): void {
    this.logger.error(`Listener for "${event}" threw: ${error.message}`);
  }
}
