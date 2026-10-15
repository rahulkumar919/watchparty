/**
 * @watchparty/types
 *
 * Single source of truth for all shared TypeScript types, Zod runtime validation
 * schemas, and Socket.IO event contracts. Both the frontend (apps/web) and
 * backend (apps/server) import from this package.
 *
 * Design decisions:
 * - Roles are NOT stored in the JWT. Only immutable identity (userId, sessionId,
 *   roomId) lives in the token. Roles are always queried from server state.
 * - Playback state uses anchor math: anchorPositionSeconds + elapsed time since
 *   anchorTimestampMs gives the live authoritative position without per-second ticks.
 * - stateVersion is a monotonically increasing integer per room used to reject
 *   stale async DB checkpoints (avoids older writes overwriting newer state).
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Domain Enums & Primitive Types
// ---------------------------------------------------------------------------

export type Role = 'HOST' | 'MODERATOR' | 'PARTICIPANT';
export type PlaybackStatus = 'PLAYING' | 'PAUSED';
export type PlaybackAction = 'PLAY' | 'PAUSE' | 'SEEK' | 'CHANGE_VIDEO';
export type RequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export const ROLES = ['HOST', 'MODERATOR', 'PARTICIPANT'] as const;
export const PLAYBACK_ACTIONS = ['PLAY', 'PAUSE', 'SEEK', 'CHANGE_VIDEO'] as const;
export const REQUEST_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'] as const;

// ---------------------------------------------------------------------------
// Zod Runtime Validation Schemas
// ---------------------------------------------------------------------------

/**
 * A valid YouTube video ID is exactly 11 characters: alphanumeric, hyphens, underscores.
 * Source: https://developers.google.com/youtube/v3/docs/videos
 */
export const YouTubeVideoIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{11}$/, 'Invalid YouTube video ID (must be 11 alphanumeric/dash/underscore chars)');

/**
 * Room codes are 8 uppercase alphanumeric characters (e.g. "AB12CD34").
 * Generated server-side using nanoid or crypto. Not user-supplied.
 */
export const RoomCodeSchema = z
  .string()
  .regex(/^[A-Z0-9]{8}$/, 'Invalid room code format');

export const DisplayNameSchema = z
  .string()
  .min(1, 'Display name is required')
  .max(32, 'Display name must be 32 characters or fewer')
  .trim();

export const SeekPositionSchema = z
  .number()
  .min(0, 'Seek position must be >= 0')
  .max(86400, 'Seek position must be < 24 hours'); // 24-hour cap

export const PositionSecondsSchema = z
  .number()
  .min(0, 'Position must be >= 0')
  .max(86400, 'Position must be < 24 hours');

// ---------------------------------------------------------------------------
// Socket.IO Event Payload Schemas (Zod — runtime validated on backend)
// ---------------------------------------------------------------------------

export const JoinRoomPayloadSchema = z.object({
  roomCode: RoomCodeSchema,
});

export const PlayPayloadSchema = z.object({
  positionSeconds: PositionSecondsSchema,
});

export const PausePayloadSchema = z.object({
  positionSeconds: PositionSecondsSchema,
});

export const SeekPayloadSchema = z.object({
  targetPositionSeconds: SeekPositionSchema,
});

export const ChangeVideoPayloadSchema = z.object({
  // Accept full URL or bare video ID; backend normalizes to video ID
  videoUrlOrId: z.string().min(1, 'Video URL or ID is required').max(512),
});

export const RequestPlaybackActionPayloadSchema = z.object({
  action: z.enum(PLAYBACK_ACTIONS),
  targetPositionSeconds: SeekPositionSchema.optional(),
  videoUrlOrId: z.string().min(1).max(512).optional(),
  note: z.string().max(200).optional(),
});

export const ResolvePlaybackRequestPayloadSchema = z.object({
  requestId: z.string().cuid('Invalid request ID'),
  decision: z.enum(['APPROVED', 'REJECTED']),
  reason: z.string().max(200).optional(),
});

export const AssignRolePayloadSchema = z.object({
  targetUserId: z.string().cuid('Invalid user ID'),
  newRole: z.enum(['MODERATOR', 'PARTICIPANT']), // HOST cannot be assigned via this event
});

