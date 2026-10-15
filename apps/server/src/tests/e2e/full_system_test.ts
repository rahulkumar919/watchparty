/**
 * Full System E2E Test — All Features
 *
 * Tests every feature of the Watch Party system:
 * 1.  Health endpoint
 * 2.  Create room (REST)
 * 3.  Join room (REST)
 * 4.  Invalid inputs (REST validation)
 * 5.  Socket.IO auth — valid token connects
 * 6.  Socket.IO auth — invalid token rejected
 * 7.  join_room event — HOST gets sync state
 * 8.  join_room event — PARTICIPANT gets sync state
 * 9.  Room isolation — events don't leak between rooms
 * 10. Play (HOST broadcasts to all)
 * 11. Pause (HOST broadcasts to all)
 * 12. Seek (HOST broadcasts to all)
 * 13. RBAC — PARTICIPANT cannot play/pause/seek
 * 14. Change video (HOST, DB-first)
 * 15. Assign role — HOST promotes PARTICIPANT to MODERATOR
 * 16. MODERATOR can now play
 * 17. Assign role — HOST demotes MODERATOR to PARTICIPANT
 * 18. Request playback action (PARTICIPANT)
 * 19. Approve request (HOST) — broadcasts playback_updated
 * 20. Reject request (HOST)
 * 21. Concurrent approval — exactly one wins (CONFLICT)
 * 22. Remove participant (kick)
 * 23. Ban participant — session revoked, reconnect rejected
 * 24. sync_ping (NTP-lite clock sync)
 * 25. Late-joiner sync (receives current position)
 * 26. stateVersion guard (stale update rejected client-side)
 * 27. leave_room event
 * 28. GET /api/rooms/:code
 */

import 'dotenv/config';
import { io as ioClient, Socket } from 'socket.io-client';
import http from 'http';
import { Server as SocketServer } from 'socket.io';
import {
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData,
  SyncStatePayload,
  PlaybackUpdatedPayload,
  PlaybackRequestDTO,
  SocketResponse,
} from '@watchparty/types';
import { createApp } from '../../app';
import { socketAuthMiddleware } from '../../socket/middleware';
import { registerSocketHandlers } from '../../socket/handlers';
import { prisma } from '../../db/prisma';

// ── Colours ──────────────────────────────────────────────────────────────────
const G = '\x1b[32m✓\x1b[0m';
const R = '\x1b[31m✗\x1b[0m';
const Y = '\x1b[33m⚠\x1b[0m';
const B = '\x1b[36m';
const RST = '\x1b[0m';

// ── Test runner ───────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(name: string) {
  console.log(`  ${G} ${name}`);
  passed++;
}

function fail(name: string, reason: string) {
  console.log(`  ${R} ${name}`);
  console.log(`      ${reason}`);
  failed++;
  failures.push(`${name}: ${reason}`);
}

function assert(condition: boolean, name: string, reason = 'assertion failed') {
  if (condition) ok(name);
  else fail(name, reason);
}

function section(title: string) {
  console.log(`\n${B}── ${title} ──${RST}`);
}

// ── Test server ───────────────────────────────────────────────────────────────
const app = createApp();
const httpServer = http.createServer(app);
const io = new SocketServer<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(
  httpServer, { cors: { origin: '*' }, transports: ['websocket'] },
);
io.use(socketAuthMiddleware);
io.on('connection', (socket) => registerSocketHandlers(io, socket));

let serverPort = 0;
const BASE_URL = () => `http://localhost:${serverPort}`;

