import type { Batch } from './api';

export const label = (batch: Batch): string => {
  if (batch.cancelled) return 'Cancelled';
  if (!batch.finished) return 'Running';

  // A red badge reading "Finished" says nothing; name the failure.
  return batch.failedJobs ? 'Failed' : 'Finished';
};

/** Colour follows the label. Failures only count once the batch has finished. */
export const badgeClass = (batch: Batch): string =>
  batch.cancelled
    ? 'hz-pill hz-pill-warn'
    : !batch.finished
      ? 'hz-pill hz-pill-busy'
      : batch.failedJobs
        ? 'hz-pill hz-pill-bad'
        : 'hz-pill hz-pill-ok';

/** 2026-08-20 08:15:02. */
export const when = (value: string | number | null | undefined): string => {
  if (!value) {
    return '-';
  }

  const date = new Date(value);
  const pad = (n: number) => String(n).padStart(2, '0');

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
};

/** Runtime in seconds with two decimals: 9.25s, 0.05s. */
export const runtime = (ms: number | null): string =>
  ms === null ? '-' : `${(ms / 1000).toFixed(2)}s`;
