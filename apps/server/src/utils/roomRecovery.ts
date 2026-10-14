/**
 * Pure utility functions for room state calculations.
 * No database dependencies — safe to import in tests without Prisma setup.
 */

/**
 * Cold-Start Room Recovery Calculation.
 *
 * When the server restarts, in-memory state is cleared.
 * We reconstruct playback state from the last persisted DB checkpoint.
 *
 * Rules:
 * - PAUSED → restore at lastPositionSeconds (position is frozen).
 * - PLAYING, elapsed < 60s → resume PLAYING at lastPositionSeconds + elapsedSeconds.
 * - PLAYING, elapsed >= 60s → safe-fallback to PAUSED at lastPositionSeconds.
 *   (Prevents resuming a video at a wildly stale position after a long outage.)
 *
 * Limitation (documented): Playback positions between DB checkpoints are lost on restart.
 * The checkpoint interval is async and best-effort for playback events (Tier 2 strategy).
 */
export function computeRecoveryState(
  dbStatus: string,
  lastPositionSeconds: number,
  lastPositionUpdatedAt: Date,
  stateVersion: number,
): {
  status: 'PLAYING' | 'PAUSED';
  anchorPositionSeconds: number;
  anchorTimestampMs: number;
  stateVersion: number;
} {
  const nowMs = Date.now();
  const elapsedSeconds = (nowMs - lastPositionUpdatedAt.getTime()) / 1000;

  if (dbStatus === 'PLAYING' && elapsedSeconds < 60) {
    return {
      status: 'PLAYING',
      anchorPositionSeconds: lastPositionSeconds + elapsedSeconds,
      anchorTimestampMs: nowMs,
      stateVersion,
    };
  }

  return {
    status: 'PAUSED',
    anchorPositionSeconds: lastPositionSeconds,
    anchorTimestampMs: nowMs,
    stateVersion,
  };
}