export const RemoveParticipantPayloadSchema = z.object({
  targetUserId: z.string().cuid('Invalid user ID'),
  ban: z.boolean().optional().default(false),
});

export const TransferHostPayloadSchema = z.object({
  targetUserId: z.string().cuid('Invalid user ID'),
});

/**
 * Chat message payload — validated server-side before persist/broadcast.
 * body: non-empty string, max 1000 chars (matches the DB column VarChar(1000)).
 */
export const SendMessagePayloadSchema = z.object({
  body: z
    .string()
    .transform((s) => s.trim())
    .pipe(
      z
        .string()
        .min(1, 'Message cannot be empty')
        .max(1000, 'Message must be 1000 characters or fewer'),
    ),
});

// ---------------------------------------------------------------------------
// Data Transfer Objects (DTOs) — shaped for client consumption
// ---------------------------------------------------------------------------

export interface ParticipantDTO {
  userId: string;
  displayName: string;
  role: Role;
  isOnline: boolean;
  joinedAt: string; // ISO timestamp string
}

export interface PlaybackRequestDTO {
  id: string;
  requesterId: string;
  requesterDisplayName: string;
  action: PlaybackAction;
  payload: {
    targetPositionSeconds?: number;
    videoId?: string;
  };
  status: RequestStatus;
  note?: string;
  createdAt: string; // ISO timestamp string
  resolvedAt?: string;
}

/**
 * A single persisted chat message, safe for client consumption.
 * Sender identity (displayName) is denormalized at write time so message
 * history remains accurate even after a user's displayName changes.
 */
export interface ChatMessageDTO {
  id: string;
  roomId: string;
  userId: string;
  displayName: string;
  body: string;
  createdAt: string; // ISO timestamp string
}

export interface RoomPlaybackState {
  videoId: string;
  status: PlaybackStatus;
  /** The authoritative position (in seconds) at the moment anchorTimestampMs was set. */
  anchorPositionSeconds: number;
  /**
   * Server clock timestamp (ms) when the anchor was last set.
   * Combined with anchorPositionSeconds, allows any client to compute the
   * live position: anchorPositionSeconds + (now - anchorTimestampMs) / 1000
   */
  anchorTimestampMs: number;
  /**
   * Monotonically increasing integer. Incremented on every state change.
   * Used to reject stale async DB checkpoints: a checkpoint is only written
   * if the stateVersion matches the current in-memory value.
   */
  stateVersion: number;
}

export interface SyncStatePayload {
  room: {
    id: string;
    code: string;
    title: string;
    /** Canonical Host — always Room.hostUserId from the database */
    hostUserId: string;
  };
  playback: RoomPlaybackState & {
    /** Current server wall-clock time (ms) — lets clients compute clock offset */
    serverTimeMs: number;
  };
  currentUser: {
    userId: string;
    displayName: string;
    /** Role is read from server state, never from JWT */
    role: Role;
  };
  participants: ParticipantDTO[];
  /** All PENDING requests in this room, sent only to HOST and MODERATOR */
  pendingRequests: PlaybackRequestDTO[];
  /**
   * The 50 most recent chat messages in chronological order.
   * Sent to every joining member so they have context immediately.
   */
  recentMessages: ChatMessageDTO[];
}

export interface PlaybackUpdatedPayload {
  action: PlaybackAction;
  videoId: string;
  status: PlaybackStatus;
  anchorPositionSeconds: number;
  anchorTimestampMs: number;
  serverTimeMs: number;
  stateVersion: number;
  triggeredByUserId: string;
  triggeredByDisplayName: string;
}

// ---------------------------------------------------------------------------
// Structured Socket Response Wrapper
// ---------------------------------------------------------------------------

export interface SocketResponse<T = void> {
  success: boolean;
  data?: T;
  error?: {
    code:
    | 'UNAUTHORIZED'
    | 'FORBIDDEN'
    | 'BAD_REQUEST'
    | 'NOT_FOUND'
    | 'CONFLICT'
    | 'INTERNAL_ERROR';
    message: string;
  };
}

