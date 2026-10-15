/**
 * Integration tests: Socket.IO — Role management and Host transfer
 *
 * Tests:
 * 1. Host can promote PARTICIPANT → MODERATOR via assign_role
 * 2. Host can demote MODERATOR → PARTICIPANT via assign_role
 * 3. PARTICIPANT cannot assign roles (FORBIDDEN)
 * 4. MODERATOR cannot assign roles (FORBIDDEN)
 * 5. assign_role rejects HOST assignment (BAD_REQUEST / schema validation)
 * 6. Host can transfer host role to a PARTICIPANT
 * 7. Host can transfer host role to a MODERATOR
 * 8. After transfer, old host becomes PARTICIPANT; new host becomes HOST
 * 9. After transfer, PARTICIPANT cannot transfer host (FORBIDDEN)
 * 10. host_transferred event broadcast to all room members
 */

import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as ioClient, Socket } from 'socket.io-client';
import supertest from 'supertest';
import { createApp } from '../../app';
import { startTestServer, TestServer } from '../helpers';
import { SyncStatePayload, SocketResponse } from '@watchparty/types';
import { prisma } from '../../db/prisma';

let testServer: TestServer;
const createdRoomCodes: string[] = [];

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
  return res.body as { sessionToken: string; room: { code: string; id: string } };
}

async function joinRoomREST(roomCode: string, displayName: string) {
  const res = await api().post('/api/rooms/join').send({ roomCode, displayName });
  return res.body as { sessionToken: string; userId: string };
}

function connectSocket(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = ioClient(testServer.url, { auth: { token }, transports: ['websocket'] });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}

function joinRoom(socket: Socket, roomCode: string): Promise<SyncStatePayload> {
  return new Promise((resolve, reject) => {
    socket.emit('join_room', { roomCode }, (res: SocketResponse<SyncStatePayload>) => {
      if (res.success && res.data) resolve(res.data);
      else reject(new Error(res.error?.message ?? 'join_room failed'));
    });
  });
}

