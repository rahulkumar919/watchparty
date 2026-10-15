/**
 * Integration tests: REST API — Room creation and joining
 *
 * These tests require a live DATABASE_URL in the environment.
 * Run: npm run test --workspace=apps/server
 *
 * Each test cleans up after itself using cleanupRoom().
 */

import 'dotenv/config';
import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import supertest from 'supertest';
import { createApp } from '../../app';
import { prisma } from '../../db/prisma';

const app = createApp();
const request = supertest(app);
const createdRoomCodes: string[] = [];

beforeAll(async () => {
  // Verify DB is reachable
  await prisma.$queryRaw`SELECT 1`;
});

afterAll(async () => {
  // Clean up all rooms created during tests
  await prisma.room.deleteMany({ where: { code: { in: createdRoomCodes } } });
  await prisma.$disconnect();
});

describe('POST /api/rooms', () => {
  it('creates a room and returns a session token', async () => {
    const res = await request
      .post('/api/rooms')
      .send({ displayName: 'Alice', title: 'Test Room' })
      .expect(201);

    expect(res.body.sessionToken).toBeDefined();
    expect(typeof res.body.sessionToken).toBe('string');
    expect(res.body.room.code).toMatch(/^[A-Z0-9]{8}$/);
    expect(res.body.room.title).toBe('Test Room');
    expect(res.body.room.hostUserId).toBeDefined();
    expect(res.body.displayName).toBe('Alice');

    createdRoomCodes.push(res.body.room.code);
  });

  it('creates a room with a default title when none is provided', async () => {
    const res = await request
      .post('/api/rooms')
      .send({ displayName: 'Bob' })
      .expect(201);

    expect(res.body.room.title).toContain("Bob's Watch Party");
    createdRoomCodes.push(res.body.room.code);
  });

  it('rejects empty displayName', async () => {
    await request
      .post('/api/rooms')
      .send({ displayName: '' })
      .expect(400);
  });

  it('rejects displayName longer than 32 characters', async () => {
    await request
      .post('/api/rooms')
      .send({ displayName: 'a'.repeat(33) })
      .expect(400);
  });

  it('rejects missing displayName', async () => {
    await request
      .post('/api/rooms')
      .send({})
      .expect(400);
  });

  it('creates unique room codes for each request', async () => {
    const [res1, res2] = await Promise.all([
      request.post('/api/rooms').send({ displayName: 'User1' }),
      request.post('/api/rooms').send({ displayName: 'User2' }),
    ]);

    expect(res1.body.room.code).not.toBe(res2.body.room.code);
    createdRoomCodes.push(res1.body.room.code, res2.body.room.code);
  });
});

describe('POST /api/rooms/join', () => {
  let roomCode: string;

  beforeAll(async () => {
    const res = await request
      .post('/api/rooms')
      .send({ displayName: 'Host' });
    roomCode = res.body.room.code;
    createdRoomCodes.push(roomCode);
  });

  it('joins a room and returns a session token with PARTICIPANT role', async () => {
    const res = await request
      .post('/api/rooms/join')
      .send({ roomCode, displayName: 'Carol' })
      .expect(200);

    expect(res.body.sessionToken).toBeDefined();
    expect(res.body.role).toBe('PARTICIPANT');
    expect(res.body.room.code).toBe(roomCode);
    expect(res.body.displayName).toBe('Carol');
  });

  it('rejects joining a non-existent room', async () => {
    await request
      .post('/api/rooms/join')
      .send({ roomCode: 'XXXXXXXX', displayName: 'Dave' })
      .expect(404);
  });

  it('rejects invalid room code format (lowercase)', async () => {
    await request
      .post('/api/rooms/join')
      .send({ roomCode: 'abcd1234', displayName: 'Eve' })
      .expect(400);
  });

  it('rejects empty displayName', async () => {
    await request
      .post('/api/rooms/join')
      .send({ roomCode, displayName: '' })
      .expect(400);
  });
});

describe('GET /api/rooms/:code', () => {
  let roomCode: string;

  beforeAll(async () => {
    const res = await request
      .post('/api/rooms')
      .send({ displayName: 'Host' });
    roomCode = res.body.room.code;
    createdRoomCodes.push(roomCode);
  });

  it('returns room info for a valid code', async () => {
    const res = await request.get(`/api/rooms/${roomCode}`).expect(200);
    expect(res.body.code).toBe(roomCode);
    expect(res.body.isClosed).toBe(false);
    expect(typeof res.body.onlineCount).toBe('number');
  });

  it('returns 404 for unknown room code', async () => {
    await request.get('/api/rooms/XXXXXXXX').expect(404);
  });

  it('returns 400 for invalid code format', async () => {
    await request.get('/api/rooms/short').expect(400);
  });

  it('accepts lowercase code and normalizes it', async () => {
    const lower = roomCode.toLowerCase();
    const res = await request.get(`/api/rooms/${lower}`).expect(200);
    expect(res.body.code).toBe(roomCode);
  });
});

describe('GET /health', () => {
  it('returns status ok with db connected', async () => {
    const res = await request.get('/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.db).toBe('connected');
    expect(typeof res.body.uptime).toBe('number');
    expect(typeof res.body.activeRooms).toBe('number');
  });
});
