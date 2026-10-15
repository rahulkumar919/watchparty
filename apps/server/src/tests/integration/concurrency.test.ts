/**
 * Integration tests: Concurrent request resolution
 *
 * This test verifies the atomic conditional update pattern for request approval.
 * When two operators (Host + Moderator) both click "Approve" simultaneously,
 * exactly ONE should succeed and the other should receive CONFLICT.
 *
 * This is the core concurrency safety guarantee of the system.
 */

import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as ioClient, Socket } from 'socket.io-client';
import supertest from 'supertest';
import { createApp } from '../../app';
import { startTestServer, TestServer } from '../helpers';
import { SyncStatePayload, PlaybackRequestDTO, SocketResponse } from '@watchparty/types';
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

function connectSocket(token: string, serverUrl: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(serverUrl, {
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
      else reject(new Error(res.error?.message ?? 'join failed'));
    });
  });
}

describe('Atomic request resolution (concurrency safety)', () => {
  it('exactly one of two concurrent approvals succeeds, the other gets CONFLICT', async () => {
    const host = await setupRoom('ConcurrencyHost');

    // Promote a second user to Moderator so we have two resolvers
    const { sessionToken: modToken } = await joinRoom(host.room.code, 'TheModerator');
    const { sessionToken: participantToken } = await joinRoom(host.room.code, 'TheRequester');

    const hostSocket = await connectSocket(host.sessionToken, testServer.url);
    const modSocket = await connectSocket(modToken, testServer.url);
    const participantSocket = await connectSocket(participantToken, testServer.url);

    await joinRoomSocket(hostSocket, host.room.code);
    const modSync = await joinRoomSocket(modSocket, host.room.code);
    await joinRoomSocket(participantSocket, host.room.code);

    // Promote the moderator via assign_role
    await new Promise<void>((resolve) => {
      hostSocket.emit(
        'assign_role',
        { targetUserId: modSync.currentUser.userId, newRole: 'MODERATOR' },
        () => resolve(),
      );
    });

    // Participant submits a SEEK request
    const request = await new Promise<PlaybackRequestDTO>((resolve, reject) => {
      participantSocket.emit(
        'request_playback_action',
        { action: 'SEEK', targetPositionSeconds: 60 },
        (res: SocketResponse<PlaybackRequestDTO>) => {
          if (res.success && res.data) resolve(res.data);
          else reject(new Error(res.error?.message ?? 'request failed'));
        },
      );
    });

    expect(request.status).toBe('PENDING');

    // Host and Moderator both approve simultaneously
    const [hostResult, modResult] = await Promise.all([
      new Promise<SocketResponse>((resolve) => {
        hostSocket.emit(
          'resolve_playback_request',
          { requestId: request.id, decision: 'APPROVED' },
          resolve,
        );
      }),
      new Promise<SocketResponse>((resolve) => {
        modSocket.emit(
          'resolve_playback_request',
          { requestId: request.id, decision: 'APPROVED' },
          resolve,
        );
      }),
    ]);

    const results = [hostResult, modResult];
    const successes = results.filter((r) => r.success);
    const conflicts = results.filter((r) => !r.success && r.error?.code === 'CONFLICT');

    // Exactly one succeeds, exactly one gets CONFLICT
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(1);

    // Verify DB: request is now APPROVED (not PENDING)
    const dbRequest = await prisma.playbackRequest.findUnique({
      where: { id: request.id },
    });
    expect(dbRequest?.status).toBe('APPROVED');

    hostSocket.disconnect();
    modSocket.disconnect();
    participantSocket.disconnect();
  });

  it('resolving an already-resolved request returns CONFLICT', async () => {
    const host = await setupRoom('AlreadyResolvedHost');
    const { sessionToken: pToken } = await joinRoom(host.room.code, 'Requester2');

    const hostSocket = await connectSocket(host.sessionToken, testServer.url);
    const pSocket = await connectSocket(pToken, testServer.url);

    await joinRoomSocket(hostSocket, host.room.code);
    await joinRoomSocket(pSocket, host.room.code);

    // Participant creates a request
    const request = await new Promise<PlaybackRequestDTO>((resolve, reject) => {
      pSocket.emit(
        'request_playback_action',
        { action: 'PAUSE', targetPositionSeconds: 0 },
        (res: SocketResponse<PlaybackRequestDTO>) => {
          if (res.success && res.data) resolve(res.data);
          else reject(new Error('request failed'));
        },
      );
    });

    // Host approves it once
    await new Promise<void>((resolve) => {
      hostSocket.emit(
        'resolve_playback_request',
        { requestId: request.id, decision: 'APPROVED' },
        () => resolve(),
      );
    });

    // Host tries to approve the same request again
    const secondAttempt = await new Promise<SocketResponse>((resolve) => {
      hostSocket.emit(
        'resolve_playback_request',
        { requestId: request.id, decision: 'REJECTED', reason: 'Changed my mind' },
        resolve,
      );
    });

    expect(secondAttempt.success).toBe(false);
    expect(secondAttempt.error?.code).toBe('CONFLICT');

    hostSocket.disconnect();
    pSocket.disconnect();
  });
});

describe('Role management', () => {
  it('HOST can promote PARTICIPANT to MODERATOR', async () => {
    const host = await setupRoom('RoleHost');
    const { sessionToken: pToken } = await joinRoom(host.room.code, 'ToBePromoted');

    const hostSocket = await connectSocket(host.sessionToken, testServer.url);
    const pSocket = await connectSocket(pToken, testServer.url);

    await joinRoomSocket(hostSocket, host.room.code);
    const pSync = await joinRoomSocket(pSocket, host.room.code);

    expect(pSync.currentUser.role).toBe('PARTICIPANT');

    // Promote the participant
    const result = await new Promise<SocketResponse>((resolve) => {
      hostSocket.emit(
        'assign_role',
        { targetUserId: pSync.currentUser.userId, newRole: 'MODERATOR' },
        resolve,
      );
    });

    expect(result.success).toBe(true);

    // Promoted moderator should now be able to play
    const playResult = await new Promise<SocketResponse>((resolve) => {
      pSocket.emit('play', { positionSeconds: 0 }, resolve);
    });

    expect(playResult.success).toBe(true);

    hostSocket.disconnect();
    pSocket.disconnect();
  });

  it('MODERATOR cannot assign roles', async () => {
    const host = await setupRoom('RoleHost2');
    const { sessionToken: mToken } = await joinRoom(host.room.code, 'ModUser');
    const { sessionToken: pToken } = await joinRoom(host.room.code, 'PUser');

    const hostSocket = await connectSocket(host.sessionToken, testServer.url);
    const modSocket = await connectSocket(mToken, testServer.url);
    const pSocket = await connectSocket(pToken, testServer.url);

    await joinRoomSocket(hostSocket, host.room.code);
    const modSync = await joinRoomSocket(modSocket, host.room.code);
    const pSync = await joinRoomSocket(pSocket, host.room.code);

    // Host promotes mod
    await new Promise<void>((resolve) => {
      hostSocket.emit(
        'assign_role',
        { targetUserId: modSync.currentUser.userId, newRole: 'MODERATOR' },
        () => resolve(),
      );
    });

    // Mod tries to promote participant — should be FORBIDDEN
    const result = await new Promise<SocketResponse>((resolve) => {
      modSocket.emit(
        'assign_role',
        { targetUserId: pSync.currentUser.userId, newRole: 'MODERATOR' },
        resolve,
      );
    });

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('FORBIDDEN');

    hostSocket.disconnect();
    modSocket.disconnect();
    pSocket.disconnect();
  });
});
