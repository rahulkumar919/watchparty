/**
 * Integration tests: Socket.IO — Real-time chat
 *
 * Tests:
 *  1. Host sends a message → ack contains ChatMessageDTO with correct fields
 *  2. PARTICIPANT sends a message → ack succeeds (all roles can chat)
 *  3. Sender receives message_received (broadcast includes sender)
 *  4. All room members receive message_received when any member sends
 *  5. Empty body is rejected (BAD_REQUEST)
 *  6. Body over 1000 chars is rejected (BAD_REQUEST)
 *  7. Whitespace-only body is rejected (BAD_REQUEST after trim)
 *  8. Body is trimmed server-side (leading/trailing whitespace stripped)
 *  9. join_room sync_state.recentMessages includes previously sent messages
 * 10. recentMessages is capped at 50 (CHAT_HISTORY_LIMIT)
 * 11. Messages from Room A do not appear in Room B (room isolation)
 * 12. message_received does NOT fire on sockets in a different room
 */

import 'dotenv/config';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { io as ioClient, Socket } from 'socket.io-client';
import supertest from 'supertest';
import { createApp } from '../../app';
import { startTestServer, TestServer } from '../helpers';
import {
  SyncStatePayload,
  ChatMessageDTO,
  SocketResponse,
} from '@watchparty/types';
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

// ── Helpers ───────────────────────────────────────────────────────────────────

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
    const s = ioClient(testServer.url, {
      auth: { token },
      transports: ['websocket'],
    });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
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

function sendMessage(
  socket: Socket,
  body: string,
): Promise<SocketResponse<ChatMessageDTO>> {
  return new Promise((resolve) => {
    socket.emit('send_message', { body }, resolve);
  });
}

function waitForEvent<T>(socket: Socket, event: string, timeout = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`Timeout waiting for event: ${event}`)),
      timeout,
    );
    socket.once(event, (data: T) => {
      clearTimeout(t);
      resolve(data);
    });
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('send_message — ack payload shape', () => {
  it('Host receives a valid ChatMessageDTO in the ack', async () => {
    const host = await setupRoom('AckHost');
    const hostSocket = await connectSocket(host.sessionToken);
    await joinRoomSocket(hostSocket, host.room.code);

    const res = await sendMessage(hostSocket, 'Hello from host');

    expect(res.success).toBe(true);
    expect(res.data).toBeDefined();
    const msg = res.data!;
    expect(typeof msg.id).toBe('string');
    expect(msg.id.length).toBeGreaterThan(0);
    expect(msg.body).toBe('Hello from host');
    expect(msg.displayName).toBe('AckHost');
    expect(typeof msg.roomId).toBe('string');
    expect(typeof msg.userId).toBe('string');
    expect(typeof msg.createdAt).toBe('string');
    // createdAt must be a parsable ISO timestamp
    expect(Number.isNaN(Date.parse(msg.createdAt))).toBe(false);

    hostSocket.disconnect();
  });

  it('PARTICIPANT can send a message — all roles may chat', async () => {
    const host = await setupRoom('RoleHost');
    const guest = await joinRoomREST(host.room.code, 'RoleGuest');

    const hostSocket = await connectSocket(host.sessionToken);
    const guestSocket = await connectSocket(guest.sessionToken);
    await joinRoomSocket(hostSocket, host.room.code);
    await joinRoomSocket(guestSocket, host.room.code);

    const res = await sendMessage(guestSocket, 'Participant message');

    expect(res.success).toBe(true);
    expect(res.data?.body).toBe('Participant message');
    expect(res.data?.displayName).toBe('RoleGuest');

    hostSocket.disconnect();
    guestSocket.disconnect();
  });
});

