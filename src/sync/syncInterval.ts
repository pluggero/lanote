export const DEFAULT_SYNC_INTERVAL_SECONDS = 5;
const MIN_SYNC_INTERVAL_SECONDS = 2;
const MAX_SYNC_INTERVAL_SECONDS = 300;

/** Clamps a user-supplied sync-check interval to a sane range: at least 2s (so a mistyped value can't hammer the relay), at most 300s/5min (past which it stops behaving like an "automatic" check). Falls back to the default on NaN/non-finite input. */
export function clampSyncIntervalSeconds(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SYNC_INTERVAL_SECONDS;
  return Math.min(MAX_SYNC_INTERVAL_SECONDS, Math.max(MIN_SYNC_INTERVAL_SECONDS, Math.round(value)));
}
