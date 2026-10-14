/**
 * Session Service
 *
 * Handles JWT issuance, verification, and session revocation.
 *
 * Security design:
 * - JWTs contain only immutable identity: sessionId, userId, roomId, displayName.
 * - NO role is stored in the JWT. Role is always read from RoomStateManager or DB.
 * - Token hash (SHA-256) is stored in the Session table for revocation lookup.
 * - On kick/ban: Session.isRevoked = true + socket forcefully disconnected.
 * - On handshake: JWT signature + Session.isRevoked + RoomParticipant.isBanned checked.
 */

import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { SessionTokenPayload } from '@watchparty/types';
import { config } from '../config';
import { prisma } from '../db/prisma';

/**
 * Hashes a JWT string with SHA-256 for database storage.
 * We store the hash, never the raw token, to limit exposure.
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Issues a signed JWT and creates a Session record in the database.
 * Returns the signed token string.
 */
export async function issueSession(payload: Omit<SessionTokenPayload, 'iat' | 'exp'>): Promise<string> {
  const token = jwt.sign(payload, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn as jwt.SignOptions['expiresIn'],
  });

  const decoded = jwt.decode(token) as SessionTokenPayload;
  const expiresAt = new Date((decoded.exp ?? 0) * 1000);

  // Upsert: if user rejoins same room, update their existing session
  await prisma.session.upsert({
    where: { userId_roomId: { userId: payload.userId, roomId: payload.roomId } },
    update: {
      tokenHash: hashToken(token),
      isRevoked: false,
      expiresAt,
    },
    create: {
      id: payload.sessionId,
      userId: payload.userId,
      roomId: payload.roomId,
      tokenHash: hashToken(token),
      isRevoked: false,
      expiresAt,
    },
  });

  return token;
}

/**
 * Verifies a JWT and validates the session against the database.
 *
 * Checks:
 * 1. JWT signature and expiry (jsonwebtoken)
 * 2. Session.isRevoked === false (prevents kicked users from reconnecting)
 * 3. RoomParticipant.isBanned === false
 *
 * Returns the decoded payload or throws an error with a descriptive message.
 */
export async function verifySession(token: string): Promise<SessionTokenPayload> {
  // 1. Verify JWT signature and expiry
  let payload: SessionTokenPayload;
  try {
    payload = jwt.verify(token, config.jwt.secret) as SessionTokenPayload;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw new Error('SESSION_EXPIRED');
    }
    throw new Error('INVALID_TOKEN');
  }

  const tokenHash = hashToken(token);

  // 2. Check session is not revoked
  const session = await prisma.session.findFirst({
    where: { tokenHash },
  });

  if (!session) {
    throw new Error('SESSION_NOT_FOUND');
  }

  if (session.isRevoked) {
    throw new Error('SESSION_REVOKED');
  }

  if (session.expiresAt < new Date()) {
    throw new Error('SESSION_EXPIRED');
  }

  // 3. Check participant is not banned
  const participant = await prisma.roomParticipant.findUnique({
    where: {
      roomId_userId: {
        roomId: payload.roomId,
        userId: payload.userId,
      },
    },
  });

  if (!participant) {
    throw new Error('NOT_A_MEMBER');
  }

  if (participant.isBanned) {
    throw new Error('PARTICIPANT_BANNED');
  }

  return payload;
}

/**
 * Revokes a session by setting isRevoked = true.
 * Called when a participant is kicked or banned.
 */
export async function revokeSession(userId: string, roomId: string): Promise<void> {
  await prisma.session.updateMany({
    where: { userId, roomId },
    data: { isRevoked: true },
  });
}