describe('send_message — broadcast', () => {
  it('sender receives message_received (server broadcasts to the whole room)', async () => {
    const host = await setupRoom('SenderBroadcastHost');
    const hostSocket = await connectSocket(host.sessionToken);
    await joinRoomSocket(hostSocket, host.room.code);

    const eventPromise = waitForEvent<ChatMessageDTO>(hostSocket, 'message_received');

    await sendMessage(hostSocket, 'Broadcast to self');

    const msg = await eventPromise;
    expect(msg.body).toBe('Broadcast to self');
    expect(msg.displayName).toBe('SenderBroadcastHost');

    hostSocket.disconnect();
  });

  it('all room members receive message_received when any member sends', async () => {
    const host = await setupRoom('FullBroadcastHost');
    const p1 = await joinRoomREST(host.room.code, 'BroadcastP1');
    const p2 = await joinRoomREST(host.room.code, 'BroadcastP2');

    const hostSocket = await connectSocket(host.sessionToken);
    const p1Socket = await connectSocket(p1.sessionToken);
    const p2Socket = await connectSocket(p2.sessionToken);

    await joinRoomSocket(hostSocket, host.room.code);
    await joinRoomSocket(p1Socket, host.room.code);
    await joinRoomSocket(p2Socket, host.room.code);

    // All three sockets wait for the event
    const hostPromise = waitForEvent<ChatMessageDTO>(hostSocket, 'message_received');
    const p1Promise = waitForEvent<ChatMessageDTO>(p1Socket, 'message_received');
    const p2Promise = waitForEvent<ChatMessageDTO>(p2Socket, 'message_received');

    // p1 sends
    await sendMessage(p1Socket, 'Hello everyone');

    const [hostMsg, p1Msg, p2Msg] = await Promise.all([hostPromise, p1Promise, p2Promise]);

    // All three receive the same message
    for (const msg of [hostMsg, p1Msg, p2Msg]) {
      expect(msg.body).toBe('Hello everyone');
      expect(msg.displayName).toBe('BroadcastP1');
      expect(typeof msg.id).toBe('string');
    }

    // All three received the same message id (same DB row)
    expect(hostMsg.id).toBe(p1Msg.id);
    expect(p1Msg.id).toBe(p2Msg.id);

    hostSocket.disconnect();
    p1Socket.disconnect();
    p2Socket.disconnect();
  });
});

describe('send_message — input validation', () => {
  it('empty body is rejected with BAD_REQUEST', async () => {
    const host = await setupRoom('ValidationHost1');
    const hostSocket = await connectSocket(host.sessionToken);
    await joinRoomSocket(hostSocket, host.room.code);

    const res = await sendMessage(hostSocket, '');

    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('BAD_REQUEST');

    hostSocket.disconnect();
  });

  it('body over 1000 chars is rejected with BAD_REQUEST', async () => {
    const host = await setupRoom('ValidationHost2');
    const hostSocket = await connectSocket(host.sessionToken);
    await joinRoomSocket(hostSocket, host.room.code);

    const longBody = 'a'.repeat(1001);
    const res = await sendMessage(hostSocket, longBody);

    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('BAD_REQUEST');

    hostSocket.disconnect();
  });

  it('whitespace-only body is rejected with BAD_REQUEST (trimmed to empty)', async () => {
    const host = await setupRoom('ValidationHost3');
    const hostSocket = await connectSocket(host.sessionToken);
    await joinRoomSocket(hostSocket, host.room.code);

    const res = await sendMessage(hostSocket, '   ');

    expect(res.success).toBe(false);
    expect(res.error?.code).toBe('BAD_REQUEST');

    hostSocket.disconnect();
  });

  it('body is trimmed server-side — leading/trailing whitespace stripped', async () => {
    const host = await setupRoom('TrimHost');
    const hostSocket = await connectSocket(host.sessionToken);
    await joinRoomSocket(hostSocket, host.room.code);

    const res = await sendMessage(hostSocket, '  trimmed  ');

    expect(res.success).toBe(true);
    expect(res.data?.body).toBe('trimmed');

    hostSocket.disconnect();
  });

  it('body at exactly 1000 chars is accepted', async () => {
    const host = await setupRoom('MaxLenHost');
    const hostSocket = await connectSocket(host.sessionToken);
    await joinRoomSocket(hostSocket, host.room.code);

    const exactBody = 'x'.repeat(1000);
    const res = await sendMessage(hostSocket, exactBody);

    expect(res.success).toBe(true);
    expect(res.data?.body).toBe(exactBody);

    hostSocket.disconnect();
  });
});

