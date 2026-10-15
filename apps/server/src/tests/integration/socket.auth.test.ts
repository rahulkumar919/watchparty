/**
 * Integration tests: Socket.IO — Authentication and session management
 *
 * Tests:
 * 1. Valid JWT → connection accepted, join_room succeeds
 * 2. Missing token → connection rejected
 * 3. Invalid/tampered token → connection rejected
 * 4. Revoked session (kicked user) → reconnect rejected
 * 5. Room code mismatch in join_room payload → FORBIDDEN
 */

import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as ioClient, Socket } from 'socket.io-client';
import supertest from 'supertest';
import { createApp } from '../../app';
import { startTestServer, TestServer, waitForEvent } from '../helpers';
import { SyncStatePayload, SocketResponse } from '@watchparty/types';
import { prisma } from '../../db/prisma';

let testServer: TestServer;
let createdRoomCodes: string[] = [];

beforeAll(async () => {
  await prisma.$queryRaw`SELECT 1`;
  testServer = await startTestServer();
});

afterAll(async () => {
  await prisma.room.deleteMany({ where: { code: { in: createdRoomCodes } } });
  await prisma.$disconnect();
  await testServer.close();
});

async function createRoomAndGetToken(displayName = 'Host') {
  const res = await supertest(createApp())
    .post('/api/rooms')
    .send({ displayName });
  createdRoomCodes.push(res.body.room.code);
  return res.body as { sessionToken: string; room: { code: string; id: string } };
}

async function joinRoomAndGetToken(roomCode: string, displayName = 'Guest') {
  const res = await supertest(createApp())
    .post('/api/rooms/join')
    .send({ roomCode, displayName });
  return res.body as { sessionToken: string; room: { code: string } };
}

function createSocket(token?: string): Socket {
  return ioClient(testServer.url, {
    auth: token ? { token } : {},
    transports: ['websocket'],
    autoConnect: false,
  });
}

describe('Socket.IO Authentication', () => {
  it('accepts a valid session token', async () => {
    const { sessionToken } = await createRoomAndGetToken();
    const socket = createSocket(sessionToken);

    await new Promise<void>((resolve, reject) => {
      socket.on('connect', resolve);
      socket.on('connect_error', reject);
      socket.connect();
    });

    expect(socket.connected).toBe(true);
    socket.disconnect();
  });

  it('rejects connection with no token', async () => {
    const socket = createSocket(); // no token

    await expect(
      new Promise<void>((_, reject) => {
        socket.on('connect_error', (err) => reject(err));
        socket.on('connect', () => reject(new Error('Should not connect')));
        socket.connect();
      }),
    ).rejects.toBeDefined();

    socket.disconnect();
  });

  it('rejects connection with a tampered/invalid token', async () => {
    const socket = createSocket('invalid.jwt.token');

    await expect(
      new Promise<void>((_, reject) => {
        socket.on('connect_error', (err) => reject(err));
        socket.on('connect', () => reject(new Error('Should not connect')));
        socket.connect();
      }),
    ).rejects.toBeDefined();

    socket.disconnect();
  });
});

describe('join_room event', () => {
  it('returns sync_state after successful join', async () => {
    const { sessionToken, room } = await createRoomAndGetToken('HostUser');
    const socket = createSocket(sessionToken);

    await new Promise<void>((resolve) => {
      socket.on('connect', resolve);
      socket.connect();
    });

    const response = await new Promise<SocketResponse<SyncStatePayload>>((resolve) => {
      socket.emit('join_room', { roomCode: room.code }, resolve);
    });

    expect(response.success).toBe(true);
    expect(response.data?.room.code).toBe(room.code);
    expect(response.data?.currentUser.role).toBe('HOST');
    expect(response.data?.playback.status).toBe('PAUSED');
    expect(typeof response.data?.playback.serverTimeMs).toBe('number');

    socket.disconnect();
  });

  it('returns FORBIDDEN when room code does not match token', async () => {
    // Create two rooms
    const room1 = await createRoomAndGetToken('Host1');
    const room2 = await createRoomAndGetToken('Host2');

    // Try to use room1's token to join room2
    const socket = createSocket(room1.sessionToken);
    await new Promise<void>((resolve) => {
      socket.on('connect', resolve);
      socket.connect();
    });

    const response = await new Promise<SocketResponse<SyncStatePayload>>((resolve) => {
      socket.emit('join_room', { roomCode: room2.room.code }, resolve);
    });

    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('FORBIDDEN');

    socket.disconnect();
  });

  it('participant sees their own role as PARTICIPANT in sync_state', async () => {
    const host = await createRoomAndGetToken('TheHost');
    const participant = await joinRoomAndGetToken(host.room.code, 'TheGuest');

    const socket = createSocket(participant.sessionToken);
    await new Promise<void>((resolve) => {
      socket.on('connect', resolve);
      socket.connect();
    });

    const response = await new Promise<SocketResponse<SyncStatePayload>>((resolve) => {
      socket.emit('join_room', { roomCode: host.room.code }, resolve);
    });

    expect(response.success).toBe(true);
    expect(response.data?.currentUser.role).toBe('PARTICIPANT');
    expect(typeof response.data?.room.hostUserId).toBe('string');
    expect(response.data?.room.hostUserId.length).toBeGreaterThan(0);

    socket.disconnect();
  });
});

