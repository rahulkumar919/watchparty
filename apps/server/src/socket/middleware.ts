/**
 * Socket.IO Authentication Middleware
 *
 * Runs before any socket event handler.
 * Rejects connections with missing, invalid, expired, or revoked tokens.
 * Attaches socket.data.session with the verified identity.
 *
 * IMPORTANT: socket.data.session contains only IDENTITY (userId, roomId, displayName).
 * It does NOT contain the role. Roles are always read from RoomStateManager.
 */

import { Socket } from 'socket.io';
import { verifySession } from '../services/sessionService';
import { ClientToServerEvents, ServerToClientEvents, SocketData, InterServerEvents } from '@watchparty/types';

type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

export async function socketAuthMiddleware(
  socket: AppSocket,
  next: (err?: Error) => void,
): Promise<void> {
  const token = socket.handshake.auth?.token as string | undefined;

  if (!token || typeof token !== 'string') {
    return next(new Error('UNAUTHORIZED: Missing session token'));
  }

  try {
    const session = await verifySession(token);
    socket.data.session = {
      sessionId: session.sessionId,
      userId: session.userId,
      roomId: session.roomId,
      roomCode: session.roomCode,
      displayName: session.displayName,
    };
    next();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'UNAUTHORIZED';
    next(new Error(`UNAUTHORIZED: ${message}`));
  }
}
