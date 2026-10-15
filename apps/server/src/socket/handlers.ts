/**
 * Socket.IO Event Handlers
 *
 * All handlers follow this pattern:
 * 1. Parse and validate payload with Zod schema (rejects bad data before any logic)
 * 2. Extract identity from socket.data.session (NEVER from payload)
 * 3. Check current role from RoomStateManager (NEVER from JWT)
 * 4. Execute business logic
 * 5. Broadcast or acknowledge result
 *
 * Every protected event validates authorization on the server.
 * Hiding a button in the UI is not security.
 */

import { Server, Socket } from 'socket.io';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import {
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData,
  SocketResponse,
  SyncStatePayload,
  JoinRoomPayloadSchema,
  PlayPayloadSchema,
  PausePayloadSchema,
  SeekPayloadSchema,
  ChangeVideoPayloadSchema,
  RequestPlaybackActionPayloadSchema,
  ResolvePlaybackRequestPayloadSchema,
  AssignRolePayloadSchema,
  RemoveParticipantPayloadSchema,
  TransferHostPayloadSchema,
  SendMessagePayloadSchema,
  Role,
  PlaybackAction,
} from '@watchparty/types';
import { roomStateManager } from '../state/RoomStateManager';
import { loadRoomIntoMemory, buildSyncStatePayload } from '../services/roomService';
import { applyPlay, applyPause, applySeek, applyChangeVideo } from '../services/playbackService';
import {
  createPlaybackRequest,
  resolvePlaybackRequest,
  getPendingRequests,
} from '../services/requestService';
import { createChatMessage, getRoomChatHistory } from '../services/chatService';
import { revokeSession } from '../services/sessionService';
import { canPerformAction, canAssignRole } from '../utils/rbac';
import { prisma } from '../db/prisma';
import { extractVideoId } from '../utils/youtube';

type AppServer = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

/**
 * Validates a Zod schema and returns either the parsed value or an error response.
 * The error response is cast to `SocketResponse<T>` to be compatible with any typed callback.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function validatePayload<T>(
  schema: z.ZodSchema<T>,
  data: unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): { valid: true; data: T } | { valid: false; response: SocketResponse<any> } {
  const result = schema.safeParse(data);
  if (!result.success) {
    return {
      valid: false,
      // SocketResponse<any> is assignable to any SocketResponse<T> in callback position
      response: {
        success: false,
        error: {
          code: 'BAD_REQUEST',
          message: result.error.issues.map((i) => i.message).join('; '),
        },
      },
    };
  }
  return { valid: true, data: result.data };
}

/**
 * Gets the current role of a socket's user from the in-memory state.
 * Returns null if not found (user not in room state).
 */
function getCurrentRole(socket: AppSocket): Role | null {
  const { userId, roomCode } = socket.data.session;
  return roomStateManager.getParticipantRole(roomCode, userId);
}

/**
 * Registers all Socket.IO event handlers for a connected socket.
 */
