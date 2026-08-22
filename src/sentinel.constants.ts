export const SENTINEL_OPTIONS = Symbol('SENTINEL_OPTIONS');
export const SENTINEL_PROCESSOR = Symbol('SENTINEL_PROCESSOR');
export const SENTINEL_REDIS = Symbol('SENTINEL_REDIS');

export const DEFAULT_PREFIX = 'sentinel';
export const DEFAULT_BOARD_PATH = '/sentinel';
export const DEFAULT_BATCH_TTL_SECONDS = 60 * 60 * 24 * 7;

export const DEFAULT_TRIM_RECENT_MINUTES = 60;
export const DEFAULT_TRIM_FAILED_MINUTES = 60 * 24 * 7;
export const DEFAULT_TRIM_MONITORED_MINUTES = 60 * 24 * 7;

/** How many times a handler may put its own job back before it is failed. */
export const DEFAULT_MAX_RELEASES = 25;

/** Forecast drain time a queue may reach before it is worth an alert. */
export const DEFAULT_WAIT_SECONDS = 60;

/** Snapshots kept per job and per queue. */
export const MAX_SNAPSHOTS = 24;