// ---------------------------------------------------------------------------
// Socket.IO Typed Event Maps
// ---------------------------------------------------------------------------

/**
 * Events emitted by the CLIENT and received by the SERVER.
 * All handlers on the backend must validate the payload with the corresponding
 * Zod schema before any business logic runs.
 */
export interface ClientToServerEvents {
  /**
   * Authenticate and join a Socket.IO room.
   * The session JWT must be in socket.handshake.auth.token.
   * On success, the server adds the socket to the Socket.IO room keyed by roomCode
   * and emits sync_state back to the caller.
   */
  join_room: (
    payload: z.infer<typeof JoinRoomPayloadSchema>,
    callback: (response: SocketResponse<SyncStatePayload>) => void,
  ) => void;

  /** Play from the given position. Requires HOST or MODERATOR role. */
  play: (
    payload: z.infer<typeof PlayPayloadSchema>,
    callback?: (response: SocketResponse) => void,
  ) => void;

  /** Pause at the given position. Requires HOST or MODERATOR role. */
  pause: (
    payload: z.infer<typeof PausePayloadSchema>,
    callback?: (response: SocketResponse) => void,
  ) => void;

  /** Seek to targetPositionSeconds. Requires HOST or MODERATOR role. */
  seek: (
    payload: z.infer<typeof SeekPayloadSchema>,
    callback?: (response: SocketResponse) => void,
  ) => void;

  /** Change the current video. Requires HOST or MODERATOR role. */
  change_video: (
    payload: z.infer<typeof ChangeVideoPayloadSchema>,
    callback?: (response: SocketResponse<{ videoId: string }>) => void,
  ) => void;

  /** Submit a playback request (PARTICIPANT role). HOST/MODERATOR can also use this. */
  request_playback_action: (
    payload: z.infer<typeof RequestPlaybackActionPayloadSchema>,
    callback: (response: SocketResponse<PlaybackRequestDTO>) => void,
  ) => void;

  /** Approve or reject a PENDING playback request. Requires HOST or MODERATOR. */
  resolve_playback_request: (
    payload: z.infer<typeof ResolvePlaybackRequestPayloadSchema>,
    callback: (response: SocketResponse) => void,
  ) => void;

  /**
   * Assign a role to a target participant. Requires HOST.
   * Only HOST→MODERATOR and MODERATOR→PARTICIPANT transitions are allowed.
   * HOST assignment is managed separately (room creation / remove_participant).
   */
  assign_role: (
    payload: z.infer<typeof AssignRolePayloadSchema>,
    callback: (response: SocketResponse) => void,
  ) => void;

  /**
   * Remove a participant from the room. Requires HOST.
   * If ban=true, marks RoomParticipant.isBanned and revokes the session so
   * the user cannot rejoin with the same token.
   */
  remove_participant: (
    payload: z.infer<typeof RemoveParticipantPayloadSchema>,
    callback: (response: SocketResponse) => void,
  ) => void;

  /**
   * NTP-lite clock synchronization ping.
   * Client sends its local timestamp; server replies with its timestamp.
   * Client computes: clockOffset = serverTime - (clientTime + RTT/2)
   */
  sync_ping: (
    clientSendTimestampMs: number,
    callback: (serverReceivedTimestampMs: number) => void,
  ) => void;

  /** Graceful departure. Updates isOnline, removes from Socket.IO room. */
  leave_room: () => void;

  /**
   * Transfer the Host role to another participant. Requires HOST.
   * The caller becomes PARTICIPANT; the target becomes HOST.
   * Room.hostUserId is updated atomically in the database.
   */
  transfer_host: (
    payload: z.infer<typeof TransferHostPayloadSchema>,
    callback: (response: SocketResponse) => void,
  ) => void;

  /**
   * Send a chat message to the room.
   * Sender identity is derived entirely from server-side session state —
   * the client MUST NOT supply userId, displayName, or roomId.
   * Body is trimmed and validated (1–1000 chars) before persistence.
   */
  send_message: (
    payload: z.infer<typeof SendMessagePayloadSchema>,
    callback: (response: SocketResponse<ChatMessageDTO>) => void,
  ) => void;
}

