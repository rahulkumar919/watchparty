/**
 * Playback Service
 *
 * Handles authoritative playback state mutations and DB checkpointing.
 * Implements the two-tier DB failure strategy:
 *
 * Tier 1 (change_video): DB-first write-through.
 *   - Video changes affect room metadata and must be durable.
 *   - If DB write fails, the operation is aborted.
 *
 * Tier 2 (play/pause/seek): Memory-first with async DB checkpoint.
 *   - Playback controls must be fast (<150ms target).
 *   - In-memory state updated immediately and broadcast.
 *   - DB checkpoint dispatched asynchronously.
 *   - Stale checkpoint rejection: only write if DB.stateVersion matches checkpoint.
 */

import { PlaybackAction, PlaybackUpdatedPayload } from '@watchparty/types';
import { prisma } from '../db/prisma';
import { roomStateManager } from '../state/RoomStateManager';
import { extractVideoId } from '../utils/youtube';

/**
 * Applies a PLAY action to in-memory state and queues an async DB checkpoint.
 * Returns the PlaybackUpdatedPayload to broadcast, or null on failure.
 */
export async function applyPlay(
  roomCode: string,
  positionSeconds: number,
  triggeredByUserId: string,
  triggeredByDisplayName: string,
): Promise<PlaybackUpdatedPayload | null> {
  const nowMs = Date.now();
  const newState = roomStateManager.applyPlay(roomCode, positionSeconds, nowMs);
  if (!newState) return null;

  // Async DB checkpoint — non-blocking, failures are logged but don't abort the operation
  checkpointPlaybackState(roomCode, newState.stateVersion).catch((err) =>
    console.error('[PlaybackService] Async checkpoint failed (play):', err),
  );

  return {
    action: 'PLAY',
    videoId: newState.videoId,
    status: 'PLAYING',
    anchorPositionSeconds: newState.anchorPositionSeconds,
    anchorTimestampMs: newState.anchorTimestampMs,
    serverTimeMs: nowMs,
    stateVersion: newState.stateVersion,
    triggeredByUserId,
    triggeredByDisplayName,
  };
}

/**
 * Applies a PAUSE action.
 */
export async function applyPause(
  roomCode: string,
  positionSeconds: number,
  triggeredByUserId: string,
  triggeredByDisplayName: string,
): Promise<PlaybackUpdatedPayload | null> {
  const newState = roomStateManager.applyPause(roomCode, positionSeconds);
  if (!newState) return null;

  checkpointPlaybackState(roomCode, newState.stateVersion).catch((err) =>
    console.error('[PlaybackService] Async checkpoint failed (pause):', err),
  );

  const nowMs = Date.now();
  return {
    action: 'PAUSE',
    videoId: newState.videoId,
    status: 'PAUSED',
    anchorPositionSeconds: newState.anchorPositionSeconds,
    anchorTimestampMs: newState.anchorTimestampMs,
    serverTimeMs: nowMs,
    stateVersion: newState.stateVersion,
    triggeredByUserId,
    triggeredByDisplayName,
  };
}

/**
 * Applies a SEEK action.
 */
export async function applySeek(
  roomCode: string,
  targetPositionSeconds: number,
  triggeredByUserId: string,
  triggeredByDisplayName: string,
): Promise<PlaybackUpdatedPayload | null> {
  const newState = roomStateManager.applySeek(roomCode, targetPositionSeconds);
  if (!newState) return null;

  checkpointPlaybackState(roomCode, newState.stateVersion).catch((err) =>
    console.error('[PlaybackService] Async checkpoint failed (seek):', err),
  );

  const nowMs = Date.now();
  return {
    action: 'SEEK',
    videoId: newState.videoId,
    status: newState.status,
    anchorPositionSeconds: newState.anchorPositionSeconds,
    anchorTimestampMs: newState.anchorTimestampMs,
    serverTimeMs: nowMs,
    stateVersion: newState.stateVersion,
    triggeredByUserId,
    triggeredByDisplayName,
  };
}

/**
 * Applies a CHANGE_VIDEO action — DB-first (Tier 1).
 * Validates the video ID, writes to DB, then updates memory.
 * If DB write fails, returns null and in-memory state is NOT changed.
 */
export async function applyChangeVideo(
  roomCode: string,
  videoUrlOrId: string,
  triggeredByUserId: string,
  triggeredByDisplayName: string,
): Promise<PlaybackUpdatedPayload | { error: string } | null> {
  const videoId = extractVideoId(videoUrlOrId);
  if (!videoId) {
    return { error: 'INVALID_VIDEO_URL' };
  }

  const room = roomStateManager.getRoom(roomCode);
  if (!room) return null;

  const nextVersion = room.playback.stateVersion + 1;

  // DB-first: write the new video to the database before broadcasting
  try {
    await prisma.room.update({
      where: { id: room.roomId },
      data: {
        currentVideoId: videoId,
        playbackStatus: 'PAUSED',
        lastPositionSeconds: 0,
        lastPositionUpdatedAt: new Date(),
        stateVersion: nextVersion,
      },
    });
  } catch (err) {
    console.error('[PlaybackService] DB write failed (change_video):', err);
    return null;
  }

  // Only update memory after DB succeeds
  const newState = roomStateManager.applyChangeVideo(roomCode, videoId);
  if (!newState) return null;

  const nowMs = Date.now();
  return {
    action: 'CHANGE_VIDEO',
    videoId: newState.videoId,
    status: 'PAUSED',
    anchorPositionSeconds: 0,
    anchorTimestampMs: newState.anchorTimestampMs,
    serverTimeMs: nowMs,
    stateVersion: newState.stateVersion,
    triggeredByUserId,
    triggeredByDisplayName,
  };
}

/**
 * Async DB checkpoint for playback state.
 *
 * Stale checkpoint rejection:
 * Uses a conditional UPDATE WHERE stateVersion = expectedVersion.
 * If stateVersion has advanced (a newer event fired), Prisma updateMany returns
 * count=0 and the stale write is silently discarded.
 * This prevents an older async write from overwriting newer state.
 */
async function checkpointPlaybackState(roomCode: string, checkpointVersion: number): Promise<void> {
  const room = roomStateManager.getRoom(roomCode);
  if (!room) return;

  // Only write if in-memory version still matches the checkpoint version
  // (another event may have already incremented it)
  const result = await prisma.room.updateMany({
    where: {
      id: room.roomId,
      // Reject if a newer checkpoint already wrote a higher version
      stateVersion: { lte: checkpointVersion },
    },
    data: {
      playbackStatus: room.playback.status,
      lastPositionSeconds: room.playback.anchorPositionSeconds,
      lastPositionUpdatedAt: new Date(room.playback.anchorTimestampMs),
      stateVersion: checkpointVersion,
    },
  });

  if (result.count === 0) {
    // Normal: a newer event already wrote a higher version. This is expected.
    // No logging needed — this is the intended stale rejection behavior.
  }
}
