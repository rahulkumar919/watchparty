/**
 * Chat Service
 *
 * Handles all persistence for room chat messages.
 *
 * Security contract:
 * - Caller MUST pass userId, displayName, and roomId taken from
 *   socket.data.session (the verified JWT) — NEVER from the client payload.
 * - Body must already be validated and trimmed by the caller (Zod schema).
 *
 * Two-tier strategy (matches playback service pattern):
 * - createChatMessage: DB-first — the message is persisted before it is
 *   broadcast. If the DB write fails the caller must not broadcast.
 * - getRoomChatHistory: bounded to CHAT_HISTORY_LIMIT (50) so we never
 *   load unbounded rows into memory.
 */

import { ChatMessageDTO } from '@watchparty/types';
import { prisma } from '../db/prisma';
import type { ChatMessage } from '@prisma/client';

/** Maximum number of recent messages returned for history/join sync. */
export const CHAT_HISTORY_LIMIT = 50;

/**
 * Persists a new chat message and returns it as a ChatMessageDTO.
 * Throws on database failure — callers must handle and not broadcast on error.
 */
export async function createChatMessage(
  roomId: string,
  userId: string,
  displayName: string,
  body: string,
): Promise<ChatMessageDTO> {
  const msg = await prisma.chatMessage.create({
    data: { roomId, userId, displayName, body },
  });

  return {
    id: msg.id,
    roomId: msg.roomId,
    userId: msg.userId,
    displayName: msg.displayName,
    body: msg.body,
    createdAt: msg.createdAt.toISOString(),
  };
}

/**
 * Returns the latest CHAT_HISTORY_LIMIT messages for a room in chronological
 * order (oldest first).
 *
 * Strategy: take the last N rows (ORDER BY createdAt DESC LIMIT N) then
 * reverse in application memory — avoids a sub-query while keeping the result
 * in the expected display order.
 *
 * Returns an empty array if the room has no messages or on DB failure
 * (non-fatal: history unavailability should not block room join).
 */
export async function getRoomChatHistory(roomId: string): Promise<ChatMessageDTO[]> {
  try {
    const rows = await prisma.chatMessage.findMany({
      where: { roomId },
      orderBy: { createdAt: 'desc' },
      take: CHAT_HISTORY_LIMIT,
      select: {
        id: true,
        roomId: true,
        userId: true,
        displayName: true,
        body: true,
        createdAt: true,
      },
    });

    // Reverse to get chronological (oldest-first) order for display
    return rows.reverse().map((m: ChatMessage) => ({
      id: m.id,
      roomId: m.roomId,
      userId: m.userId,
      displayName: m.displayName,
      body: m.body,
      createdAt: m.createdAt.toISOString(),
    }));
  } catch (err) {
    console.error('[ChatService] Failed to load chat history:', err);
    return [];
  }
}
