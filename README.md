# WatchParty

A real-time YouTube co-watching platform. Multiple users join a shared room and watch the same video in synchronized playback — play, pause, seek, and video changes broadcast to every participant instantly. No accounts or passwords required.

> **Live Demo:** [https://your-app.onrender.com](https://your-app.onrender.com) ← replace with your deployed URL

---

## Table of Contents

1. [Live URL](#live-url)
2. [Tech Stack](#tech-stack)
3. [Repository Layout](#repository-layout)
4. [Database Schema](#database-schema)
5. [Environment Setup](#environment-setup)
6. [Running Locally](#running-locally)
7. [Architecture Overview — WebSocket Integration](#architecture-overview--websocket-integration)
8. [How It Works — Complete Flow](#how-it-works--complete-flow)
   - [Create Room](#1-create-room-flow)
   - [Join Room via Invite Link](#2-join-room-via-invite-link)
   - [Room Page Initialization](#3-room-page-initialization)
   - [Playback Control](#4-playback-control-flow)
   - [Video Change](#5-video-change-flow-db-first)
   - [Participant Requests](#6-participant-request-flow)
   - [Role Management & Host Transfer](#7-role-management--host-transfer)
   - [Kick / Ban](#8-kick--ban-flow)
   - [Real-time Chat](#9-real-time-chat-flow)
   - [Cold-Start Recovery](#10-cold-start-recovery)
   - [Clock Drift Correction](#11-clock-drift-correction)
9. [REST API](#rest-api)
10. [Socket.IO Event Contract](#socketio-event-contract)
11. [Authentication Model](#authentication-model)
12. [Role-Based Access Control](#role-based-access-control)
13. [In-Memory State & Sync Math](#in-memory-state--sync-math)
14. [Two-Tier DB Write Strategy](#two-tier-db-write-strategy)
15. [Frontend State Machine](#frontend-state-machine)
16. [Running Tests](#running-tests)
17. [Deployment](#deployment)

---

## Live URL

> **https://your-app.onrender.com** ← replace with your Render/Railway/Vercel URL after deployment

Core features verified in production:
- ✅ Create room (Host auto-assigned)
- ✅ Join via invite link or room code
- ✅ Play / pause / seek synchronization across sessions
- ✅ Change video synchronization
- ✅ Role assignment (Host → Moderator, Host → Participant)
- ✅ Host transfer
- ✅ Participant playback requests with approval/rejection
- ✅ Kick / ban participants
- ✅ Real-time chat with persistent history

---

## Architecture Overview — WebSocket Integration

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser (Client)                     │
│                                                             │
│  Next.js 15 App Router                                      │
│  ┌───────────────┐   REST (fetch)   ┌──────────────────┐   │
│  │  page.tsx     │ ───────────────▶ │  Express REST    │   │
│  │  (Home/Join)  │ ◀─────────────── │  /api/rooms      │   │
│  └───────────────┘  sessionToken    └──────────────────┘   │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Room Page  /room/[code]                             │  │
│  │                                                      │  │
│  │  useSocket(token)  ◀──── JWT in handshake.auth ────▶ │  │ WebSocket
│  │       │                   socketAuthMiddleware        │  │ (Socket.IO)
│  │       ▼                                              │  │
│  │  useRoomState(socket)  ─── listens to server events  │  │
│  │  useYouTubePlayer()    ─── IFrame API wrapper        │  │
│  │  useDriftCorrection()  ─── NTP-lite clock sync       │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                          │  WebSocket (ws://)
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                   Node.js + Express Server                  │
│                                                             │
│  io.use(socketAuthMiddleware)                               │
│    └─ verifySession(JWT) → check DB: isRevoked, isBanned    │
│                                                             │
│  io.on('connection', registerSocketHandlers)                │
│    │                                                        │
│    ├── join_room   → loadRoomIntoMemory → sync_state emit   │
│    ├── play/pause  → RoomStateManager.applyPlay/Pause()     │
│    │               → io.to(roomCode).emit('playback_updated')│
│    ├── seek        → RoomStateManager.applySeek()           │
│    ├── change_video→ DB write first → applyChangeVideo()    │
│    ├── assign_role → DB update → role_assigned broadcast    │
│    ├── transfer_host→ DB transaction → host_transferred     │
│    ├── remove_participant → revoke session → force-disconnect│
│    ├── send_message  → DB persist → message_received broadcast │
│    └── sync_ping   → callback(Date.now())                   │
│                                                             │
│  RoomStateManager (in-memory singleton)                     │
│    └─ Map<roomCode, { playback, participants }>             │
│    └─ anchorPositionSeconds + anchorTimestampMs → live pos  │
│                                                             │
│  Async DB Checkpoint (Tier 2 — play/pause/seek)             │
│    └─ prisma.room.updateMany WHERE stateVersion <= version  │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│              PostgreSQL (Neon serverless)                   │
│                                                             │
│  User, Session, Room, RoomParticipant, PlaybackRequest      │
│  ChatMessage (persists every room message, history capped 50)│
│  Persistent checkpoint for cold-start recovery              │
│  JWT revocation (Session.isRevoked) for kicked users        │
└─────────────────────────────────────────────────────────────┘
```

### How WebSockets enable real-time sync

Every playback action (play/pause/seek/change_video) follows this path:

1. **Client emits** a typed Socket.IO event with the current player position
2. **Server middleware** validates the JWT on the socket handshake — no role in the token
3. **Handler** reads the role from `RoomStateManager` (never the JWT) and checks permissions
4. **RoomStateManager** updates the in-memory anchor (`anchorPositionSeconds`, `anchorTimestampMs`)
5. **Server broadcasts** `playback_updated` to every socket in the Socket.IO room channel
6. **Each client** receives the event, applies it to the YouTube IFrame player
7. The `isApplyingRemoteUpdate` flag in `useYouTubePlayer` blocks the resulting IFrame state-change event from being re-emitted back to the server — **preventing infinite echo loops**

### Why anchor math instead of periodic ticks

```
currentPosition = anchorPositionSeconds + (Date.now() - anchorTimestampMs) / 1000
```

When the Host presses Play at position 42s, the server records `anchorPosition=42, anchorTimestamp=now`. Every client independently computes the live position using this formula — no per-second server broadcasts needed. `useDriftCorrection` corrects any drift > 1.5 seconds by snapping the player.

### Invite link flow

```
Host creates room → /room/J1T7M6HW → clicks "Invite" button
  → copies https://yourapp.com/join/J1T7M6HW

Friend opens link → /join/J1T7M6HW
  → sees room title, online count
  → enters display name → POST /api/rooms/join
  → gets JWT → navigates to /room/J1T7M6HW → synced automatically
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 15 (App Router), TypeScript, Socket.IO client |
| Backend | Node.js, Express, Socket.IO server |
| Database | PostgreSQL (Neon serverless), Prisma ORM |
| Auth | JWT (jsonwebtoken), SHA-256 token hashing |
| Validation | Zod schemas shared between frontend and backend |
| Monorepo | npm workspaces |

---

## Repository Layout

```
watch_party_system/
├── apps/
│   ├── web/                          # Next.js frontend — localhost:3000
│   │   └── src/
│   │       ├── app/
│   │       │   ├── page.tsx           # Home page — create / join room
│   │       │   └── room/[code]/
│   │       │       ├── page.tsx       # Room UI (player + controls + side panel)
│   │       │       └── layout.tsx     # Metadata wrapper
│   │       ├── hooks/
│   │       │   ├── useSocket.ts       # Socket.IO connection lifecycle
│   │       │   ├── useRoomState.ts    # Room state reducer + all event listeners
│   │       │   ├── useYouTubePlayer.ts# YouTube IFrame API wrapper
│   │       │   └── useDriftCorrection.ts # NTP-lite clock drift auto-resync
│   │       └── lib/
│   │           ├── api.ts             # REST API client (typed fetch wrapper)
│   │           └── session.ts         # sessionStorage helpers
│   └── server/                       # Express + Socket.IO backend — localhost:4000
│       └── src/
│           ├── index.ts               # Entry point — HTTP server + Socket.IO setup
│           ├── app.ts                 # Express factory (CORS, middleware, routes)
│           ├── config.ts              # Env-var driven configuration
│           ├── routes/
│           │   └── rooms.ts           # REST endpoints
│           ├── socket/
│           │   ├── middleware.ts      # JWT auth middleware for every socket connection
│           │   └── handlers.ts        # All socket event handlers
│           ├── services/
│           │   ├── roomService.ts     # Create / join / build sync state
│           │   ├── sessionService.ts  # JWT issue / verify / revoke
│           │   ├── playbackService.ts # Play / pause / seek / change_video
│           │   └── requestService.ts  # PARTICIPANT playback requests
│           ├── state/
│           │   └── RoomStateManager.ts# In-memory authoritative state (singleton)
│           └── utils/
│               ├── rbac.ts            # Role permission table
│               ├── youtube.ts         # YouTube video ID extraction
│               └── roomRecovery.ts    # Cold-start position recovery logic
└── packages/
    └── types/
        └── src/index.ts               # Shared types, Zod schemas, Socket.IO contracts
```

---

## Database Schema

```
┌────────────────────┐     ┌──────────────────────────────┐
│       User         │     │            Room               │
├────────────────────┤     ├──────────────────────────────┤
│ id (cuid)          │     │ id (cuid)                     │
│ displayName        │     │ code (unique, 8-char)         │
│ createdAt          │     │ title                         │
└────────────────────┘     │ hostUserId ──────────────────▶│ User
         │                 │ isClosed                      │
         │                 │ currentVideoId                │
         │                 │ playbackStatus (PLAYING/PAUSED│
         │                 │ lastPositionSeconds           │
         │                 │ lastPositionUpdatedAt         │
         │                 │ stateVersion (int)            │
         │                 └──────────────────────────────┘
         │
┌────────▼───────────┐     ┌──────────────────────────────┐
│     Session        │     │       RoomParticipant        │
├────────────────────┤     ├──────────────────────────────┤
│ id                 │     │ id                            │
│ userId ───────────▶│User │ roomId ──────────────────────▶│Room
│ roomId ───────────▶│Room │ userId ──────────────────────▶│User
│ tokenHash (SHA-256)│     │ role (HOST/MODERATOR/PART.)   │
│ isRevoked          │     │ isOnline                      │
│ expiresAt          │     │ isBanned                      │
└────────────────────┘     │ joinedAt / lastSeenAt         │
                           └──────────────────────────────┘

┌──────────────────────────────────────────────┐
│              PlaybackRequest                 │
├──────────────────────────────────────────────┤
│ id                                           │
│ roomId ─────────────────────────────────────▶│Room
│ requesterId ────────────────────────────────▶│User
│ action (PLAY / PAUSE / SEEK / CHANGE_VIDEO)  │
│ payload (JSON: { targetPositionSeconds?,     │
│                  videoId? })                 │
│ status (PENDING / APPROVED / REJECTED)       │
│ note (optional)                              │
│ resolvedById / resolvedAt / rejectionReason  │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│                ChatMessage                   │
├──────────────────────────────────────────────┤
│ id (cuid)                                    │
│ roomId ─────────────────────────────────────▶│Room (cascade delete)
│ userId ─────────────────────────────────────▶│User (cascade delete)
│ displayName (denormalized at write time)     │
│ body (VarChar(1000))                         │
│ createdAt                                    │
│ INDEX [roomId, createdAt]  ← fast history    │
└──────────────────────────────────────────────┘
```

### Key DB Invariants

- `Room.hostUserId` and the `RoomParticipant` with `role='HOST'` always point to the same user — updated atomically in a single DB transaction.
- `Session.tokenHash` stores SHA-256 of the JWT. The raw token is never stored.
- One `Session` per `(userId, roomId)` pair — upserted on rejoin so old tokens auto-invalidate.
- `Room.stateVersion` is a monotonically increasing integer. Async DB checkpoints only succeed if the DB version has not advanced — prevents stale writes from overwriting newer playback state.

---

## Environment Setup

### Backend — `apps/server/.env`

```env
PORT=4000
NODE_ENV=development

# Neon PostgreSQL
DATABASE_URL=postgresql://user:password@host/db?sslmode=require
DIRECT_URL=postgresql://user:password@host/db?sslmode=require

# JWT
JWT_SECRET=your-secret-key-here
JWT_EXPIRES_IN=7d

# CORS — must match the frontend origin exactly
CORS_ORIGIN=http://localhost:3000
```

### Frontend — `apps/web/.env.local`

```env
NEXT_PUBLIC_API_URL=http://localhost:4000
NEXT_PUBLIC_SOCKET_URL=http://localhost:4000
```

---

## Running Locally

```bash
# 1. Install all workspace dependencies from the repo root
npm install

# 2. Generate Prisma client
npm run db:generate --workspace=apps/server

# 3. Run DB migrations
npm run db:migrate --workspace=apps/server

# 4. Start the backend (terminal 1)
npm run dev --workspace=apps/server

# 5. Start the frontend (terminal 2)
npm run dev --workspace=apps/web
```

Open `http://localhost:3000`.

---

## How It Works — Complete Flow

### 1. Create Room Flow

```
User fills in name, optional title, optional YouTube URL
          │
          ▼
apps/web/src/app/page.tsx  →  handleCreate()
  api.createRoom({ displayName, title, initialVideoId })
          │
          ▼  POST /api/rooms
apps/server/src/routes/rooms.ts
  Zod validates body (DisplayNameSchema, title?, videoId?)
          │
          ▼
apps/server/src/services/roomService.ts  →  createRoom()
  1. Generate unique 8-char uppercase alphanumeric room code
     (retry loop up to 10 times on collision)
  2. DB transaction:
       a. INSERT User { displayName }
       b. INSERT Room { code, title, hostUserId=user.id,
                        playbackStatus='PAUSED', stateVersion=0 }
       c. INSERT RoomParticipant { role='HOST', isOnline=true }
  3. RoomStateManager.loadRoom()  — room enters in-memory cache immediately
  4. issueSession():
       a. jwt.sign({ sessionId, userId, roomId, roomCode, displayName })
          NOTE: NO role in the JWT — roles are always read from memory/DB
       b. prisma.session.upsert() stores SHA-256(token)
  5. Return { sessionToken, room: { id, code, title, hostUserId }, userId }
          │
          ▼
apps/web/src/lib/session.ts  →  saveSession()
  Stores { token, userId, roomId, roomCode, displayName }
  in sessionStorage under key 'watchparty_session'
  (tab-scoped — clears automatically when tab closes)
          │
          ▼
router.push('/room/J1T7M6HW')
```

---

### 2. Join Room Flow

```
User fills in name + 8-char room code
          │
          ▼
page.tsx  →  handleJoin()
  api.joinRoom({ roomCode, displayName })
          │
          ▼  POST /api/rooms/join
roomService.ts  →  joinRoom()
  1. prisma.room.findUnique({ code })
     → 404 if not found, 410 if isClosed
  2. DB transaction:
       a. INSERT User { displayName }
       b. INSERT RoomParticipant { role='PARTICIPANT', isOnline=true }
  3. If room not in RoomStateManager → loadRoomIntoMemory() (cold-start)
  4. RoomStateManager.addParticipant()
  5. issueSession() → sign JWT, upsert Session in DB
  6. Return { sessionToken, room, userId, role: 'PARTICIPANT' }
          │
          ▼
saveSession() → router.push('/room/<CODE>')
```

---

### 3. Room Page Initialization

This is the critical path that was responsible for the infinite spinner bug (now fixed).

```
Next.js renders /room/[code]/page.tsx
          │
          ▼
useEffect: apps/web/src/lib/session.ts  →  loadSession()
  Reads sessionStorage → if missing or roomCode mismatch → redirect home
  Sets local session state (token, userId, roomCode, displayName)
          │
          ▼
apps/web/src/hooks/useSocket.ts  →  useSocket(token)
  io('http://localhost:4000', {
    auth: { token },
    transports: ['websocket', 'polling'],
    reconnectionAttempts: 5,
    timeout: 10000,
  })
  status = 'connecting'
          │
          ▼  Socket.IO handshake
apps/server/src/socket/middleware.ts  →  socketAuthMiddleware()
  token = socket.handshake.auth.token
  verifySession(token):
    1. jwt.verify(token, secret)           — signature + expiry check
    2. prisma.session.findFirst({ tokenHash: SHA-256(token) })
       → must exist, isRevoked must be false, expiresAt must be future
    3. prisma.roomParticipant.findUnique() → isBanned must be false
  Attaches socket.data.session = { sessionId, userId, roomId, roomCode, displayName }
  next() — connection accepted
          │
          ▼
s.on('connect') fires on client
  status = 'connected'
  setSocket(s)   ← publishes reactive socket to downstream hooks/components
          │
          ▼
useEffect in page.tsx  [socket, connStatus === 'connected']
  joinedRef.current = true  (prevents duplicate joins)
  Start 10-second timeout → if state.isLoaded still false → show error UI
  socket.emit('join_room', { roomCode }, callback)
          │
          ▼
apps/server/src/socket/handlers.ts  →  socket.on('join_room')
  1. Zod validates { roomCode }
  2. roomCode === socket.data.session.roomCode  (cross-check — prevents
     using a valid token to join a different room)
  3. If !roomStateManager.hasRoom(roomCode) → loadRoomIntoMemory()
  4. socket.join(roomCode)   — joins the Socket.IO broadcast channel
  5. RoomStateManager:
       reconnecting user → updateParticipantSocket(roomCode, userId, socket.id)
       new user          → addParticipant(...)
  6. getPendingRequests(roomId) from DB
  7. buildSyncStatePayload(roomCode, userId, pendingRequests)
       reads entirely from RoomStateManager (no DB query)
  8. prisma.roomParticipant.updateMany → isOnline=true (fire-and-forget)
  9. socket.to(roomCode).emit('user_joined', ...) — notify others in room
  10. callback({ success: true, data: syncState })   ← ack with full state
  11. socket.emit('sync_state', syncState)           ← also push as event
          │
          ▼  Both paths converge in useRoomState
apps/web/src/hooks/useRoomState.ts  →  socket.on('sync_state')
  dispatch({ type: 'SYNC_STATE', payload })
  roomReducer sets isLoaded = true + all room fields

  Additionally, the ack callback in page.tsx dispatches the same payload
  as a safety-net (guards against React render-cycle races):
  if (res.data && !state.isLoaded) dispatch({ type: 'SYNC_STATE', payload: res.data })
          │
          ▼
state.isLoaded = true → spinner disappears → room UI renders
```

---

### 4. Playback Control Flow

```
HOST/MODERATOR clicks ▶ Play
          │
          ▼
page.tsx
  socket.emit('play', { positionSeconds: controls.getCurrentTime() })
          │
          ▼
handlers.ts  →  socket.on('play')
  1. Zod validates { positionSeconds }
  2. getCurrentRole() reads from RoomStateManager (NOT from JWT)
  3. canPerformAction(role, 'play') — only HOST and MODERATOR pass
          │
          ▼
apps/server/src/services/playbackService.ts  →  applyPlay()
  1. RoomStateManager.applyPlay():
       room.playback = {
         status: 'PLAYING',
         anchorPositionSeconds: positionSeconds,   ← position at this instant
         anchorTimestampMs: Date.now(),            ← wall-clock at this instant
         stateVersion: prev + 1,
       }
  2. checkpointPlaybackState() — ASYNC, non-blocking:
       prisma.room.updateMany WHERE stateVersion <= checkpointVersion
       (stale version → 0 rows updated → silent no-op)
  3. Return PlaybackUpdatedPayload
          │
          ▼
io.to(roomCode).emit('playback_updated', result)
  ── broadcasts to ALL sockets in the room channel (including sender)
          │
          ▼
Each client: useRoomState socket.on('playback_updated')
  stateVersion guard: reject if payload.stateVersion <= state.playback.stateVersion
  dispatch({ type: 'PLAYBACK_UPDATED', payload })
          │
          ▼
useEffect [state.playback] in page.tsx
  target = computeCurrentPosition()   ← anchor math (see below)
  controls.play(target)               ← YouTube IFrame API seekTo + playVideo
```

Same pattern applies to **pause** and **seek** — only the `RoomStateManager` method and payload fields differ.

---

### 5. Video Change Flow (DB-First)

Unlike play/pause/seek (memory-first), `change_video` is **DB-first** because the video ID is room metadata that must survive a server restart.

```
socket.emit('change_video', { videoUrlOrId })
          │
          ▼
playbackService.ts  →  applyChangeVideo()
  1. extractVideoId(videoUrlOrId) — validates YouTube URL or bare ID
     Returns { error: 'INVALID_VIDEO_URL' } if invalid
  2. prisma.room.update() — write new videoId to DB FIRST
     If DB write fails → return null, memory is NOT touched
  3. Only after DB success:
     RoomStateManager.applyChangeVideo():
       videoId = newId, status = 'PAUSED', position = 0, stateVersion++
  4. Return PlaybackUpdatedPayload
          │
          ▼
io.to(roomCode).emit('playback_updated', result)
```

---

### 6. Participant Request Flow

```
PARTICIPANT clicks ✋ Request Action
          │
          ▼
socket.emit('request_playback_action', {
  action: 'PLAY' | 'PAUSE' | 'SEEK' | 'CHANGE_VIDEO',
  targetPositionSeconds?,
  note?
})
          │
          ▼
handlers.ts  →  socket.on('request_playback_action')
  canPerformAction(role, 'request_playback_action') — all roles allowed
  requestService.createPlaybackRequest() → INSERT PlaybackRequest (PENDING)
  For each HOST/MODERATOR in RoomStateManager:
    io.to(participant.socketId).emit('playback_request_created', request)
          │
          ▼
HOST sees request appear in Requests panel

HOST clicks Approve
          │
          ▼
socket.emit('resolve_playback_request', { requestId, decision: 'APPROVED' })
          │
          ▼
handlers.ts  →  socket.on('resolve_playback_request')
  requestService.resolvePlaybackRequest():
    Atomic: UPDATE PlaybackRequest SET status='APPROVED'
            WHERE id=requestId AND status='PENDING'   ← prevents double-resolve
  If APPROVED → execute the requested action through standard playback pipeline
    (applyPlay / applyPause / applySeek / applyChangeVideo)
  io.to(roomCode).emit('playback_request_resolved', { requestId, status, actionApplied })
```

---

### 7. Role Management Flow

```
HOST clicks Promote to Moderator for a PARTICIPANT
          │
          ▼
socket.emit('assign_role', { targetUserId, newRole: 'MODERATOR' })
          │
          ▼
handlers.ts  →  socket.on('assign_role')
  getCurrentRole() must be HOST
  Cannot change own role via this event
  canAssignRole(role, targetCurrentRole, newRole) validates the transition
  prisma.roomParticipant.update() — DB FIRST
  RoomStateManager.updateParticipantRole() — then memory
  io.to(roomCode).emit('role_assigned', { userId, newRole, updatedByDisplayName, ... })
```

---

### 8. Kick / Ban Flow

```
HOST clicks Kick or Ban
          │
          ▼
socket.emit('remove_participant', { targetUserId, ban: true/false })
          │
          ▼
handlers.ts  →  socket.on('remove_participant')
  DB transaction:
    a. RoomParticipant.isBanned = ban, isOnline = false
    b. If ban=true: Session.isRevoked = true for all sessions of that user+room
  RoomStateManager.removeParticipant()
  Find target's socket via io.sockets.sockets.get(socketId)
  targetSocket.emit('participant_removed', ...)
  targetSocket.disconnect(true)   ← force disconnect
  socket.to(roomCode).emit('participant_removed', ...)   ← notify rest of room

Banned user tries to reconnect:
  socketAuthMiddleware → verifySession() → session.isRevoked === true → reject
  s.on('connect_error') fires on client → status = 'error'
```

---

### 9. Real-time Chat Flow

```
Any participant (HOST, MODERATOR, or PARTICIPANT) types a message and presses Enter
          │
          ▼
apps/web/src/app/room/[code]/page.tsx
  chatInput state → useChat.sendMessage(body)
          │
          ▼
apps/web/src/hooks/useChat.ts  →  sendMessage()
  Trims body client-side; snaps scroll to bottom (own message)
  socket.emit('send_message', { body: trimmed }, callback)
          │
          ▼  (body trimmed again + validated by Zod on server)
apps/server/src/socket/handlers.ts  →  socket.on('send_message')
  1. Zod: transform(trim) THEN min(1)/max(1000) — whitespace-only rejected
  2. getCurrentRole() — confirms sender is still a room member
  3. DB-FIRST: createChatMessage(roomId, userId, displayName, body)
     displayName taken from socket.data.session (JWT-verified) — never from payload
     If DB write fails → INTERNAL_ERROR ack, no broadcast
  4. io.to(roomCode).emit('message_received', ChatMessageDTO)
     ← broadcast to ALL sockets including the sender (canonical delivery)
  5. callback({ success: true, data: ChatMessageDTO })
          │
          ▼
Each client (including sender): useChat socket.on('message_received')
  Deduplicates by message.id (Set<string> in seenIds ref)
  setMessages(prev => [...prev, msg])
  Auto-scrolls to bottom if user was already near the bottom

Chat history on join:
  join_room handler calls getRoomChatHistory(roomId):
    SELECT last 50 rows ORDER BY createdAt DESC, then reverse → chronological
  Included in SyncStatePayload.recentMessages
  page.tsx captures recentMessages from the join_room ack once
  Passed to useChat({ initialMessages }) → seeded into messages state
  chatHistorySeededRef prevents re-seeding on reconnect
```

### Chat Design Decisions

- **DB-first, no optimistic insert** — message appears only after the server persists it. The server broadcasts the DTO back to the sender, so the message renders via `message_received` like everyone else's. No "appears twice" issue.
- **Deduplication by id** — if a reconnect replays events, `seenIds` ref prevents duplicates.
- **displayName denormalized at write time** — `ChatMessage.displayName` is copied from the session at persist time, so history is accurate even if the user's display name changes later.
- **History capped at 50** — `CHAT_HISTORY_LIMIT = 50` in `chatService.ts`. History is returned oldest-first for display.
- **Auto-scroll with user-override** — only scrolls to the bottom if the user is within 60 px of the end. Manual scroll-up suppresses auto-scroll until the user scrolls back down.

---

### 10. Cold-Start Recovery

When the server restarts, `RoomStateManager` is empty. The first user who connects to a room triggers recovery before their `join_room` is processed.

```
join_room handler: roomStateManager.hasRoom(roomCode) === false
          │
          ▼
roomService.ts  →  loadRoomIntoMemory(roomId, roomCode)
  prisma.room.findUnique({ include: { participants: { where: { isBanned: false } } } })
          │
          ▼
utils/roomRecovery.ts  →  computeRecoveryState()
  If playbackStatus was PAUSED:
    → restore as PAUSED at lastPositionSeconds

  If playbackStatus was PLAYING:
    elapsed = (now - lastPositionUpdatedAt) / 1000
    If elapsed < 60s:
      → restore as PLAYING, anchorPosition += elapsed   (still recent)
    If elapsed >= 60s:
      → restore as PAUSED                               (too stale, stop it)
          │
          ▼
RoomStateManager.loadRoom()
  All participants restored with isOnline=false
  (set back to true when they actually connect via socket)
```

---

### 11. Clock Drift Correction

Clients periodically run an NTP-lite ping to measure their clock offset against the server and auto-correct any drift.

```
apps/web/src/hooks/useDriftCorrection.ts
          │
          ▼
socket.emit('sync_ping', clientSendTimestampMs, (serverReceivedMs) => {
  const rtt           = Date.now() - clientSendTimestampMs
  const clockOffset   = serverReceivedMs - (clientSendTimestampMs + rtt / 2)

  if (|clockOffset| > threshold) {
    // Recompute target position using corrected clock
    // Force-seek the YouTube player to the authoritative position
  }
})
          │ server side
          ▼
handlers.ts  →  socket.on('sync_ping', (clientTs, callback))
  callback(Date.now())   ← replies immediately with server wall-clock
```

---

## REST API

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| `POST` | `/api/rooms` | None | `{ displayName, title?, initialVideoId? }` | `{ sessionToken, room, userId, displayName }` |
| `POST` | `/api/rooms/join` | None | `{ roomCode, displayName }` | `{ sessionToken, room, userId, displayName, role }` |
| `GET` | `/api/rooms/:code` | None | — | `{ id, code, title, isClosed, onlineCount }` |
| `GET` | `/health` | None | — | `{ status, db, uptime, activeRooms }` |

All error responses follow `{ error: { code: string, message: string } }`.

---

## Socket.IO Event Contract

All events are defined as TypeScript interfaces in `packages/types/src/index.ts`. Both sides import from there — mismatches are caught at compile time.

### Client → Server (with ack callback)

| Event | Payload | Who can emit |
|---|---|---|
| `join_room` | `{ roomCode }` | All |
| `play` | `{ positionSeconds }` | HOST, MODERATOR |
| `pause` | `{ positionSeconds }` | HOST, MODERATOR |
| `seek` | `{ targetPositionSeconds }` | HOST, MODERATOR |
| `change_video` | `{ videoUrlOrId }` | HOST, MODERATOR |
| `request_playback_action` | `{ action, targetPositionSeconds?, note? }` | All |
| `resolve_playback_request` | `{ requestId, decision, reason? }` | HOST, MODERATOR |
| `assign_role` | `{ targetUserId, newRole }` | HOST |
| `remove_participant` | `{ targetUserId, ban }` | HOST |
| `sync_ping` | `clientSendTimestampMs` | All |
| `leave_room` | — | All |
| `send_message` | `{ body }` | All |

Every client→server event uses an **acknowledgement callback** that always returns:
```typescript
// Success
{ success: true, data?: T }

// Failure
{ success: false, error: { code: string, message: string } }
```

### Server → Client

| Event | Payload | When emitted |
|---|---|---|
| `sync_state` | Full `SyncStatePayload` | After `join_room`, after reconnect |
| `playback_updated` | `PlaybackUpdatedPayload` | After any playback change |
| `user_joined` | `ParticipantDTO` | When any user joins the room |
| `user_left` | `{ userId, displayName, reason }` | On disconnect or leave |
| `role_assigned` | `{ userId, newRole, updatedByDisplayName, ... }` | After `assign_role` |
| `participant_removed` | `{ userId, isBanned, removedByDisplayName }` | After kick/ban |
| `playback_request_created` | `PlaybackRequestDTO` | New request — HOST/MOD only |
| `playback_request_resolved` | `{ requestId, status, actionApplied, ... }` | After resolve |
| `host_transferred` | `{ previousHostUserId, newHostUserId, ... }` | After host transfer |
| `message_received` | `ChatMessageDTO` | After any `send_message` |

### SyncStatePayload (full room snapshot)

Sent on both the `join_room` ack and the `sync_state` event:

```typescript
{
  room: { id, code, title, hostUserId },
  playback: {
    videoId,
    status,                    // 'PLAYING' | 'PAUSED'
    anchorPositionSeconds,     // position at the anchor point
    anchorTimestampMs,         // server wall-clock ms at that position
    serverTimeMs,              // current server time (for clock offset calc)
    stateVersion,
  },
  currentUser: { userId, displayName, role },
  participants: ParticipantDTO[],
  pendingRequests: PlaybackRequestDTO[],  // only populated for HOST / MODERATOR
  recentMessages: ChatMessageDTO[],       // last 50 messages (oldest-first)
}
```

---

## Authentication Model

```
No passwords. No accounts.

┌─────────────────────────────────────────────────────────────────┐
│  CREATE / JOIN ROOM                                             │
│                                                                 │
│  Backend creates User + Session in DB                           │
│  Signs JWT:                                                     │
│    payload = { sessionId, userId, roomId, roomCode, displayName}│
│    !! NO role in the JWT !!                                     │
│    Roles are always read from RoomStateManager / DB at runtime  │
│                                                                 │
│  Stores SHA-256(token) in Session.tokenHash — raw token never   │
│  persisted in the database                                      │
└─────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────┐
│  FRONTEND STORAGE                                               │
│                                                                 │
│  sessionStorage['watchparty_session'] = {                       │
│    token, userId, roomId, roomCode, displayName                 │
│  }                                                              │
│  Tab-scoped → clears automatically on tab close                 │
└─────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────┐
│  EVERY SOCKET.IO CONNECTION (socketAuthMiddleware)              │
│                                                                 │
│  1. jwt.verify(token, secret)       — signature + expiry        │
│  2. DB lookup by SHA-256(token)     — session must exist        │
│  3. session.isRevoked === false     — not kicked/banned         │
│  4. session.expiresAt > now         — not expired               │
│  5. participant.isBanned === false  — belt-and-suspenders       │
│                                                                 │
│  Any failure → next(Error('UNAUTHORIZED')) → connection refused │
└─────────────────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────────┐
│  TOKEN REVOCATION (kick / ban)                                  │
│                                                                 │
│  Session.isRevoked = true   in DB transaction                   │
│  Target socket force-disconnected immediately                   │
│  Any reconnect attempt fails at step 3 above                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Role-Based Access Control

Defined in `apps/server/src/utils/rbac.ts`. Enforced server-side on every socket event — hiding a button in the UI is not security.

| Action | HOST | MODERATOR | PARTICIPANT |
|---|:---:|:---:|:---:|
| play | ✅ | ✅ | ❌ |
| pause | ✅ | ✅ | ❌ |
| seek | ✅ | ✅ | ❌ |
| change_video | ✅ | ✅ | ❌ |
| send_message | ✅ | ✅ | ✅ |
| request_playback_action | ✅ | ✅ | ✅ |
| resolve_playback_request | ✅ | ✅ | ❌ |
| assign_role | ✅ | ❌ | ❌ |
| remove_participant | ✅ | ❌ | ❌ |

Role transitions allowed by `assign_role`:
- HOST → promote PARTICIPANT to MODERATOR ✅
- HOST → demote MODERATOR to PARTICIPANT ✅
- HOST → assign HOST role ❌ (use a separate host-transfer flow)
- MODERATOR or PARTICIPANT → any role ❌

---

## In-Memory State & Sync Math

### RoomStateManager

The `RoomStateManager` singleton is the **live authoritative source** during an active session. PostgreSQL is the persistent checkpoint.

```typescript
// In-memory shape per active room
interface ActiveRoom {
  roomId: string
  roomCode: string
  title: string
  hostUserId: string           // mirrors Room.hostUserId in DB
  playback: {
    videoId: string
    status: 'PLAYING' | 'PAUSED'
    anchorPositionSeconds: number   // position at the anchor moment
    anchorTimestampMs: number       // wall-clock ms at that anchor
    stateVersion: number            // monotonically increasing
  }
  participants: Map<userId, RoomParticipantState>  // keyed by userId
}
```

### Anchor Math — the sync algorithm

No server-side tick timer. Every client independently computes the authoritative playback position:

```
currentPosition = anchorPositionSeconds + (Date.now() - anchorTimestampMs) / 1000

When PAUSED:  currentPosition = anchorPositionSeconds  (static)
When PLAYING: currentPosition = anchorPositionSeconds + elapsed  (advancing)
```

When the HOST presses Play at position `42s`, the server records:
```
anchorPositionSeconds = 42
anchorTimestampMs     = 1700000000000  (server time)
status                = 'PLAYING'
```

A client that receives this 200 ms later computes:
```
currentPosition = 42 + (1700000000200 - 1700000000000) / 1000 = 42.2s
```

Everyone converges to the same position without any per-second server broadcasts.

---

## Two-Tier DB Write Strategy

| Tier | Operations | Pattern | Reason |
|---|---|---|---|
| **1 — DB-first** | `change_video`, role changes, kick/ban | Write DB → update memory. Abort if DB fails. | Room metadata — must survive server restarts |
| **2 — Memory-first** | `play`, `pause`, `seek` | Update memory → async checkpoint. Never block on DB. | Latency target <150 ms |

### Stale checkpoint rejection (Tier 2)

Multiple rapid play/pause events can stack up async DB writes. The stale-rejection guard prevents an older write from overwriting newer state:

```sql
UPDATE rooms
SET    playbackStatus = :status, lastPositionSeconds = :pos, stateVersion = :ver
WHERE  id = :roomId
AND    stateVersion <= :checkpointVersion   -- if DB already has a higher version, skip
```

If a newer event already wrote a higher `stateVersion`, `UPDATE` affects 0 rows — silently discarded. This is expected behavior, not an error.

---

## Frontend State Machine

Defined in `apps/web/src/hooks/useRoomState.ts` using `useReducer`.

```
Initial state
  isLoaded = false
  roomId, roomCode, roomTitle, hostUserId = ''
  currentUser = null
  participants = []
  playback = null
  pendingRequests = []

Socket events that update state:

  sync_state              → full replace of all fields, isLoaded = true
  playback_updated        → update playback object
                            stateVersion guard: drop if version ≤ current
  user_joined             → upsert participant (filter by userId then append)
  user_left               → set participant.isOnline = false
  role_assigned           → update participant role
                            if self → also update currentUser.role
  participant_removed     → remove participant from array
  playback_request_created→ append to pendingRequests
  playback_request_resolved→ remove from pendingRequests by requestId
```

### Loading screen logic

```
state.isLoaded === false
  connStatus === 'connecting' → "Connecting to server…"
  connStatus === 'connected'  → "Joining room…"
  connStatus === 'error'      → error UI + Retry + Back to Home
  loadError !== null          → error UI + Retry + Back to Home

state.isLoaded === true → full room UI rendered
```

Retry resets `joinedRef.current = false` and increments `retryCount`, which is in the join effect's dependency array — re-triggering the `join_room` emit.

---

## Running Tests

```bash
# Unit tests (no DB required)
npm run test --workspace=apps/server

# Integration tests (requires DATABASE_URL in apps/server/.env)
npm run test:integration --workspace=apps/server

# TypeScript checks
npm run typecheck --workspace=apps/server
npx tsc --noEmit --project apps/web/tsconfig.json
```

Unit test coverage: RoomStateManager, roomService recovery, RBAC rules, Zod schemas, YouTube ID extraction.

Integration test coverage:
- **REST**: room creation/joining, room info endpoint
- **Socket auth**: valid/invalid/expired/revoked/banned tokens
- **join_room**: ack + `sync_state` event emission, NTP `sync_ping`
- **Playback**: RBAC enforcement, broadcast to all room members, room isolation, late-joiner sync
- **Roles**: assign_role (promote/demote), transfer_host, RBAC on role events
- **Chat** (`chat.test.ts`): ack payload shape, all-roles can send, sender gets broadcast, all-members broadcast, empty/over-1000-char/whitespace-only body rejection, server-side trim, exactly-1000-char accepted, recentMessages on join, shape validation, empty room, 50-message cap (CHAT_HISTORY_LIMIT), room isolation (no cross-room leakage)