describe('join_room — recentMessages in sync_state', () => {
  it('late-joining participant receives previously sent messages in sync_state', async () => {
    const host = await setupRoom('HistoryHost');
    const hostSocket = await connectSocket(host.sessionToken);
    await joinRoomSocket(hostSocket, host.room.code);

    // Host sends two messages
    const res1 = await sendMessage(hostSocket, 'Message one');
    const res2 = await sendMessage(hostSocket, 'Message two');
    expect(res1.success).toBe(true);
    expect(res2.success).toBe(true);

    // New participant joins after the messages were sent
    const lateJoiner = await joinRoomREST(host.room.code, 'LateChatter');
    const lateSocket = await connectSocket(lateJoiner.sessionToken);
    const syncState = await joinRoomSocket(lateSocket, host.room.code);

    const bodies = syncState.recentMessages.map((m) => m.body);
    expect(bodies).toContain('Message one');
    expect(bodies).toContain('Message two');

    // Messages are in chronological order (oldest first)
    const idx1 = bodies.indexOf('Message one');
    const idx2 = bodies.indexOf('Message two');
    expect(idx1).toBeLessThan(idx2);

    hostSocket.disconnect();
    lateSocket.disconnect();
  });

  it('recentMessages contains valid ChatMessageDTO fields', async () => {
    const host = await setupRoom('HistoryShapeHost');
    const hostSocket = await connectSocket(host.sessionToken);
    await joinRoomSocket(hostSocket, host.room.code);

    await sendMessage(hostSocket, 'Shape check message');

    const guest = await joinRoomREST(host.room.code, 'ShapeGuest');
    const guestSocket = await connectSocket(guest.sessionToken);
    const syncState = await joinRoomSocket(guestSocket, host.room.code);

    const msg = syncState.recentMessages.find((m) => m.body === 'Shape check message');
    expect(msg).toBeDefined();
    expect(typeof msg!.id).toBe('string');
    expect(typeof msg!.roomId).toBe('string');
    expect(typeof msg!.userId).toBe('string');
    expect(msg!.displayName).toBe('HistoryShapeHost');
    expect(Number.isNaN(Date.parse(msg!.createdAt))).toBe(false);

    hostSocket.disconnect();
    guestSocket.disconnect();
  });

  it('recentMessages is empty for a fresh room with no messages', async () => {
    const host = await setupRoom('EmptyHistoryHost');
    const hostSocket = await connectSocket(host.sessionToken);
    const syncState = await joinRoomSocket(hostSocket, host.room.code);

    expect(syncState.recentMessages).toEqual([]);

    hostSocket.disconnect();
  });

  it('recentMessages is capped at 50 messages (CHAT_HISTORY_LIMIT)', async () => {
    const host = await setupRoom('CapHost');
    const hostSocket = await connectSocket(host.sessionToken);
    await joinRoomSocket(hostSocket, host.room.code);

    // Insert 52 messages via a single batch DB write to avoid 52 × HTTP round-trips
    // over the Neon serverless connection. This tests getRoomChatHistory capping
    // logic, not the send handler.
    const room = await prisma.room.findUnique({ where: { code: host.room.code } });
    expect(room).toBeDefined();
    const user = await prisma.user.findFirst({
      where: { roomParticipants: { some: { roomId: room!.id } } },
    });
    expect(user).toBeDefined();

    const now = Date.now();
    await prisma.chatMessage.createMany({
      data: Array.from({ length: 52 }, (_, i) => ({
        roomId: room!.id,
        userId: user!.id,
        displayName: user!.displayName,
        body: `cap-msg-${i + 1}`,
        // stagger by 1 ms so ORDER BY createdAt is deterministic
        createdAt: new Date(now + i),
      })),
    });

    // Late joiner — should see only the 50 most-recent messages
    const guest = await joinRoomREST(host.room.code, 'CapGuest');
    const guestSocket = await connectSocket(guest.sessionToken);
    const syncState = await joinRoomSocket(guestSocket, host.room.code);

    expect(syncState.recentMessages.length).toBeLessThanOrEqual(50);
    const bodies = syncState.recentMessages.map((m) => m.body);
    // The newest message must be present
    expect(bodies).toContain('cap-msg-52');
    // cap-msg-3 through cap-msg-52 should fit in the 50-message window
    expect(bodies).toContain('cap-msg-3');
    // The two oldest (1 and 2) should be excluded
    expect(bodies).not.toContain('cap-msg-1');
    expect(bodies).not.toContain('cap-msg-2');

    hostSocket.disconnect();
    guestSocket.disconnect();
  });
});

describe('room isolation', () => {
  it('messages from Room A do not appear in Room B sync_state', async () => {
    const roomA = await setupRoom('IsolationHostA');
    const roomB = await setupRoom('IsolationHostB');

    const socketA = await connectSocket(roomA.sessionToken);
    const socketB = await connectSocket(roomB.sessionToken);

    await joinRoomSocket(socketA, roomA.room.code);
    await joinRoomSocket(socketB, roomB.room.code);

    await sendMessage(socketA, 'Only in Room A');

    // New participant joins Room B
    const guest = await joinRoomREST(roomB.room.code, 'IsolationGuest');
    const guestSocket = await connectSocket(guest.sessionToken);
    const syncState = await joinRoomSocket(guestSocket, roomB.room.code);

    const bodies = syncState.recentMessages.map((m) => m.body);
    expect(bodies).not.toContain('Only in Room A');

    socketA.disconnect();
    socketB.disconnect();
    guestSocket.disconnect();
  });

  it('message_received does NOT fire on sockets in a different room', async () => {
    const roomA = await setupRoom('LeakHostA');
    const roomB = await setupRoom('LeakHostB');

    const socketA = await connectSocket(roomA.sessionToken);
    const socketB = await connectSocket(roomB.sessionToken);

    await joinRoomSocket(socketA, roomA.room.code);
    await joinRoomSocket(socketB, roomB.room.code);

    let leaked = false;
    socketB.on('message_received', () => { leaked = true; });

    await sendMessage(socketA, 'Secret message');

    // Wait to ensure no event fires on socketB
    await new Promise((r) => setTimeout(r, 400));
    expect(leaked).toBe(false);

    socketA.disconnect();
    socketB.disconnect();
  });
});