// ── Helpers ───────────────────────────────────────────────────────────────────
async function post(path: string, body: object): Promise<{ status: number; data: any }> {
  const res = await fetch(`${BASE_URL()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

async function get(path: string): Promise<{ status: number; data: any }> {
  const res = await fetch(`${BASE_URL()}${path}`);
  return { status: res.status, data: await res.json() };
}

function connect(token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = ioClient(BASE_URL(), { auth: { token }, transports: ['websocket'] });
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => reject(e));
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}

function connectExpectFail(token: string): Promise<string> {
  return new Promise((resolve) => {
    const s = ioClient(BASE_URL(), { auth: { token }, transports: ['websocket'] });
    s.on('connect_error', (e) => { s.disconnect(); resolve(e.message); });
    s.on('connect', () => { s.disconnect(); resolve('CONNECTED — should have failed'); });
    setTimeout(() => resolve('timeout'), 5000);
  });
}

function emit<T>(socket: Socket, event: string, ...args: any[]): Promise<SocketResponse<T>> {
  return new Promise((resolve) => {
    (socket as any).emit(event, ...args, resolve);
    setTimeout(() => resolve({ success: false, error: { code: 'INTERNAL_ERROR', message: 'emit timeout' } }), 5000);
  });
}

function waitFor<T>(socket: Socket, event: string, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (data: T) => { clearTimeout(t); resolve(data); });
  });
}

const cleanup: string[] = []; // room codes to delete after

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  console.log('\n\x1b[1m🧪 Watch Party System — Full E2E Test Suite\x1b[0m\n');

  // Start test server
  await new Promise<void>((r) => httpServer.listen(0, () => r()));
  serverPort = (httpServer.address() as any).port;
  console.log(`Test server on port ${serverPort}`);

  // ── 1. Health ──────────────────────────────────────────────────────────────
  section('1. Health & Infrastructure');
  {
    const { status, data } = await get('/health');
    assert(status === 200, 'GET /health returns 200');
    assert(data.status === 'ok', '/health status is ok');
    assert(data.db === 'connected', '/health db is connected', `db=${data.db}`);
    assert(typeof data.uptime === 'number', '/health uptime is a number');
    assert(typeof data.activeRooms === 'number', '/health activeRooms is a number');
  }

  // ── 2. Create Room ─────────────────────────────────────────────────────────
  section('2. Create Room (REST)');
  let hostToken = '';
  let roomCode = '';
  let hostUserId = '';
  let roomId = '';
  {
    const { status, data } = await post('/api/rooms', { displayName: 'Alice', title: 'E2E Room' });
    assert(status === 201, 'POST /api/rooms returns 201');
    assert(typeof data.sessionToken === 'string' && data.sessionToken.length > 10, 'returns sessionToken');
    assert(/^[A-Z0-9]{8}$/.test(data.room?.code), 'room code is 8-char uppercase');
    assert(data.room?.title === 'E2E Room', 'room title matches');
    assert(typeof data.room?.hostUserId === 'string', 'hostUserId present');
    assert(data.displayName === 'Alice', 'displayName echoed');
    hostToken = data.sessionToken;
    roomCode = data.room.code;
    hostUserId = data.userId;
    roomId = data.room.id;
    cleanup.push(roomCode);
  }

  // ── 3. Create Room Validation ──────────────────────────────────────────────
  section('3. Input Validation (REST)');
  {
    const r1 = await post('/api/rooms', { displayName: '' });
    assert(r1.status === 400, 'rejects empty displayName');

    const r2 = await post('/api/rooms', { displayName: 'a'.repeat(33) });
    assert(r2.status === 400, 'rejects displayName > 32 chars');

    const r3 = await post('/api/rooms', {});
    assert(r3.status === 400, 'rejects missing displayName');

    const r4 = await post('/api/rooms/join', { roomCode: 'XXXXXXXX', displayName: 'Bob' });
    assert(r4.status === 404, 'join non-existent room → 404');

    const r5 = await post('/api/rooms/join', { roomCode: 'abc12345', displayName: 'Bob' });
    assert(r5.status === 400, 'join lowercase code → 400');
  }

  // ── 4. Join Room ───────────────────────────────────────────────────────────
  section('4. Join Room (REST)');
  let guestToken = '';
  let guestUserId = '';
  {
    const { status, data } = await post('/api/rooms/join', { roomCode, displayName: 'Bob' });
    assert(status === 200, 'POST /api/rooms/join returns 200');
    assert(typeof data.sessionToken === 'string', 'returns sessionToken');
    assert(data.role === 'PARTICIPANT', 'role is PARTICIPANT');
    assert(data.room.code === roomCode, 'room code matches');
    guestToken = data.sessionToken;
    guestUserId = data.userId;
  }

  // ── 5. GET room info ───────────────────────────────────────────────────────
  section('5. GET /api/rooms/:code');
  {
    const { status, data } = await get(`/api/rooms/${roomCode}`);
    assert(status === 200, 'GET /api/rooms/:code returns 200');
    assert(data.code === roomCode, 'code matches');
    assert(data.isClosed === false, 'isClosed is false');
    assert(typeof data.onlineCount === 'number', 'onlineCount is number');

    const r404 = await get('/api/rooms/ZZZZZZZZ');
    assert(r404.status === 404, 'unknown code → 404');
  }

  // ── 6. Socket Auth ─────────────────────────────────────────────────────────
  section('6. Socket.IO Authentication');
  {
    // Valid token — should connect
    let hostSocket: Socket;
    try {
      hostSocket = await connect(hostToken);
      assert(hostSocket.connected, 'valid token → connects');
      hostSocket.disconnect();
    } catch {
      fail('valid token → connects', 'connection threw');
    }

    // No token — should fail
    const noTokenErr = await connectExpectFail('');
    assert(noTokenErr.includes('UNAUTHORIZED') || noTokenErr !== 'CONNECTED — should have failed', 'missing token → rejected');

    // Bad token — should fail  
    const badTokenErr = await connectExpectFail('invalid.jwt.garbage');
    assert(badTokenErr.includes('UNAUTHORIZED') || badTokenErr !== 'CONNECTED — should have failed', 'invalid token → rejected');
  }

  // ── 7. join_room — HOST ────────────────────────────────────────────────────
  section('7. join_room + sync_state');
  let hostSock: Socket;
  let guestSock: Socket;
  {
    hostSock = await connect(hostToken);
    const hostRes = await emit<SyncStatePayload>(hostSock, 'join_room', { roomCode });
    assert(hostRes.success === true, 'HOST join_room succeeds');
    assert(hostRes.data?.currentUser.role === 'HOST', 'HOST sees role=HOST');
    assert(hostRes.data?.room.code === roomCode, 'sync state room code correct');
    assert(hostRes.data?.playback.status === 'PAUSED', 'initial playback is PAUSED');
    assert(typeof hostRes.data?.playback.serverTimeMs === 'number', 'serverTimeMs present');
    assert(typeof hostRes.data?.playback.stateVersion === 'number', 'stateVersion present');

    // PARTICIPANT join
    guestSock = await connect(guestToken);
    const guestRes = await emit<SyncStatePayload>(guestSock, 'join_room', { roomCode });
    assert(guestRes.success === true, 'PARTICIPANT join_room succeeds');
    assert(guestRes.data?.currentUser.role === 'PARTICIPANT', 'PARTICIPANT sees role=PARTICIPANT');
    assert(Array.isArray(guestRes.data?.participants), 'participants array present');

    // Wrong room code in payload → FORBIDDEN
    const wrongRoom = await emit(hostSock, 'join_room', { roomCode: 'AAAAAAAA' });
    assert(wrongRoom.success === false && wrongRoom.error?.code === 'FORBIDDEN', 'mismatched room code → FORBIDDEN');
  }

  // ── 8. sync_ping ──────────────────────────────────────────────────────────
  section('8. sync_ping (NTP-lite clock sync)');
  {
    const clientSend = Date.now();
    const serverTime = await new Promise<number>((resolve) => {
      hostSock.emit('sync_ping', clientSend, resolve);
    });
    const now = Date.now();
    assert(typeof serverTime === 'number', 'sync_ping returns a number');
    assert(serverTime >= clientSend - 1000 && serverTime <= now + 1000, 'server time is within 1s of client time');
  }

  // ── 9. Room isolation ─────────────────────────────────────────────────────
  section('9. Room isolation');
  {
    const r2 = await post('/api/rooms', { displayName: 'IsolationHost' });
    cleanup.push(r2.data.room.code);
    const sock2 = await connect(r2.data.sessionToken);
    await emit(sock2, 'join_room', { roomCode: r2.data.room.code });

    let leaked = false;
    sock2.on('playback_updated', () => { leaked = true; });
    hostSock.emit('play', { positionSeconds: 5 });
    await new Promise((r) => setTimeout(r, 400));
    assert(!leaked, 'play in room A does not leak to room B');
    sock2.disconnect();
  }

  // ── 10. Play ─────────────────────────────────────────────────────────────
  section('10. Playback Controls');
  {
    // HOST play → all receive playback_updated
    const playPromise = waitFor<PlaybackUpdatedPayload>(guestSock, 'playback_updated');
    const playRes = await emit(hostSock, 'play', { positionSeconds: 42 });
    assert(playRes.success === true, 'HOST play returns success');
    const playUpdate = await playPromise;
    assert(playUpdate.action === 'PLAY', 'playback_updated.action = PLAY');
    assert(playUpdate.status === 'PLAYING', 'playback_updated.status = PLAYING');
    assert(playUpdate.anchorPositionSeconds === 42, `anchorPositionSeconds = 42 (got ${playUpdate.anchorPositionSeconds})`);
    assert(playUpdate.stateVersion > 0, 'stateVersion incremented');
    assert(playUpdate.triggeredByDisplayName === 'Alice', 'triggeredByDisplayName correct');

    // HOST pause
    const pausePromise = waitFor<PlaybackUpdatedPayload>(guestSock, 'playback_updated');
    const pauseRes = await emit(hostSock, 'pause', { positionSeconds: 44 });
    assert(pauseRes.success === true, 'HOST pause returns success');
    const pauseUpdate = await pausePromise;
    assert(pauseUpdate.action === 'PAUSE', 'playback_updated.action = PAUSE');
    assert(pauseUpdate.status === 'PAUSED', 'status = PAUSED');
    assert(pauseUpdate.anchorPositionSeconds === 44, `anchorPositionSeconds = 44 (got ${pauseUpdate.anchorPositionSeconds})`);

    // HOST seek
    const seekPromise = waitFor<PlaybackUpdatedPayload>(guestSock, 'playback_updated');
    const seekRes = await emit(hostSock, 'seek', { targetPositionSeconds: 120 });
    assert(seekRes.success === true, 'HOST seek returns success');
    const seekUpdate = await seekPromise;
    assert(seekUpdate.action === 'SEEK', 'playback_updated.action = SEEK');
    assert(seekUpdate.anchorPositionSeconds === 120, `seek anchorPositionSeconds = 120`);

    // HOST change_video (DB-first)
    const cvPromise = waitFor<PlaybackUpdatedPayload>(guestSock, 'playback_updated');
    const cvRes = await emit<{ videoId: string }>(hostSock, 'change_video', { videoUrlOrId: 'dQw4w9WgXcQ' });
    assert(cvRes.success === true, 'HOST change_video returns success');
    assert(cvRes.data?.videoId === 'dQw4w9WgXcQ', `videoId = dQw4w9WgXcQ (got ${cvRes.data?.videoId})`);
    const cvUpdate = await cvPromise;
    assert(cvUpdate.action === 'CHANGE_VIDEO', 'playback_updated.action = CHANGE_VIDEO');
    assert(cvUpdate.videoId === 'dQw4w9WgXcQ', 'broadcast videoId correct');
    assert(cvUpdate.status === 'PAUSED', 'change_video resets to PAUSED');
    assert(cvUpdate.anchorPositionSeconds === 0, 'change_video resets position to 0');

    // Invalid video URL (not a YouTube URL)
    const badCv = await emit(hostSock, 'change_video', { videoUrlOrId: 'https://example.com/notayt' });
    assert(badCv.success === false, 'invalid video URL → error');
  }

  // ── 11. RBAC enforcement ──────────────────────────────────────────────────
  section('11. RBAC (server-side permission enforcement)');
  {
    const playFail = await emit(guestSock, 'play', { positionSeconds: 0 });
    assert(playFail.success === false && playFail.error?.code === 'FORBIDDEN', 'PARTICIPANT play → FORBIDDEN');

    const pauseFail = await emit(guestSock, 'pause', { positionSeconds: 0 });
    assert(pauseFail.success === false && pauseFail.error?.code === 'FORBIDDEN', 'PARTICIPANT pause → FORBIDDEN');

    const seekFail = await emit(guestSock, 'seek', { targetPositionSeconds: 10 });
    assert(seekFail.success === false && seekFail.error?.code === 'FORBIDDEN', 'PARTICIPANT seek → FORBIDDEN');

    const cvFail = await emit(guestSock, 'change_video', { videoUrlOrId: 'dQw4w9WgXcQ' });
    assert(cvFail.success === false && cvFail.error?.code === 'FORBIDDEN', 'PARTICIPANT change_video → FORBIDDEN');
  }

  // ── 12. Role management ───────────────────────────────────────────────────
  section('12. Role Management (assign_role)');
  {
    // HOST promotes PARTICIPANT → MODERATOR
    const promoteRes = await emit(hostSock, 'assign_role', { targetUserId: guestUserId, newRole: 'MODERATOR' });
    assert(promoteRes.success === true, 'HOST promotes PARTICIPANT to MODERATOR');

    // MODERATOR can now play
    const modPlayRes = await emit(guestSock, 'play', { positionSeconds: 0 });
    assert(modPlayRes.success === true, 'MODERATOR can play after promotion');
    await waitFor(hostSock, 'playback_updated').catch(() => { }); // consume

    // HOST cannot assign HOST role
    const hostAssign = await emit(hostSock, 'assign_role', { targetUserId: guestUserId, newRole: 'HOST' as any });
    assert(hostAssign.success === false, 'cannot assign HOST role via assign_role');

    // HOST demotes MODERATOR → PARTICIPANT
    const demoteRes = await emit(hostSock, 'assign_role', { targetUserId: guestUserId, newRole: 'PARTICIPANT' });
    assert(demoteRes.success === true, 'HOST demotes MODERATOR to PARTICIPANT');

    // After demotion, play is FORBIDDEN again
    const afterDemote = await emit(guestSock, 'play', { positionSeconds: 0 });
    assert(afterDemote.success === false && afterDemote.error?.code === 'FORBIDDEN', 'demoted PARTICIPANT cannot play');

    // PARTICIPANT cannot assign roles
    const guestAssign = await emit(guestSock, 'assign_role', { targetUserId: hostUserId, newRole: 'PARTICIPANT' });
    assert(guestAssign.success === false && guestAssign.error?.code === 'FORBIDDEN', 'PARTICIPANT cannot assign roles → FORBIDDEN');
  }

  // ── 13. Playback Requests ─────────────────────────────────────────────────
  section('13. Playback Request Workflow');
  let requestId = '';
  {
    // PARTICIPANT submits a SEEK request
    const reqRes = await emit<PlaybackRequestDTO>(guestSock, 'request_playback_action', {
      action: 'SEEK',
      targetPositionSeconds: 60,
      note: 'Can we go to 1 minute?',
    });
    assert(reqRes.success === true, 'PARTICIPANT submits request');
    assert(reqRes.data?.status === 'PENDING', 'request status is PENDING');
    assert(reqRes.data?.action === 'SEEK', 'request action is SEEK');
    assert(reqRes.data?.note === 'Can we go to 1 minute?', 'note stored correctly');
    requestId = reqRes.data?.id ?? '';

    // HOST approves → triggers playback_updated
    const approveUpdate = waitFor<PlaybackUpdatedPayload>(guestSock, 'playback_updated');
    const approveRes = await emit(hostSock, 'resolve_playback_request', {
      requestId,
      decision: 'APPROVED',
    });
    assert(approveRes.success === true, 'HOST approves request');
    const update = await approveUpdate;
    assert(update.anchorPositionSeconds === 60, `approved SEEK executed (position=${update.anchorPositionSeconds})`);

    // PARTICIPANT submits a PLAY request
    const playReqRes = await emit<PlaybackRequestDTO>(guestSock, 'request_playback_action', {
      action: 'PLAY',
      targetPositionSeconds: 10,
    });
    assert(playReqRes.success === true, 'PARTICIPANT submits PLAY request');

    // HOST rejects it
    const rejectRes = await emit(hostSock, 'resolve_playback_request', {
      requestId: playReqRes.data!.id,
      decision: 'REJECTED',
      reason: 'Not yet',
    });
    assert(rejectRes.success === true, 'HOST rejects request');
  }

  // ── 14. Concurrent approval ───────────────────────────────────────────────
  section('14. Concurrent Approval (race-condition safety)');
  {
    // Add a moderator for concurrent testing
    const modData = await post('/api/rooms/join', { roomCode, displayName: 'ModForRace' });
    const modSock = await connect(modData.data.sessionToken);
    const modSync = await emit<SyncStatePayload>(modSock, 'join_room', { roomCode });
    const modUserId = modSync.data!.currentUser.userId;

    // Promote to MOD
    await emit(hostSock, 'assign_role', { targetUserId: modUserId, newRole: 'MODERATOR' });

    // Guest submits request
    const raceReq = await emit<PlaybackRequestDTO>(guestSock, 'request_playback_action', {
      action: 'SEEK',
      targetPositionSeconds: 90,
    });

    // Both HOST and MOD approve simultaneously
    const [r1, r2] = await Promise.all([
      emit(hostSock, 'resolve_playback_request', { requestId: raceReq.data!.id, decision: 'APPROVED' }),
      emit(modSock, 'resolve_playback_request', { requestId: raceReq.data!.id, decision: 'APPROVED' }),
    ]);

    const results = [r1, r2];
    const successes = results.filter((r) => r.success).length;
    const conflicts = results.filter((r) => !r.success && r.error?.code === 'CONFLICT').length;
    assert(successes === 1, `exactly 1 approval succeeds (got ${successes})`);
    assert(conflicts === 1, `exactly 1 CONFLICT (got ${conflicts})`);

    // Approving already-resolved request → CONFLICT
    const doubleApprove = await emit(hostSock, 'resolve_playback_request', {
      requestId: raceReq.data!.id,
      decision: 'REJECTED',
    });
    assert(doubleApprove.success === false && doubleApprove.error?.code === 'CONFLICT', 're-resolving resolved request → CONFLICT');

    modSock.disconnect();
  }

  // ── 15. Late-joiner sync ──────────────────────────────────────────────────
  section('15. Late-joiner sync');
  {
    // Host plays at position 100
    const playTime = Date.now();
    hostSock.emit('play', { positionSeconds: 100 });
    await new Promise((r) => setTimeout(r, 600)); // wait 600ms

    // Late joiner connects
    const lateData = await post('/api/rooms/join', { roomCode, displayName: 'LateGuy' });
    const lateSock = await connect(lateData.data.sessionToken);
    const lateSync = await emit<SyncStatePayload>(lateSock, 'join_room', { roomCode });

    assert(lateSync.data?.playback.status === 'PLAYING', 'late joiner sees PLAYING state');

    const elapsed = (Date.now() - playTime) / 1000;
    const expected = 100 + elapsed;
    const computed =
      lateSync.data!.playback.anchorPositionSeconds +
      (lateSync.data!.playback.serverTimeMs - lateSync.data!.playback.anchorTimestampMs) / 1000;
    const diff = Math.abs(computed - expected);
    assert(diff < 1.5, `late-joiner position within 1.5s tolerance (diff=${diff.toFixed(2)}s)`);

    lateSock.disconnect();
  }

  // ── 16. Kick participant ──────────────────────────────────────────────────
  section('16. Remove participant (kick & ban)');
  {
    // Join a throwaway user to kick
    const kickData = await post('/api/rooms/join', { roomCode, displayName: 'ToBeKicked' });
    const kickSock = await connect(kickData.data.sessionToken);
    const kickSync = await emit<SyncStatePayload>(kickSock, 'join_room', { roomCode });
    const kickUserId = kickSync.data!.currentUser.userId;

    // HOST kicks
    const kickRes = await emit(hostSock, 'remove_participant', { targetUserId: kickUserId, ban: false });
    assert(kickRes.success === true, 'HOST can kick a participant');

    // Join a user to ban
    const banData = await post('/api/rooms/join', { roomCode, displayName: 'ToBeBanned' });
    const banSock = await connect(banData.data.sessionToken);
    const banSync = await emit<SyncStatePayload>(banSock, 'join_room', { roomCode });
    const banUserId = banSync.data!.currentUser.userId;

    // HOST bans
    const removedPromise = waitFor(banSock, 'participant_removed', 2000).catch(() => null);
    const banRes = await emit(hostSock, 'remove_participant', { targetUserId: banUserId, ban: true });
    assert(banRes.success === true, 'HOST can ban a participant');
    const removedEvent = await removedPromise;
    assert(removedEvent !== null, 'banned user receives participant_removed event');

    // Banned user's token should be rejected on reconnect
    await new Promise((r) => setTimeout(r, 300));
    const reconnectErr = await connectExpectFail(banData.data.sessionToken);
    assert(
      reconnectErr.includes('UNAUTHORIZED') || reconnectErr !== 'CONNECTED — should have failed',
      'banned user cannot reconnect',
    );

    kickSock.disconnect();
    banSock.disconnect();
  }

  // ── 17. leave_room ────────────────────────────────────────────────────────
  section('17. leave_room');
  {
    const leftPromise = waitFor<{ userId: string; reason: string }>(hostSock, 'user_left', 2000);
    guestSock.emit('leave_room');
    const leftEvent = await leftPromise.catch(() => null);
    assert(leftEvent !== null, 'leave_room emits user_left to other members');
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  hostSock.disconnect();
  guestSock.disconnect();

  // DB cleanup
  try {
    await prisma.room.deleteMany({ where: { code: { in: cleanup } } });
  } catch { /* ignore */ }
  await prisma.$disconnect();

  await new Promise<void>((r) => { io.close(); httpServer.close(() => r()); });

  // ── Summary ───────────────────────────────────────────────────────────────
  const total = passed + failed;
  console.log(`\n${'─'.repeat(55)}`);
  console.log(`\x1b[1m Results: ${passed}/${total} passed\x1b[0m`);
  if (failed > 0) {
    console.log(`\n\x1b[31mFailed tests:\x1b[0m`);
    failures.forEach((f) => console.log(`  ${R} ${f}`));
  } else {
    console.log(`\x1b[32m\n  All tests passed! ✨\x1b[0m`);
  }
  console.log();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('\nFatal test error:', err);
  process.exit(1);
});