/**
 * Events emitted by the SERVER and received by CLIENTS.
 */
export interface ServerToClientEvents {
  /**
   * Full authoritative state snapshot.
   * Sent: on join, after reconnect, or when server detects major desync.
   */
  sync_state: (state: SyncStatePayload) => void;

  /**
   * Granular playback state change.
   * Sent after every play/pause/seek/change_video or approved request.
   */
  playback_updated: (payload: PlaybackUpdatedPayload) => void;

  /** A new participant has joined the room. */
  user_joined: (participant: ParticipantDTO) => void;

  /** A participant has left or disconnected. */
  user_left: (payload: { userId: string; displayName: string; reason?: 'left' | 'disconnected' }) => void;

  /** A participant's role has been changed by the Host. */
  role_assigned: (payload: {
    userId: string;
    displayName: string;
    newRole: Role;
    updatedByUserId: string;
    updatedByDisplayName: string;
  }) => void;

  /** A participant has been removed (kicked or banned) by the Host. */
  participant_removed: (payload: {
    userId: string;
    displayName: string;
    isBanned: boolean;
    removedByDisplayName: string;
  }) => void;

  /**
   * A new playback request has been created.
   * Broadcast to all HOST and MODERATOR sockets in the room.
   */
  playback_request_created: (request: PlaybackRequestDTO) => void;

  /** A playback request has been approved or rejected. Broadcast to the whole room. */
  playback_request_resolved: (payload: {
    requestId: string;
    status: 'APPROVED' | 'REJECTED';
    resolvedByDisplayName: string;
    actionApplied: boolean;
    rejectionReason?: string;
  }) => void;

  /**
   * Structured server-side error notification.
   * Used for out-of-band error messages (e.g., player errors relayed from server).
   */
  error_notification: (error: {
    code: string;
    message: string;
  }) => void;

  /**
   * The Host role has been transferred to a new participant.
   * Broadcast to the whole room so every client can update their local state.
   */
  host_transferred: (payload: {
    previousHostUserId: string;
    previousHostDisplayName: string;
    newHostUserId: string;
    newHostDisplayName: string;
  }) => void;

  /**
   * A new chat message has been persisted and broadcast to the room.
   * All connected members of the room receive this event.
   * Clients should deduplicate by message `id` to handle reconnect races.
   */
  message_received: (message: ChatMessageDTO) => void;
}

/**
 * Socket.IO inter-server events (unused in single-instance deployment,
 * defined here for future horizontal-scaling compatibility).
 */
export interface InterServerEvents {
  ping: () => void;
}

/**
 * Data attached to each socket instance by the auth middleware.
 * NEVER read userId, roomId, or role from event payloads — always from socket.data.
 */
export interface SocketData {
  session: {
    sessionId: string;
    userId: string;
    roomId: string;
    roomCode: string;
    displayName: string;
  };
}

// ---------------------------------------------------------------------------
// JWT Payload Shape (immutable identity — no role stored here)
// ---------------------------------------------------------------------------

export interface SessionTokenPayload {
  sessionId: string;
  userId: string;
  roomId: string;
  roomCode: string;
  displayName: string;
  /** Issued-at timestamp (seconds, standard JWT claim) */
  iat?: number;
  /** Expiry timestamp (seconds, standard JWT claim) */
  exp?: number;
}

// ---------------------------------------------------------------------------
// REST API Request/Response Shapes
// ---------------------------------------------------------------------------

export interface CreateRoomRequest {
  displayName: string;
  title?: string;
  initialVideoId?: string;
}

export interface CreateRoomResponse {
  sessionToken: string;
  room: {
    id: string;
    code: string;
    title: string;
    hostUserId: string;
  };
  userId: string;
  displayName: string;
}

export interface JoinRoomRequest {
  roomCode: string;
  displayName: string;
}

export interface JoinRoomResponse {
  sessionToken: string;
  room: {
    id: string;
    code: string;
    title: string;
    hostUserId: string;
  };
  userId: string;
  displayName: string;
  role: Role;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}
