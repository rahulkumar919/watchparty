# Architecture Overview

YouTube Watch Party System - Technical Documentation

## System Architecture

```
┌──────────────────┐         WebSocket (Socket.IO)        ┌──────────────────┐
│                  │◄──────────────────────────────────────►│                  │
│   Next.js 16     │          REST API (HTTP)              │   Express.js     │
│   Frontend       │◄──────────────────────────────────────►│   Backend        │
│  (Vercel)        │                                        │  (Render)        │
│                  │                                        │                  │
└──────────────────┘                                        └────────┬─────────┘
                                                                     │
                                                                     │ Prisma ORM
                                                                     │
                                                              ┌──────▼─────────┐
                                                              │   PostgreSQL   │
                                                              │     (Neon)     │
                                                              └────────────────┘
```

## WebSocket Integration Flow

### Connection Lifecycle

1. User creates/joins room via REST API → Receives JWT session token
2. Frontend establishes WebSocket connection with JWT in auth header
3. Server validates JWT using middleware
4. User automatically joins Socket.IO room based on roomCode
5. Server sends complete sync state
6. User receives real-time events for room activity

### Event Flow Example: Host Pauses Video

```
[Host Client]                [Server]                    [Other Clients]
      │                          │                              │
      │──pause{pos:120}─────────►│                              │
      │                          │ Validate JWT & role          │
      │                          │ Check canPerformAction()     │
      │                          │ Update in-memory state       │
      │                          │ Async DB checkpoint          │
      │                          │                              │
      │◄────ack{success}─────────│                              │
      │                          │──playback_updated{...}──────►│
      │◄─playback_updated{...}───│                              │
      │                          │                              │
      │    All clients sync to paused state at position 120    │
```

## State Synchronization Mechanism

### Two-Tier Architecture

1. **In-Memory State (RoomStateManager)**
   - Primary source of truth for active rooms
   - Fast read/write operations
   - Handles real-time playback state

2. **Database (PostgreSQL via Prisma)**
   - Persistent storage
   - Async checkpoints every state change
   - Cold-start recovery after server restart

### Anchor-Based Position Calculation

Instead of constantly syncing exact position:

```typescript
// Server stores anchor point
anchorPositionSeconds = 120.5
anchorTimestampMs = 1697123456789
status = "PLAYING"

// Client computes current position
elapsedMs = Date.now() - anchorTimestampMs
currentPosition = anchorPositionSeconds + (elapsedMs / 1000)
```

Benefits:
- No constant network traffic
- Smooth playback without jitter
- Drift correction kicks in at ±1.5s threshold

### stateVersion Guard

```typescript
// Prevents applying stale updates
if (incomingStateVersion <= currentStateVersion) {
  // Ignore - already have newer state
  return;
}
applyUpdate(newState);
currentStateVersion = incomingStateVersion;
```

## Database Schema

### Core Tables

**User** - Guest users with display names
- id, displayName, createdAt, updatedAt

**Session** - JWT session tracking
- id, userId, roomId, tokenHash (SHA-256), isRevoked, expiresAt

**Room** - Watch party rooms
- id, code (8-char), title, hostUserId, isClosed
- currentVideoId, playbackStatus, lastPositionSeconds, stateVersion

**RoomParticipant** - User membership in rooms
- id, roomId, userId, role, isOnline, isBanned

**PlaybackRequest** - Participant action requests
- id, roomId, requesterId, action, payload, status, resolvedById

**ChatMessage** - Room chat history
- id, roomId, userId, displayName, body, createdAt

## Security Model

### Authentication Flow

1. User creates/joins room → Server generates JWT
2. JWT contains: sessionId, userId, roomId, roomCode, displayName
3. JWT signed with JWT_SECRET
4. Session stored in DB with SHA-256(JWT) as tokenHash

### Authorization (RBAC)

Every Socket.IO event:
1. Validates JWT signature
2. Checks if session.isRevoked == false
3. Fetches current role from DB (NOT from JWT)
4. Calls canPerformAction(role, action)
5. Executes or rejects

### Permission Matrix

```typescript
const PERMISSION_MAP = {
  play: ['HOST', 'MODERATOR'],
  pause: ['HOST', 'MODERATOR'],
  seek: ['HOST', 'MODERATOR'],
  change_video: ['HOST', 'MODERATOR'],
  request_playback_action: ['PARTICIPANT'],
  resolve_playback_request: ['HOST', 'MODERATOR'],
  assign_role: ['HOST'],
  remove_participant: ['HOST'],
};
```

### CORS & Input Validation

- CORS: Whitelist of allowed origins (env: CORS_ORIGIN)
- All inputs validated with Zod schemas
- SQL injection prevented by Prisma parameterized queries

## Environment Variables

### Backend

| Variable | Purpose | Example |
|----------|---------|---------|
| DATABASE_URL | Pooled connection (runtime) | postgresql://...?pgbouncer=true |
| DIRECT_URL | Direct connection (migrations) | postgresql://... |
| JWT_SECRET | Token signing key | openssl rand -base64 32 |
| CORS_ORIGIN | Allowed frontends | http://localhost:3000,https://app.com |
| PORT | Server port | 4000 |
| NODE_ENV | Environment | production |

### Frontend

| Variable | Purpose | Example |
|----------|---------|---------|
| NEXT_PUBLIC_API_URL | Backend REST API | https://api.example.com |
| NEXT_PUBLIC_SOCKET_URL | Backend WebSocket | https://api.example.com |

## Deployment Architecture

### Production Setup

```
[Vercel Edge Network]              [Render]                 [Neon]
       │                              │                        │
       │ Next.js SSR                  │ Express + Socket.IO    │ PostgreSQL
       │ Static assets                │ HTTP/WS server         │ Serverless
       │ Auto-scaling                 │ Auto-scaling           │ Pooling
       │                              │                        │
       └──────────REST/WS─────────────┴───────Prisma──────────┘
```

### Zero-Downtime Deployment

1. New backend deployed to Render
2. Health check endpoint validated
3. Traffic switched to new instance
4. Old instance gracefully shuts down
5. Frontend redeploys on Vercel
6. Socket.IO clients auto-reconnect

## Performance Optimizations

1. **In-Memory State** - O(1) room lookups
2. **Async DB Writes** - Non-blocking checkpoints
3. **Connection Pooling** - Neon pgBouncer
4. **Client-Side Position** - No constant server queries
5. **Selective Broadcasting** - Only to room participants

## Monitoring & Health

### Health Endpoint

GET /health returns:
```json
{
  "status": "ok",
  "uptime": 3600.5,
  "db": "connected",
  "activeRooms": 42
}
```

### Metrics Tracked

- Active WebSocket connections
- Rooms in memory
- Database connection pool status
- API response times

## Future Enhancements

- Redis for distributed state (multi-instance)
- Video buffering sync
- Screen sharing
- Voice chat integration
- Playlist management

---

**Last Updated**: October 2026
**Maintained by**: Rahul Kumar
