/**
 * Request Service
 *
 * Handles the Participant playback request workflow.
 *
 * Concurrency safety:
 * The atomic conditional update (WHERE status = 'PENDING') ensures
 * that exactly one concurrent approval attempt succeeds. The second
 * attempt will find count=0 and receive a CONFLICT error.
 *
 * Note on exactly-once execution:
 * We guarantee exactly-once DB status transition (PENDING → APPROVED/REJECTED).
 * The subsequent playback action (seek/play/etc.) is a separate operation on the
 * in-memory state. If the server crashes between approval and playback execution,
 * the request will remain APPROVED in the DB but the playback may not have fired.
 * This is an acceptable limitation for an MVP — it's documented and the UI shows
 * the approved status so the Host can manually re-trigger if needed.
 */

import { PlaybackRequestDTO, PlaybackAction } from '@watchparty/types';
import { prisma } from '../db/prisma';
import type { PlaybackRequest, User } from '@prisma/client';

/**
 * Creates a new PENDING playback request.
 * Returns the created request as a DTO.
 */
export async function createPlaybackRequest(
  roomId: string,
  requesterId: string,
  requesterDisplayName: string,
  action: PlaybackAction,
  payload: { targetPositionSeconds?: number; videoId?: string },
  note?: string,
): Promise<PlaybackRequestDTO> {
  const request = await prisma.playbackRequest.create({
    data: {
      roomId,
      requesterId,
      action,
      payload,
      status: 'PENDING',
      note,
    },
  });

  return {
    id: request.id,
    requesterId,
    requesterDisplayName,
    action,
    payload: {
      targetPositionSeconds: payload.targetPositionSeconds,
      videoId: payload.videoId,
    },
    status: 'PENDING',
    note,
    createdAt: request.createdAt.toISOString(),
  };
}

/**
 * Atomically resolves a PENDING request.
 * Returns the resolved request or an error code.
 *
 * The WHERE clause includes `status: 'PENDING'` so only one concurrent
 * resolution attempt can succeed (updateMany count=1). The second gets count=0.
 */
export async function resolvePlaybackRequest(
  requestId: string,
  roomId: string,
  resolverUserId: string,
  decision: 'APPROVED' | 'REJECTED',
  reason?: string,
): Promise<
  | { success: true; request: PlaybackRequestDTO & { resolvedById: string } }
  | { success: false; error: 'NOT_FOUND' | 'ALREADY_RESOLVED' | 'CROSS_ROOM_ACCESS' }
> {
  // First verify the request exists and belongs to this room (cross-room access prevention)
  const existingRequest = await prisma.playbackRequest.findUnique({
    where: { id: requestId },
    include: { requester: true },
  });

  if (!existingRequest) return { success: false, error: 'NOT_FOUND' };
  if (existingRequest.roomId !== roomId) return { success: false, error: 'CROSS_ROOM_ACCESS' };
  if (existingRequest.status !== 'PENDING') return { success: false, error: 'ALREADY_RESOLVED' };

  // Atomic conditional update — only succeeds if status is still PENDING
  const updateResult = await prisma.playbackRequest.updateMany({
    where: {
      id: requestId,
      status: 'PENDING', // Concurrency guard
      roomId, // Additional cross-room safety
    },
    data: {
      status: decision,
      resolvedById: resolverUserId,
      resolvedAt: new Date(),
      rejectionReason: decision === 'REJECTED' ? (reason ?? null) : null,
    },
  });

  if (updateResult.count === 0) {
    // Lost the race — another resolver got here first
    return { success: false, error: 'ALREADY_RESOLVED' };
  }

  // Fetch the updated record for broadcasting
  const resolved = await prisma.playbackRequest.findUnique({
    where: { id: requestId },
    include: { requester: true },
  });

  if (!resolved) return { success: false, error: 'NOT_FOUND' };

  return {
    success: true,
    request: {
      id: resolved.id,
      requesterId: resolved.requesterId,
      requesterDisplayName: resolved.requester.displayName,
      action: resolved.action as PlaybackAction,
      payload: resolved.payload as { targetPositionSeconds?: number; videoId?: string },
      status: decision,
      note: resolved.note ?? undefined,
      createdAt: resolved.createdAt.toISOString(),
      resolvedAt: resolved.resolvedAt?.toISOString(),
      resolvedById: resolverUserId,
    },
  };
}

/**
 * Fetches all PENDING requests for a room (for sync_state on join).
 */
export async function getPendingRequests(roomId: string): Promise<PlaybackRequestDTO[]> {
  const requests = await prisma.playbackRequest.findMany({
    where: { roomId, status: 'PENDING' },
    include: { requester: true },
    orderBy: { createdAt: 'asc' },
  });

  return requests.map((r: PlaybackRequest & { requester: User }) => ({
    id: r.id,
    requesterId: r.requesterId,
    requesterDisplayName: r.requester.displayName,
    action: r.action as PlaybackAction,
    payload: r.payload as { targetPositionSeconds?: number; videoId?: string },
    status: 'PENDING' as const,
    note: r.note ?? undefined,
    createdAt: r.createdAt.toISOString(),
  }));
}
