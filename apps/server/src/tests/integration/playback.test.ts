/**
 * Integration tests: Socket.IO — Playback synchronization and RBAC
 *
 * Tests:
 * 1. Room isolation: Host in Room A plays, Participant in Room B gets NO event
 * 2. Permission enforcement: PARTICIPANT emitting play → FORBIDDEN
 * 3. Host play → all room members receive playback_updated
 * 4. Late-joiner sync: participant joins after host plays → receives computed position
 * 5. Seek updates position across all members
 */

import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as ioClient, Socket } from 'socket.io-client';
import supertest from 'supertest';
import { createApp } from '../../app';
import { startTestServer, TestServer } from '../helpers';
import {
  SyncStatePayload,
  PlaybackUpdatedPayload,
  SocketResponse,
} from '@watchparty/types';
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

const api = () => supertest(createApp());

async function setupRoom(hostName: string) {
  const res = await api().post('/api/rooms').send({ displayName: hostName });
  createdRoomCodes.push(res.body.room.code);
  return res.body as { sessionToken: string; room: { code: string } };
}

async function joinRoom(roomCode: string, displayName: string) {
  const res = await api().post('/api/rooms/join').send({ roomCode, displayName });
  return res.body as { sessionToken: string };
}

function connectSocket(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(testServer.url, {
      auth: { token },
      transports: ['websocket'],
    });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}

function joinRoomSocket(socket: Socket, roomCode: string): Promise<SyncStatePayload> {
  return new Promise((resolve, reject) => {
    socket.emit('join_room', { roomCode }, (res: SocketResponse<SyncStatePayload>) => {
      if (res.success && res.data) resolve(res.data);
      else reject(new Error(res.error?.message ?? 'join_room failed'));
    });
  });
}