describe('sync_ping (NTP-lite clock sync)', () => {
  it('returns server timestamp close to current time', async () => {
    const { sessionToken, room } = await createRoomAndGetToken('PingHost');
    const socket = createSocket(sessionToken);

    await new Promise<void>((resolve) => {
      socket.on('connect', resolve);
      socket.connect();
    });

    // Join room first
    await new Promise<void>((resolve) => {
      socket.emit('join_room', { roomCode: room.code }, () => resolve());
    });

    const clientSendTime = Date.now();
    const serverTime = await new Promise<number>((resolve) => {
      socket.emit('sync_ping', clientSendTime, resolve);
    });

    const now = Date.now();
    // Server time should be between client send time and now (within 2 seconds of tolerance)
    expect(serverTime).toBeGreaterThanOrEqual(clientSendTime - 2000);
    expect(serverTime).toBeLessThanOrEqual(now + 2000);

    socket.disconnect();
  });
});

// ---------------------------------------------------------------------------
// sync_state event emission
// ---------------------------------------------------------------------------
// These tests verify the fix for the room initialization bug where the
// frontend's `useRoomState` hook was stuck waiting for a `sync_state` event
// that the backend never emitted (it only returned the payload in the ack).
// ---------------------------------------------------------------------------
describe('sync_state event on join_room', () => {
  it('emits sync_state event after a successful join_room (Host)', async () => {
    const { sessionToken, room } = await createRoomAndGetToken('SyncHost');
    const socket = createSocket(sessionToken);

    await new Promise<void>((resolve) => {
      socket.on('connect', resolve);
      socket.connect();
    });

    // Register the sync_state listener BEFORE emitting join_room so we do not
    // miss the event (mirrors how useRoomState hooks up listeners).
    const syncStatePromise = new Promise<SyncStatePayload>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('sync_state event was never emitted')),
        4000,
      );
      socket.on('sync_state', (data) => {
        clearTimeout(timer);
        resolve(data);
      });
    });

    // join_room ack and sync_state event should both carry the same payload
    const ackResponse = await new Promise<SocketResponse<SyncStatePayload>>((resolve) => {
      socket.emit('join_room', { roomCode: room.code }, resolve);
    });

    const syncState = await syncStatePromise;

    // ── ack assertions ──────────────────────────────────────────────────────
    expect(ackResponse.success).toBe(true);
    expect(ackResponse.data?.room.code).toBe(room.code);
    expect(ackResponse.data?.currentUser.role).toBe('HOST');

    // ── sync_state event assertions ─────────────────────────────────────────
    expect(syncState.room.code).toBe(room.code);
    expect(syncState.currentUser.role).toBe('HOST');
    expect(syncState.playback.status).toBe('PAUSED');
    expect(typeof syncState.playback.serverTimeMs).toBe('number');
    expect(Array.isArray(syncState.participants)).toBe(true);

    // Both payloads must agree on identity
    expect(syncState.room.id).toBe(ackResponse.data?.room.id);
    expect(syncState.currentUser.userId).toBe(ackResponse.data?.currentUser.userId);

    socket.disconnect();
  });

  it('emits sync_state event after a successful join_room (Participant)', async () => {
    const host = await createRoomAndGetToken('SyncHost2');
    const participant = await joinRoomAndGetToken(host.room.code, 'SyncGuest');

    const socket = createSocket(participant.sessionToken);
    await new Promise<void>((resolve) => {
      socket.on('connect', resolve);
      socket.connect();
    });

    const syncStatePromise = new Promise<SyncStatePayload>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('sync_state event was never emitted')),
        4000,
      );
      socket.on('sync_state', (data) => {
        clearTimeout(timer);
        resolve(data);
      });
    });

    socket.emit('join_room', { roomCode: host.room.code }, () => { });

    const syncState = await syncStatePromise;
    expect(syncState.currentUser.role).toBe('PARTICIPANT');
    expect(syncState.room.code).toBe(host.room.code);

    socket.disconnect();
  });

  it('does NOT emit sync_state when join_room fails (room code mismatch)', async () => {
    const room1 = await createRoomAndGetToken('MismatchHost1');
    const room2 = await createRoomAndGetToken('MismatchHost2');

    // Use room1 token but send room2 code → FORBIDDEN
    const socket = createSocket(room1.sessionToken);
    await new Promise<void>((resolve) => {
      socket.on('connect', resolve);
      socket.connect();
    });

    let syncStateEmitted = false;
    socket.on('sync_state', () => { syncStateEmitted = true; });

    const ackResponse = await new Promise<SocketResponse<SyncStatePayload>>((resolve) => {
      socket.emit('join_room', { roomCode: room2.room.code }, resolve);
    });

    // Give a short window to detect any erroneous emission
    await new Promise<void>((r) => setTimeout(r, 200));

    expect(ackResponse.success).toBe(false);
    expect(ackResponse.error?.code).toBe('FORBIDDEN');
    expect(syncStateEmitted).toBe(false);

    socket.disconnect();
  });

  it('does NOT emit sync_state when connection is rejected (invalid token)', async () => {
    const socket = createSocket('invalid.jwt.token');

    let syncStateEmitted = false;
    socket.on('sync_state', () => { syncStateEmitted = true; });

    await expect(
      new Promise<void>((_, reject) => {
        socket.on('connect_error', (err) => reject(err));
        socket.on('connect', () => reject(new Error('Should not connect')));
        socket.connect();
      }),
    ).rejects.toBeDefined();

    await new Promise<void>((r) => setTimeout(r, 200));
    expect(syncStateEmitted).toBe(false);

    socket.disconnect();
  });
});
