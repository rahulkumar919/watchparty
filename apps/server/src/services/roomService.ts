/**
 * Room Service
 *
 * Handles room creation, joining, and cold-start state recovery.
 * All mutations that affect both Room.hostUserId and RoomParticipant.role
 * use database transactions to guarantee consistency.
 *
 * Key invariants maintained:
 * - Exactly one RoomParticipant per room has role = 'HOST'
 * - That participant's userId === Room.hostUserId
 * - These two fields are always updated together in a transaction
 */

import { customAlphabet } from 'nanoid';
import { v4 as uuidv4 } from 'uuid';
import { Role, ParticipantDTO, PlaybackRequestDTO, SyncStatePayload } from '@watchparty/types';
import { prisma } from '../db/prisma';
import type { Prisma } from '@prisma/client';
import { roomStateManager, RoomParticipantState } from '../state/RoomStateManager';
import { issueSession } from './sessionService';
import { computeRecoveryState } from '../utils/roomRecovery';

// Re-export for backward compatibility
export { computeRecoveryState };

// 8-character uppercase alphanumeric room codes
const generateRoomCode = customAlphabet('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', 8);



/**
 * Creates a new watch party room.
 * Returns the session token for the creator (who becomes HOST).
 */
export async function createRoom(
  displayName: string,
  title?: string,
  initialVideoId?: string,
): Promise<{ sessionToken: string; room: { id: string; code: string; title: string; hostUserId: string }; userId: string }> {
  // Generate unique room code (retry on collision)
  let code = generateRoomCode();
  let attempts = 0;
  while (await prisma.room.findUnique({ where: { code } })) {
    code = generateRoomCode();
    if (++attempts > 10) throw new Error('Failed to generate unique room code');
  }

  const sessionId = `sess_${uuidv4()}`;

  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // 1. Create the User
    const user = await tx.user.create({
      data: { displayName },
    });

    // 2. Create the Room with this user as Host
    const room = await tx.room.create({
      data: {
        code,
        title: title ?? `${displayName}'s Watch Party`,
        hostUserId: user.id,
        currentVideoId: initialVideoId ?? '',
        playbackStatus: 'PAUSED',
        lastPositionSeconds: 0,
        stateVersion: 0,
      },
    });

    // 3. Create the HOST RoomParticipant record
    // (maintains Room.hostUserId ↔ RoomParticipant.role consistency)
    await tx.roomParticipant.create({
      data: {
        roomId: room.id,
        userId: user.id,
        role: 'HOST',
        isOnline: true,
      },
    });

    return { user, room };
  });

  // 4. Load room into memory immediately
  roomStateManager.loadRoom({
    roomId: result.room.id,
    roomCode: code,
    title: result.room.title,
    hostUserId: result.user.id,
    playback: {
      videoId: initialVideoId ?? '',
      status: 'PAUSED',
      anchorPositionSeconds: 0,
      anchorTimestampMs: Date.now(),
      stateVersion: 0,
    },
    participants: [
      {
        userId: result.user.id,
        displayName,
        role: 'HOST',
        isOnline: true,
        socketId: null,
        joinedAt: new Date(),
      },
    ],
  });

  // 5. Issue session JWT (no role in token)
  const sessionToken = await issueSession({
    sessionId,
    userId: result.user.id,
    roomId: result.room.id,
    roomCode: code,
    displayName,
  });

  return {
    sessionToken,
    room: {
      id: result.room.id,
      code,
      title: result.room.title,
      hostUserId: result.user.id,
    },
    userId: result.user.id,
  };
}

/**
 * Joins an existing room as a PARTICIPANT.
 * If the user was a previous member (reconnecting), restores their record.
 * Returns the session token and the user's current role.
 */
