/**
 * Room REST API Routes
 *
 * POST /api/rooms        — Create a new room (returns session token)
 * POST /api/rooms/join   — Join an existing room (returns session token)
 * GET  /api/rooms/:code  — Get room info (public, no auth required)
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { DisplayNameSchema, CreateRoomRequest, JoinRoomRequest, CreateRoomResponse, JoinRoomResponse } from '@watchparty/types';
import { createRoom, joinRoom } from '../services/roomService';
import { prisma } from '../db/prisma';

const router = Router();

const CreateRoomSchema = z.object({
  displayName: DisplayNameSchema,
  title: z.string().min(1).max(100).optional(),
  initialVideoId: z
    .string()
    .regex(/^[a-zA-Z0-9_-]{11}$/)
    .optional(),
});

const JoinRoomSchema = z.object({
  roomCode: z.string().regex(/^[A-Z0-9]{8}$/, 'Invalid room code'),
  displayName: DisplayNameSchema,
});

// POST /api/rooms — Create a room
router.post('/', async (req: Request, res: Response): Promise<void> => {
  const result = CreateRoomSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: result.error.issues.map((i) => i.message).join('; ') } });
    return;
  }

  try {
    const { displayName, title, initialVideoId } = result.data;
    const { sessionToken, room, userId } = await createRoom(displayName, title, initialVideoId);

    const response: CreateRoomResponse = {
      sessionToken,
      room,
      userId,
      displayName,
    };
    res.status(201).json(response);
  } catch (err) {
    console.error('[POST /api/rooms]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create room' } });
  }
});

// POST /api/rooms/join — Join an existing room
router.post('/join', async (req: Request, res: Response): Promise<void> => {
  const result = JoinRoomSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: result.error.issues.map((i) => i.message).join('; ') } });
    return;
  }

  try {
    const { roomCode, displayName } = result.data;
    const data = await joinRoom(roomCode, displayName);

    const response: JoinRoomResponse = {
      sessionToken: data.sessionToken,
      room: data.room,
      userId: data.userId,
      displayName,
      role: data.role,
    };
    res.status(200).json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'UNKNOWN';
    if (message === 'ROOM_NOT_FOUND') {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Room not found' } });
    } else if (message === 'ROOM_CLOSED') {
      res.status(410).json({ error: { code: 'ROOM_CLOSED', message: 'This room has been closed' } });
    } else {
      console.error('[POST /api/rooms/join]', err);
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to join room' } });
    }
  }
});

// GET /api/rooms/:code — Get room info
router.get('/:code', async (req: Request, res: Response): Promise<void> => {
  const code = (req.params['code'] as string | undefined)?.toUpperCase();

  if (!code || !/^[A-Z0-9]{8}$/.test(code)) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Invalid room code' } });
    return;
  }

  try {
    const room = await prisma.room.findUnique({
      where: { code },
      select: {
        id: true,
        code: true,
        title: true,
        isClosed: true,
        hostUserId: true,
        _count: { select: { participants: { where: { isOnline: true, isBanned: false } } } },
      },
    });

    if (!room) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Room not found' } });
      return;
    }

    res.json({
      id: room.id,
      code: room.code,
      title: room.title,
      isClosed: room.isClosed,
      onlineCount: room._count.participants,
    });
  } catch (err) {
    console.error('[GET /api/rooms/:code]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to fetch room' } });
  }
});

export default router;
