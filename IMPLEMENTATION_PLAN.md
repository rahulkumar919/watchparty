# YouTube Watch Party System — Implementation Plan

> **Project**: Web3Task Full-Stack Internship Assignment  
> **Stack**: Next.js 14 · TypeScript · Node.js · Express · Socket.IO · PostgreSQL · Prisma · YouTube IFrame API  
> **Architecture Reference**: `phase_0_architecture_specification.md`

---

## Architecture Decisions (Locked)

| Decision | Choice | Rationale |
|---|---|---|
| Repo layout | npm workspaces monorepo (`apps/web`, `apps/server`, `packages/types`) | Single `git` history, shared types without publishing |
| User identity | Frictionless guest sessions — display name only, signed JWT | Zero login friction; suitable for a demo-first assignment |
| Dev DB | Hosted PostgreSQL (Neon/Supabase free tier) or local Docker | 100% dialect parity with Render; no SQLite dialect drift |
| Autoplay | Smart Audio Sync Banner (muted start → "Click to unmute & sync") | Respects browser autoplay policy without blocking room entry |
| Host identity | `Room.hostUserId` in DB is canonical; role NOT in JWT | Prevents stale-token privilege escalation |
| Playback sync | Conservative two-zone drift snap (±1.5s threshold, `seekTo`) | Avoids unsupported YouTube playback-rate API; no audio distortion |
| Concurrency | Atomic `updateMany WHERE status = 'PENDING'` for request approval | Exactly-once resolution under concurrent Host + Moderator clicks |
| DB failure | Tier 1 (admin ops) = DB-first; Tier 2 (play/pause/seek) = memory-first + async checkpoint | Admin data must be durable; playback must be fast |
| State version | `stateVersion` integer on `Room`, incremented each state change | Stale async checkpoints are rejected if a newer version already wrote |

---

## Requirements Checklist

### Core Features
- [ ] Create a watch party room (generate unique 8-char room code)
- [ ] Join a room by code (frictionless guest session)
- [ ] Real-time play / pause / seek synchronization via Socket.IO
- [ ] Change the current video (URL or bare ID accepted)
- [ ] Participant playback request workflow (submit → host approves/rejects)
- [ ] Atomic, race-condition-safe request resolution
- [ ] Role system: HOST, MODERATOR, PARTICIPANT (enforced server-side, never JWT-based)
- [ ] Host: promote participant → Moderator, demote Moderator → Participant
- [ ] Host: kick participant, ban participant (revokes session, forceful disconnect)
- [ ] Two-zone drift correction algorithm (client-side sync loop)
- [ ] NTP-lite clock offset calculation (`sync_ping`)
- [ ] Cold-start server restart recovery from PostgreSQL checkpoint
- [ ] Loop-breaker: `isApplyingRemoteUpdate` flag prevents self-echo

### Security
- [ ] JWT contains only identity (no role); role queried from DB/memory on every event
- [ ] Socket handshake validates JWT + `Session.isRevoked` + `RoomParticipant.isBanned`
- [ ] Zod runtime validation on every Socket.IO event payload
- [ ] CORS restricted to configured origin list
- [ ] Session revoked on ban; reconnect attempts rejected

### Infrastructure
- [ ] `/health` endpoint: `{ status, uptime, db, activeRooms }`
- [ ] Graceful shutdown (SIGTERM / SIGINT)
- [ ] Render deployment (frontend + backend + managed PostgreSQL)
- [ ] Environment variable templates (`.env.example`)

### Testing
- [ ] Unit: YouTube URL parser (18 cases)
- [ ] Unit: RBAC permission matrix (23 cases)
- [ ] Unit: RoomStateManager anchor math (19 cases)
- [ ] Unit: Cold-start recovery calculation (5 cases)
- [ ] Unit: Zod schema validation (26 cases)
- [ ] Integration: Room isolation
- [ ] Integration: Permission enforcement
- [ ] Integration: Atomic request resolution (concurrent approvals)
- [ ] Integration: Role elevation and revocation
- [ ] Integration: Late-joiner sync
- [ ] E2E (Playwright): Full user journey

---

## Phased Implementation Roadmap

### Phase 0 — Architecture & Specification — COMPLETE
All architectural decisions locked; data models, ERD, event contracts, RBAC matrix defined.

---

### Phase 1 — Monorepo Setup & Testing Infrastructure — COMPLETE
**Deliverables:**
- npm workspaces monorepo with `apps/web`, `apps/server`, `packages/types`
- Shared types: all Zod schemas, Socket.IO event maps, DTOs
- Full Express + Socket.IO server scaffold (all services and handlers)
- Prisma schema with all models, indexes, constraints
- 91 unit tests passing, 0 TypeScript errors
- Next.js 14 App Router frontend scaffolded

---

### Phase 2 — Database Schema, Prisma & Session Auth — NEXT
**Completion Criteria**: PostgreSQL schema migrated; JWT session generation tested; socket handshake integration test passing.

**Tasks:**
1. Configure live PostgreSQL (Neon free tier recommended)
2. Copy `.env.example` → `.env`, fill `DATABASE_URL` and `JWT_SECRET`
3. Run `npm run db:migrate --workspace=apps/server`
4. Integration test: `POST /api/rooms` → creates room, returns valid JWT
5. Integration test: Socket.IO connection with valid JWT → `join_room` succeeds
6. Integration test: revoked JWT → socket rejected

---

### Phase 3 — YouTube Player Component & Client Controls — PENDING
**Completion Criteria**: YouTube IFrame API wrapped in custom hook; local controls functional; loop-breaker implemented.

---

### Phase 4 — Authoritative State Engine & Real-Time Sync — PENDING
**Completion Criteria**: play/pause/seek syncing across two browser contexts; drift correction loop running.

---

### Phase 5 — Server-Side RBAC & Participant Management — PENDING
**Completion Criteria**: Role authorization enforced server-side; participant roster UI; Host actions verified.

---

### Phase 6 — Playback Request & Approval Workflow — PENDING
**Completion Criteria**: PARTICIPANT request UI; HOST/MOD approval modal; atomic concurrency test passing.

---

### Phase 7 — Drift Tuning, Reconnects & Edge Cases — PENDING
**Completion Criteria**: Drift algorithm verified; cold-start recovery tested; autoplay banner functional.

---

### Phase 8 — UI Polish & Playwright E2E Tests — PENDING
**Completion Criteria**: Polished dark UI; Playwright multi-context E2E passing.

---

### Phase 9 — Deployment, Documentation & Demo Prep — PENDING
**Completion Criteria**: Live URL on Render; README complete; interview guide ready.

---

## Phase 1 Acceptance Criteria

| Criterion | Status |
|---|---|
| npm workspaces monorepo initialized | PASS |
| `packages/types` with all Zod schemas and Socket.IO event maps | PASS |
| Full Express + Socket.IO server scaffold | PASS |
| Prisma schema with all models, indexes, constraints | PASS |
| 91 unit tests passing across 5 test files | PASS |
| 0 TypeScript compilation errors | PASS |
| Next.js 14 App Router frontend scaffolded | PASS |
| `.env.example` templates for server | PASS |
| `/health` endpoint defined | PASS |