function waitForEvent<T>(socket: Socket, event: string, timeout = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${event}`)), timeout);
    socket.once(event, (data: T) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

// ─── Test Suites ─────────────────────────────────────────────────────────────

describe('Room isolation', () => {
  it('events in Room A do not leak to Room B', async () => {
    const roomA = await setupRoom('HostA');
    const roomB = await setupRoom('HostB');

    const socketA = await connectSocket(roomA.sessionToken);
    const socketB = await connectSocket(roomB.sessionToken);

    await joinRoomSocket(socketA, roomA.room.code);
    await joinRoomSocket(socketB, roomB.room.code);

    // Listen for leak in Room B
    let leaked = false;
    socketB.on('playback_updated', () => { leaked = true; });

    // Host A plays
    await new Promise<void>((resolve) => {
      socketA.emit('play', { positionSeconds: 10 }, () => resolve());
    });

    // Wait a bit and confirm no event in Room B
    await new Promise((r) => setTimeout(r, 300));
    expect(leaked).toBe(false);

    socketA.disconnect();
    socketB.disconnect();
  });
});

describe('RBAC enforcement (server-side)', () => {
  it('PARTICIPANT emitting play receives FORBIDDEN', async () => {
    const host = await setupRoom('PermHost');
    const { sessionToken: participantToken } = await joinRoom(host.room.code, 'ParticipantUser');

    const hostSocket = await connectSocket(host.sessionToken);
    const participantSocket = await connectSocket(participantToken);

    await joinRoomSocket(hostSocket, host.room.code);
    await joinRoomSocket(participantSocket, host.room.code);

    const response = await new Promise<SocketResponse>((resolve) => {
      participantSocket.emit('play', { positionSeconds: 30 }, resolve);
    });

    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('FORBIDDEN');

    hostSocket.disconnect();
    participantSocket.disconnect();
  });

  it('PARTICIPANT emitting pause receives FORBIDDEN', async () => {
    const host = await setupRoom('PermHost2');
    const { sessionToken: pToken } = await joinRoom(host.room.code, 'PGuest');

    const hSocket = await connectSocket(host.sessionToken);
    const pSocket = await connectSocket(pToken);

    await joinRoomSocket(hSocket, host.room.code);
    await joinRoomSocket(pSocket, host.room.code);

    const response = await new Promise<SocketResponse>((resolve) => {
      pSocket.emit('pause', { positionSeconds: 0 }, resolve);
    });

    expect(response.success).toBe(false);
    expect(response.error?.code).toBe('FORBIDDEN');

    hSocket.disconnect();
    pSocket.disconnect();
  });
});

describe('Playback synchronization', () => {
  it('HOST play broadcasts playback_updated to all room members', async () => {
    const host = await setupRoom('SyncHost');
    const { sessionToken: pToken } = await joinRoom(host.room.code, 'SyncGuest');

    const hostSocket = await connectSocket(host.sessionToken);
    const guestSocket = await connectSocket(pToken);

    await joinRoomSocket(hostSocket, host.room.code);
    await joinRoomSocket(guestSocket, host.room.code);

    // Listen for playback_updated on the guest
    const playbackPromise = waitForEvent<PlaybackUpdatedPayload>(guestSocket, 'playback_updated');

    // Host plays at position 42
    await new Promise<void>((resolve) => {
      hostSocket.emit('play', { positionSeconds: 42 }, () => resolve());
    });

    const update = await playbackPromise;
    expect(update.action).toBe('PLAY');
    expect(update.status).toBe('PLAYING');
    expect(update.anchorPositionSeconds).toBe(42);
    expect(update.stateVersion).toBeGreaterThan(0);
    expect(update.triggeredByDisplayName).toBe('SyncHost');

    hostSocket.disconnect();
    guestSocket.disconnect();
  });

  it('HOST seek updates position across all members', async () => {
    const host = await setupRoom('SeekHost');
    const { sessionToken: pToken } = await joinRoom(host.room.code, 'SeekGuest');

    const hostSocket = await connectSocket(host.sessionToken);
    const guestSocket = await connectSocket(pToken);

    await joinRoomSocket(hostSocket, host.room.code);
    await joinRoomSocket(guestSocket, host.room.code);

    const updatePromise = waitForEvent<PlaybackUpdatedPayload>(guestSocket, 'playback_updated');

    hostSocket.emit('seek', { targetPositionSeconds: 120 });
    const update = await updatePromise;

    expect(update.action).toBe('SEEK');
    expect(update.anchorPositionSeconds).toBe(120);

    hostSocket.disconnect();
    guestSocket.disconnect();
  });

  it('pause broadcasts PAUSED status with frozen position', async () => {
    const host = await setupRoom('PauseHost');
    const { sessionToken: pToken } = await joinRoom(host.room.code, 'PauseGuest');

    const hostSocket = await connectSocket(host.sessionToken);
    const guestSocket = await connectSocket(pToken);

    await joinRoomSocket(hostSocket, host.room.code);
    await joinRoomSocket(guestSocket, host.room.code);

    // First play
    await new Promise<void>((resolve) => {
      hostSocket.emit('play', { positionSeconds: 10 }, () => resolve());
    });

    await waitForEvent(guestSocket, 'playback_updated'); // consume play event

    const pausePromise = waitForEvent<PlaybackUpdatedPayload>(guestSocket, 'playback_updated');
    hostSocket.emit('pause', { positionSeconds: 25 });
    const update = await pausePromise;

    expect(update.action).toBe('PAUSE');
    expect(update.status).toBe('PAUSED');
    expect(update.anchorPositionSeconds).toBe(25);

    hostSocket.disconnect();
    guestSocket.disconnect();
  });
});

describe('Late-joiner sync', () => {
  it('late-joining participant receives current playing position', async () => {
    const host = await setupRoom('LateHost');

    const hostSocket = await connectSocket(host.sessionToken);
    await joinRoomSocket(hostSocket, host.room.code);

    // Host plays at position 100
    const playTime = Date.now();
    await new Promise<void>((resolve) => {
      hostSocket.emit('play', { positionSeconds: 100 }, () => resolve());
    });

    // Wait 500ms to simulate passage of time
    await new Promise((r) => setTimeout(r, 500));

    // Late-joiner connects
    const { sessionToken: pToken } = await joinRoom(host.room.code, 'LateGuest');
    const pSocket = await connectSocket(pToken);
    const syncState = await joinRoomSocket(pSocket, host.room.code);

    // Expected position: ~100.5 seconds (100 + 0.5s elapsed)
    const elapsed = (Date.now() - playTime) / 1000;
    const expectedPosition = 100 + elapsed;
    const tolerance = 1.0; // 1 second tolerance

    // The sync_state should show the room as PLAYING
    expect(syncState.playback.status).toBe('PLAYING');
    // The anchor math position should be close to the expected position
    const computedPosition =
      syncState.playback.anchorPositionSeconds +
      (syncState.playback.serverTimeMs - syncState.playback.anchorTimestampMs) / 1000;
    expect(Math.abs(computedPosition - expectedPosition)).toBeLessThan(tolerance);

    hostSocket.disconnect();
    pSocket.disconnect();
  });
});