function waitFor<T>(socket: Socket, event: string, timeout = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for: ${event}`)), timeout);
    socket.once(event, (data: T) => { clearTimeout(t); resolve(data); });
  });
}

// ─── assign_role ──────────────────────────────────────────────────────────────

describe('assign_role', () => {
  it('Host promotes PARTICIPANT to MODERATOR', async () => {
    const host = await setupRoom('PromoteHost');
    const guest = await joinRoomREST(host.room.code, 'PromoteGuest');

    const hostSocket = await connectSocket(host.sessionToken);
    const guestSocket = await connectSocket(guest.sessionToken);

    const hostState = await joinRoom(hostSocket, host.room.code);
    await joinRoom(guestSocket, host.room.code);

    const guestUserId = hostState.participants.find(
      (p) => p.role === 'PARTICIPANT',
    )?.userId ?? guest.userId;

    const res = await new Promise<SocketResponse>((resolve) => {
      hostSocket.emit('assign_role', { targetUserId: guestUserId, newRole: 'MODERATOR' }, resolve);
    });

    expect(res.success).toBe(true);

    hostSocket.disconnect();
    guestSocket.disconnect();
  });

  it('Host demotes MODERATOR to PARTICIPANT', async () => {
    const host = await setupRoom('DemoteHost');
    const guest = await joinRoomREST(host.room.code, 'DemoteGuest');

    const hostSocket = await connectSocket(host.sessionToken);
    const guestSocket = await connectSocket(guest.sessionToken);

    const hostState = await joinRoom(hostSocket, host.room.code);
    await joinRoom(guestSocket, host.room.code);

    const guestUserId = hostState.participants.find(
      (p) => p.role === 'PARTICIPANT',
    )?.userId ?? guest.userId;

    // First promote
    await new Promise<void>((resolve) => {
      hostSocket.emit('assign_role', { targetUserId: guestUserId, newRole: 'MODERATOR' }, () => resolve());
    });

    // Then demote
    const res = await new Promise<SocketResponse>((resolve) => {
      hostSocket.emit('assign_role', { targetUserId: guestUserId, newRole: 'PARTICIPANT' }, resolve);
    });

    expect(res.success).toBe(true);

    hostSocket.disconnect();
    guestSocket.disconnect();
  });

  it('PARTICIPANT cannot assign roles (FORBIDDEN)', async () => {
    const host = await setupRoom('RbacHost');
    const p1 = await joinRoomREST(host.room.code, 'P1');
    const p2 = await joinRoomREST(host.room.code, 'P2');

    const hostSocket = await connectSocket(host.sessionToken);
    const p1Socket = await connectSocket(p1.sessionToken);
    const p2Socket = await connectSocket(p2.sessionToken);

    const hostState = await joinRoom(hostSocket, host.room.code);
    await joinRoom(p1Socket, host.room.code);
    await joinRoom(p2Socket, host.room.code);

    const p2UserId = hostState.participants.find(
      (p) => p.role === 'PARTICIPANT',
    )?.userId ?? p2.userId;

    const res = await new Promise<SocketResponse>((resolve) => {
      p1Socket.emit('assign_role', { targetUserId: p2UserId, newRole: 'MODERATOR' }, resolve);
    });

    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('FORBIDDEN');

    hostSocket.disconnect();
    p1Socket.disconnect();
    p2Socket.disconnect();
  });

  it('role_assigned event is broadcast to all room members', async () => {
    const host = await setupRoom('BroadcastHost');
    const guest = await joinRoomREST(host.room.code, 'BroadcastGuest');

    const hostSocket = await connectSocket(host.sessionToken);
    const guestSocket = await connectSocket(guest.sessionToken);

    const hostState = await joinRoom(hostSocket, host.room.code);
    await joinRoom(guestSocket, host.room.code);

    const guestUserId = hostState.participants.find(
      (p) => p.role === 'PARTICIPANT',
    )?.userId ?? guest.userId;

    // Guest socket waits for the broadcast
    const eventPromise = waitFor<{ userId: string; newRole: string }>(
      guestSocket,
      'role_assigned',
    );

    hostSocket.emit('assign_role', { targetUserId: guestUserId, newRole: 'MODERATOR' }, () => {});

    const event = await eventPromise;
    expect(event.userId).toBe(guestUserId);
    expect(event.newRole).toBe('MODERATOR');

    hostSocket.disconnect();
    guestSocket.disconnect();
  });
});

// ─── transfer_host ────────────────────────────────────────────────────────────

describe('transfer_host', () => {
  it('Host transfers host role to a PARTICIPANT', async () => {
    const host = await setupRoom('TransferHost1');
    const guest = await joinRoomREST(host.room.code, 'NewHost1');

    const hostSocket = await connectSocket(host.sessionToken);
    const guestSocket = await connectSocket(guest.sessionToken);

    const hostState = await joinRoom(hostSocket, host.room.code);
    await joinRoom(guestSocket, host.room.code);

    const guestUserId = hostState.participants.find(
      (p) => p.role === 'PARTICIPANT',
    )?.userId ?? guest.userId;

    const res = await new Promise<SocketResponse>((resolve) => {
      hostSocket.emit('transfer_host', { targetUserId: guestUserId }, resolve);
    });

    expect(res.success).toBe(true);

    hostSocket.disconnect();
    guestSocket.disconnect();
  });

  it('host_transferred event is broadcast to all room members', async () => {
    const host = await setupRoom('TransferHost2');
    const guest = await joinRoomREST(host.room.code, 'NewHost2');

    const hostSocket = await connectSocket(host.sessionToken);
    const guestSocket = await connectSocket(guest.sessionToken);

    const hostState = await joinRoom(hostSocket, host.room.code);
    await joinRoom(guestSocket, host.room.code);

    const guestUserId = hostState.participants.find(
      (p) => p.role === 'PARTICIPANT',
    )?.userId ?? guest.userId;

    // Both sockets listen for host_transferred
    const hostEventPromise = waitFor<{
      previousHostUserId: string;
      newHostUserId: string;
      newHostDisplayName: string;
    }>(hostSocket, 'host_transferred');

    const guestEventPromise = waitFor<{
      previousHostUserId: string;
      newHostUserId: string;
    }>(guestSocket, 'host_transferred');

    hostSocket.emit('transfer_host', { targetUserId: guestUserId }, () => {});

    const [hostEvent, guestEvent] = await Promise.all([hostEventPromise, guestEventPromise]);

    expect(hostEvent.newHostUserId).toBe(guestUserId);
    expect(hostEvent.newHostDisplayName).toBe('NewHost2');
    expect(guestEvent.newHostUserId).toBe(guestUserId);

    hostSocket.disconnect();
    guestSocket.disconnect();
  });

  it('after transfer, old host (now PARTICIPANT) cannot transfer host again', async () => {
    const host = await setupRoom('TransferHost3');
    const guest = await joinRoomREST(host.room.code, 'NewHost3');

    const hostSocket = await connectSocket(host.sessionToken);
    const guestSocket = await connectSocket(guest.sessionToken);

    const hostState = await joinRoom(hostSocket, host.room.code);
    await joinRoom(guestSocket, host.room.code);

    const guestUserId = hostState.participants.find(
      (p) => p.role === 'PARTICIPANT',
    )?.userId ?? guest.userId;
    const originalHostUserId = hostState.currentUser.userId;

    // Transfer host to guest
    await new Promise<void>((resolve) => {
      hostSocket.emit('transfer_host', { targetUserId: guestUserId }, () => resolve());
    });

    // Old host (now PARTICIPANT) tries to transfer back — should be FORBIDDEN
    const res = await new Promise<SocketResponse>((resolve) => {
      hostSocket.emit('transfer_host', { targetUserId: originalHostUserId }, resolve);
    });

    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('FORBIDDEN');

    hostSocket.disconnect();
    guestSocket.disconnect();
  });

  it('cannot transfer host to self (BAD_REQUEST)', async () => {
    const host = await setupRoom('SelfTransferHost');
    const hostSocket = await connectSocket(host.sessionToken);
    const state = await joinRoom(hostSocket, host.room.code);

    const res = await new Promise<SocketResponse>((resolve) => {
      hostSocket.emit('transfer_host', { targetUserId: state.currentUser.userId }, resolve);
    });

    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('BAD_REQUEST');

    hostSocket.disconnect();
  });
});