export async function joinRoom(
  roomCode: string,
  displayName: string,
): Promise<{
  sessionToken: string;
  room: { id: string; code: string; title: string; hostUserId: string };
  userId: string;
  role: Role;
}> {
  const sessionId = `sess_${uuidv4()}`;

  // 1. Find the room
  const room = await prisma.room.findUnique({
    where: { code: roomCode },
  });

  if (!room) throw new Error('ROOM_NOT_FOUND');
  if (room.isClosed) throw new Error('ROOM_CLOSED');

  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // 2. Create the User
    const user = await tx.user.create({
      data: { displayName },
    });

    // 3. Create RoomParticipant (always as PARTICIPANT for new joins via this endpoint)
    await tx.roomParticipant.create({
      data: {
        roomId: room.id,
        userId: user.id,
        role: 'PARTICIPANT',
        isOnline: true,
      },
    });

    return { user };
  });

  // 4. Ensure room is in memory (cold-start recovery if needed)
  if (!roomStateManager.hasRoom(roomCode)) {
    await loadRoomIntoMemory(room.id, roomCode);
  }

  // 5. Add participant to in-memory state
  const existingParticipant = roomStateManager.getParticipant(roomCode, result.user.id);
  if (!existingParticipant) {
    roomStateManager.addParticipant(roomCode, {
      userId: result.user.id,
      displayName,
      role: 'PARTICIPANT',
      isOnline: true,
      socketId: null,
      joinedAt: new Date(),
    });
  }

  // 6. Issue session JWT
  const sessionToken = await issueSession({
    sessionId,
    userId: result.user.id,
    roomId: room.id,
    roomCode,
    displayName,
  });

  return {
    sessionToken,
    room: {
      id: room.id,
      code: roomCode,
      title: room.title,
      hostUserId: room.hostUserId,
    },
    userId: result.user.id,
    role: 'PARTICIPANT',
  };
}

/**
 * Loads a room from PostgreSQL into the RoomStateManager.
 * Called on cold-start (server restart) or cache miss.
 */
export async function loadRoomIntoMemory(roomId: string, roomCode: string): Promise<void> {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    include: {
      participants: {
        where: { isBanned: false },
        include: { user: true },
      },
    },
  });

  if (!room || room.isClosed) return;

  const recoveredState = computeRecoveryState(
    room.playbackStatus,
    room.lastPositionSeconds,
    room.lastPositionUpdatedAt,
    room.stateVersion,
  );

  const participants: RoomParticipantState[] = room.participants.map((p: { userId: string; user: { displayName: string }; role: string; joinedAt: Date }) => ({
    userId: p.userId,
    displayName: p.user.displayName,
    role: p.role as Role,
    isOnline: false, // Will be set to true when they actually connect via socket
    socketId: null,
    joinedAt: p.joinedAt,
  }));

  roomStateManager.loadRoom({
    roomId: room.id,
    roomCode,
    title: room.title,
    hostUserId: room.hostUserId,
    playback: {
      videoId: room.currentVideoId,
      ...recoveredState,
    },
    participants,
  });
}

/**
 * Builds the SyncStatePayload for a joining/reconnecting user.
 * Sent as the response to join_room socket event.
 */
export function buildSyncStatePayload(
  roomCode: string,
  currentUserId: string,
  pendingRequests: PlaybackRequestDTO[],
  recentMessages: import('@watchparty/types').ChatMessageDTO[],
): SyncStatePayload | null {
  const room = roomStateManager.getRoom(roomCode);
  if (!room) return null;

  const currentUserState = roomStateManager.getParticipant(roomCode, currentUserId);
  if (!currentUserState) return null;

  const participants: ParticipantDTO[] = roomStateManager.getParticipants(roomCode).map((p) => ({
    userId: p.userId,
    displayName: p.displayName,
    role: p.role,
    isOnline: p.isOnline,
    joinedAt: p.joinedAt.toISOString(),
  }));

  const nowMs = Date.now();
  return {
    room: {
      id: room.roomId,
      code: room.roomCode,
      title: room.title,
      hostUserId: room.hostUserId,
    },
    playback: {
      ...room.playback,
      serverTimeMs: nowMs,
    },
    currentUser: {
      userId: currentUserState.userId,
      displayName: currentUserState.displayName,
      role: currentUserState.role,
    },
    participants,
    pendingRequests,
    recentMessages,
  };
}