export function registerSocketHandlers(io: AppServer, socket: AppSocket): void {
  const { userId, roomId, roomCode, displayName } = socket.data.session;

  // ── join_room ───────────────────────────────────────────────────────────────
  socket.on('join_room', async (payload, callback) => {
    const validation = validatePayload(JoinRoomPayloadSchema, payload);
    if (!validation.valid) return callback(validation.response);

    const { roomCode: payloadRoomCode } = validation.data;

    // Validate that the room code in the payload matches the session
    // (prevents using a valid session to join a different room)
    if (payloadRoomCode !== roomCode) {
      return callback({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Room code does not match session' },
      });
    }

    // Cold-start recovery: load room if not in memory
    if (!roomStateManager.hasRoom(roomCode)) {
      try {
        await loadRoomIntoMemory(roomId, roomCode);
      } catch (err) {
        return callback({
          success: false,
          error: { code: 'INTERNAL_ERROR', message: 'Failed to load room state' },
        });
      }
    }

    const room = roomStateManager.getRoom(roomCode);
    if (!room) {
      return callback({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Room not found or closed' },
      });
    }

    // Add to Socket.IO room
    socket.join(roomCode);

    // Update in-memory presence
    const existingParticipant = roomStateManager.getParticipant(roomCode, userId);
    if (existingParticipant) {
      // Reconnecting user — restore presence
      roomStateManager.updateParticipantSocket(roomCode, userId, socket.id);
    } else {
      // New participant (should have been added by joinRoom REST call, but safeguard)
      roomStateManager.addParticipant(roomCode, {
        userId,
        displayName,
        role: 'PARTICIPANT',
        isOnline: true,
        socketId: socket.id,
        joinedAt: new Date(),
      });
    }

    // Fetch pending requests (only sent to HOST and MODERATOR in the SyncState)
    const pendingRequests = await getPendingRequests(roomId);

    // Fetch recent chat history — non-blocking, returns [] on failure
    const recentMessages = await getRoomChatHistory(roomId);

    const syncState = buildSyncStatePayload(roomCode, userId, pendingRequests, recentMessages);
    if (!syncState) {
      return callback({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to build sync state' },
      });
    }

    // Update DB online status
    await prisma.roomParticipant.updateMany({
      where: { roomId, userId },
      data: { isOnline: true, lastSeenAt: new Date() },
    }).catch(console.error);

    // Notify other room members
    socket.to(roomCode).emit('user_joined', {
      userId,
      displayName,
      role: syncState.currentUser.role,
      isOnline: true,
      joinedAt: new Date().toISOString(),
    });

    // Return full state in the ack (read by the frontend join_room callback)
    callback({ success: true, data: syncState });

    // Also push sync_state as a server-initiated event so the useRoomState
    // listener can set isLoaded = true.  This is the canonical path; the ack
    // data acts only as a secondary safety-net (see page.tsx join_room handler).
    socket.emit('sync_state', syncState);
  });

  // ── play ────────────────────────────────────────────────────────────────────
  socket.on('play', async (payload, callback) => {
    const validation = validatePayload(PlayPayloadSchema, payload);
    if (!validation.valid) return callback?.(validation.response);

    const { positionSeconds } = validation.data;

    const role = getCurrentRole(socket);
    if (!role || !canPerformAction(role, 'play')) {
      return callback?.({ success: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } });
    }

    const result = await applyPlay(roomCode, positionSeconds, userId, displayName);
    if (!result) {
      return callback?.({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to apply play' } });
    }

    io.to(roomCode).emit('playback_updated', result);
    callback?.({ success: true });
  });

  // ── pause ───────────────────────────────────────────────────────────────────
  socket.on('pause', async (payload, callback) => {
    const validation = validatePayload(PausePayloadSchema, payload);
    if (!validation.valid) return callback?.(validation.response);

    const { positionSeconds } = validation.data;

    const role = getCurrentRole(socket);
    if (!role || !canPerformAction(role, 'pause')) {
      return callback?.({ success: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } });
    }

    const result = await applyPause(roomCode, positionSeconds, userId, displayName);
    if (!result) {
      return callback?.({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to apply pause' } });
    }

    io.to(roomCode).emit('playback_updated', result);
    callback?.({ success: true });
  });

  // ── seek ────────────────────────────────────────────────────────────────────
  socket.on('seek', async (payload: z.infer<typeof SeekPayloadSchema>, callback?: (response: SocketResponse) => void) => {
    const validation = validatePayload(SeekPayloadSchema, payload);
    if (!validation.valid) return callback?.(validation.response);

    const { targetPositionSeconds } = validation.data;

    const role = getCurrentRole(socket);
    if (!role || !canPerformAction(role, 'seek')) {
      return callback?.({ success: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } });
    }

    const result = await applySeek(roomCode, targetPositionSeconds, userId, displayName);
    if (!result) {
      return callback?.({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to apply seek' } });
    }

    io.to(roomCode).emit('playback_updated', result);
    callback?.({ success: true });
  });

  // ── change_video ─────────────────────────────────────────────────────────────
  socket.on('change_video', async (payload: z.infer<typeof ChangeVideoPayloadSchema>, callback?: (response: SocketResponse<{ videoId: string }>) => void) => {
    const validation = validatePayload(ChangeVideoPayloadSchema, payload);
    if (!validation.valid) return callback?.(validation.response);

    const { videoUrlOrId } = validation.data;

    const role = getCurrentRole(socket);
    if (!role || !canPerformAction(role, 'change_video')) {
      return callback?.({ success: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } });
    }

    const result = await applyChangeVideo(roomCode, videoUrlOrId, userId, displayName);
    if (!result) {
      return callback?.({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to change video' } });
    }
    if ('error' in result) {
      return callback?.({ success: false, error: { code: 'BAD_REQUEST', message: result.error } });
    }

    io.to(roomCode).emit('playback_updated', result);
    callback?.({ success: true, data: { videoId: result.videoId } });
  });

  // ── request_playback_action ─────────────────────────────────────────────────
  socket.on('request_playback_action', async (payload: z.infer<typeof RequestPlaybackActionPayloadSchema>, callback: (response: SocketResponse<import('@watchparty/types').PlaybackRequestDTO>) => void) => {
    const validation = validatePayload(RequestPlaybackActionPayloadSchema, payload);
    if (!validation.valid) return callback(validation.response);

    const { action, targetPositionSeconds, videoUrlOrId, note } = validation.data;

    const role = getCurrentRole(socket);
    if (!role || !canPerformAction(role, 'request_playback_action')) {
      return callback({ success: false, error: { code: 'FORBIDDEN', message: 'Not a room member' } });
    }

    // Resolve video ID if provided
    let resolvedVideoId: string | undefined;
    if (videoUrlOrId) {
      const extracted = extractVideoId(videoUrlOrId);
      if (!extracted) {
        return callback({ success: false, error: { code: 'BAD_REQUEST', message: 'Invalid YouTube URL or video ID' } });
      }
      resolvedVideoId = extracted;
    }

    const requestPayload = {
      targetPositionSeconds,
      videoId: resolvedVideoId,
    };

    const request = await createPlaybackRequest(
      roomId,
      userId,
      displayName,
      action as PlaybackAction,
      requestPayload,
      note,
    );

    // Notify Hosts and Moderators in the room
    const participants = roomStateManager.getParticipants(roomCode);
    for (const p of participants) {
      if ((p.role === 'HOST' || p.role === 'MODERATOR') && p.socketId) {
        io.to(p.socketId).emit('playback_request_created', request);
      }
    }

    callback({ success: true, data: request });
  });

  // ── resolve_playback_request ─────────────────────────────────────────────────
  socket.on('resolve_playback_request', async (payload: z.infer<typeof ResolvePlaybackRequestPayloadSchema>, callback: (response: SocketResponse) => void) => {
    const validation = validatePayload(ResolvePlaybackRequestPayloadSchema, payload);
    if (!validation.valid) return callback(validation.response);

    const { requestId, decision, reason } = validation.data;

    const role = getCurrentRole(socket);
    if (!role || !canPerformAction(role, 'resolve_playback_request')) {
      return callback({ success: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } });
    }

    const resolveResult = await resolvePlaybackRequest(
      requestId,
      roomId,
      userId,
      decision,
      reason,
    );

    if (!resolveResult.success) {
      const code = resolveResult.error === 'ALREADY_RESOLVED' ? 'CONFLICT'
        : resolveResult.error === 'CROSS_ROOM_ACCESS' ? 'FORBIDDEN'
          : 'NOT_FOUND';
      return callback({
        success: false,
        error: { code, message: resolveResult.error.replace(/_/g, ' ').toLowerCase() },
      });
    }

    let actionApplied = false;

    // Execute the approved action through the standard playback pipeline
    if (decision === 'APPROVED') {
      const { request } = resolveResult;
      let playbackResult = null;

      if (request.action === 'PLAY' && request.payload.targetPositionSeconds !== undefined) {
        playbackResult = await applyPlay(roomCode, request.payload.targetPositionSeconds, userId, displayName);
      } else if (request.action === 'PAUSE' && request.payload.targetPositionSeconds !== undefined) {
        playbackResult = await applyPause(roomCode, request.payload.targetPositionSeconds, userId, displayName);
      } else if (request.action === 'SEEK' && request.payload.targetPositionSeconds !== undefined) {
        playbackResult = await applySeek(roomCode, request.payload.targetPositionSeconds, userId, displayName);
      } else if (request.action === 'CHANGE_VIDEO' && request.payload.videoId) {
        const cvResult = await applyChangeVideo(roomCode, request.payload.videoId, userId, displayName);
        if (cvResult && !('error' in cvResult)) playbackResult = cvResult;
      }

      if (playbackResult) {
        io.to(roomCode).emit('playback_updated', playbackResult);
        actionApplied = true;
      }
    }

    io.to(roomCode).emit('playback_request_resolved', {
      requestId,
      status: decision,
      resolvedByDisplayName: displayName,
      actionApplied,
      rejectionReason: reason,
    });

    callback({ success: true });
  });

  // ── assign_role ──────────────────────────────────────────────────────────────
  socket.on('assign_role', async (payload: z.infer<typeof AssignRolePayloadSchema>, callback: (response: SocketResponse) => void) => {
    const validation = validatePayload(AssignRolePayloadSchema, payload);
    if (!validation.valid) return callback(validation.response);

    const role = getCurrentRole(socket);
    if (!role || !canPerformAction(role, 'assign_role')) {
      return callback({ success: false, error: { code: 'FORBIDDEN', message: 'Only the Host can assign roles' } });
    }

    const { targetUserId, newRole } = validation.data;

    // Prevent Host from reassigning their own role via this event
    if (targetUserId === userId) {
      return callback({ success: false, error: { code: 'BAD_REQUEST', message: 'Cannot change your own role' } });
    }

    const targetCurrentRole = roomStateManager.getParticipantRole(roomCode, targetUserId);
    if (!targetCurrentRole) {
      return callback({ success: false, error: { code: 'NOT_FOUND', message: 'Target user not in room' } });
    }

    if (!canAssignRole(role, targetCurrentRole, newRole as Role)) {
      return callback({ success: false, error: { code: 'FORBIDDEN', message: 'Invalid role transition' } });
    }

    // DB-first: persist the role change before updating memory
    try {
      await prisma.roomParticipant.update({
        where: { roomId_userId: { roomId, userId: targetUserId } },
        data: { role: newRole },
      });
    } catch (err) {
      return callback({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to update role' } });
    }

    // Update memory after DB success
    roomStateManager.updateParticipantRole(roomCode, targetUserId, newRole as Role);

    const targetParticipant = roomStateManager.getParticipant(roomCode, targetUserId);

    io.to(roomCode).emit('role_assigned', {
      userId: targetUserId,
      displayName: targetParticipant?.displayName ?? targetUserId,
      newRole: newRole as Role,
      updatedByUserId: userId,
      updatedByDisplayName: displayName,
    });

    callback({ success: true });
  });

  // ── remove_participant ────────────────────────────────────────────────────────
  socket.on('remove_participant', async (payload: z.infer<typeof RemoveParticipantPayloadSchema>, callback: (response: SocketResponse) => void) => {
    const validation = validatePayload(RemoveParticipantPayloadSchema, payload);
    if (!validation.valid) return callback(validation.response);

    const role = getCurrentRole(socket);
    if (!role || !canPerformAction(role, 'remove_participant')) {
      return callback({ success: false, error: { code: 'FORBIDDEN', message: 'Only the Host can remove participants' } });
    }

    const { targetUserId, ban } = validation.data;

    if (targetUserId === userId) {
      return callback({ success: false, error: { code: 'BAD_REQUEST', message: 'Cannot remove yourself' } });
    }

    const targetParticipant = roomStateManager.getParticipant(roomCode, targetUserId);
    if (!targetParticipant) {
      return callback({ success: false, error: { code: 'NOT_FOUND', message: 'Target user not in room' } });
    }

    // Cannot remove another Host (should be impossible but guard anyway)
    if (targetParticipant.role === 'HOST') {
      return callback({ success: false, error: { code: 'FORBIDDEN', message: 'Cannot remove the Host' } });
    }

    // DB-first: update ban status and revoke session before touching memory
    try {
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.roomParticipant.update({
          where: { roomId_userId: { roomId, userId: targetUserId } },
          data: { isBanned: ban ?? false, isOnline: false },
        });
        if (ban) {
          await tx.session.updateMany({
            where: { userId: targetUserId, roomId },
            data: { isRevoked: true },
          });
        }
      });
    } catch (err) {
      return callback({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to remove participant' } });
    }

    // Remove from in-memory state
    roomStateManager.removeParticipant(roomCode, targetUserId);

    // Forcefully disconnect the target's socket
    if (targetParticipant.socketId) {
      const targetSocket = io.sockets.sockets.get(targetParticipant.socketId);
      if (targetSocket) {
        targetSocket.emit('participant_removed', {
          userId: targetUserId,
          displayName: targetParticipant.displayName,
          isBanned: ban ?? false,
          removedByDisplayName: displayName,
        });
        targetSocket.disconnect(true);
      }
    }

    // Notify the rest of the room
    socket.to(roomCode).emit('participant_removed', {
      userId: targetUserId,
      displayName: targetParticipant.displayName,
      isBanned: ban ?? false,
      removedByDisplayName: displayName,
    });

    callback({ success: true });
  });

  // ── transfer_host ─────────────────────────────────────────────────────────────
  socket.on('transfer_host', async (payload: z.infer<typeof TransferHostPayloadSchema>, callback: (response: SocketResponse) => void) => {
    const validation = validatePayload(TransferHostPayloadSchema, payload);
    if (!validation.valid) return callback(validation.response);

    const role = getCurrentRole(socket);
    if (role !== 'HOST') {
      return callback({ success: false, error: { code: 'FORBIDDEN', message: 'Only the Host can transfer the host role' } });
    }

    const { targetUserId } = validation.data;

    if (targetUserId === userId) {
      return callback({ success: false, error: { code: 'BAD_REQUEST', message: 'You are already the Host' } });
    }

    const targetParticipant = roomStateManager.getParticipant(roomCode, targetUserId);
    if (!targetParticipant) {
      return callback({ success: false, error: { code: 'NOT_FOUND', message: 'Target user not in room' } });
    }

    if (targetParticipant.role === 'HOST') {
      return callback({ success: false, error: { code: 'BAD_REQUEST', message: 'Target is already the Host' } });
    }

    // DB transaction: update Room.hostUserId + both participant roles atomically
    try {
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        // Update the room's canonical hostUserId
        await tx.room.update({
          where: { id: roomId },
          data: { hostUserId: targetUserId },
        });
        // Demote current host to PARTICIPANT
        await tx.roomParticipant.update({
          where: { roomId_userId: { roomId, userId } },
          data: { role: 'PARTICIPANT' },
        });
        // Promote target to HOST
        await tx.roomParticipant.update({
          where: { roomId_userId: { roomId, userId: targetUserId } },
          data: { role: 'HOST' },
        });
      });
    } catch (err) {
      return callback({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Failed to transfer host' } });
    }

    // Update in-memory state
    roomStateManager.updateParticipantRole(roomCode, userId, 'PARTICIPANT');
    roomStateManager.updateParticipantRole(roomCode, targetUserId, 'HOST');
    roomStateManager.updateHostUserId(roomCode, targetUserId);

    // Broadcast to the entire room
    io.to(roomCode).emit('host_transferred', {
      previousHostUserId: userId,
      previousHostDisplayName: displayName,
      newHostUserId: targetUserId,
      newHostDisplayName: targetParticipant.displayName,
    });

    callback({ success: true });
  });

  // ── send_message ─────────────────────────────────────────────────────────────
  socket.on('send_message', async (payload: z.infer<typeof SendMessagePayloadSchema>, callback: (response: SocketResponse<import('@watchparty/types').ChatMessageDTO>) => void) => {
    // 1. Validate and sanitise payload (body trimmed by Zod transform)
    const validation = validatePayload(SendMessagePayloadSchema, payload);
    if (!validation.valid) return callback(validation.response);

    const { body } = validation.data;

    // 2. Confirm the sender is still an active member of this room.
    //    getCurrentRole returns null for unknown/removed participants.
    const role = getCurrentRole(socket);
    if (!role) {
      return callback({
        success: false,
        error: { code: 'FORBIDDEN', message: 'You are not a member of this room' },
      });
    }

    // 3. Persist — DB-first. Never broadcast before the write succeeds.
    let message;
    try {
      message = await createChatMessage(
        roomId,
        userId,
        displayName,     // from trusted socket.data.session, NEVER from payload
        body,
      );
    } catch (err) {
      console.error('[send_message] DB write failed:', err);
      return callback({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Failed to save message' },
      });
    }

    // 4. Broadcast to every socket in the room (including the sender so the
    //    client can use the server-assigned id for deduplication).
    io.to(roomCode).emit('message_received', message);

    // 5. Acknowledge success with the persisted message DTO
    callback({ success: true, data: message });
  });

  // ── sync_ping ────────────────────────────────────────────────────────────────
  socket.on('sync_ping', (clientSendTimestampMs: number, callback: (serverReceivedTimestampMs: number) => void) => {
    callback(Date.now());
  });

  // ── leave_room ───────────────────────────────────────────────────────────────
  socket.on('leave_room', async () => {
    await handleDisconnect(io, socket, 'left');
  });

  // ── disconnect ───────────────────────────────────────────────────────────────
  socket.on('disconnect', async () => {
    await handleDisconnect(io, socket, 'disconnected');
  });
}

/**
 * Shared cleanup logic for both graceful leave and unexpected disconnect.
 */
async function handleDisconnect(
  io: AppServer,
  socket: AppSocket,
  reason: 'left' | 'disconnected',
): Promise<void> {
  const { userId, roomId, roomCode, displayName } = socket.data.session;

  roomStateManager.updateParticipantOnlineStatus(roomCode, userId, false);

  // Update DB — fire-and-forget (non-critical)
  prisma.roomParticipant.updateMany({
    where: { roomId, userId },
    data: { isOnline: false, lastSeenAt: new Date() },
  }).catch(console.error);

  socket.to(roomCode).emit('user_left', { userId, displayName, reason });
  socket.leave(roomCode);
}
