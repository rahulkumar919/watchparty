/**
 * Authoritative Room State Manager
 *
 * Maintains in-memory state for all active rooms.
 * This is the LIVE authoritative source during an active session.
 * PostgreSQL is the persistent checkpoint (written asynchronously for playback,
 * synchronously for admin operations).
 *
 * Key design principles:
 * - stateVersion: monotonically incrementing integer. DB checkpoints only succeed
 *   if the stateVersion they carry matches the current in-memory value.
 *   This prevents an older async write from overwriting a newer state.
 * - anchorPositionSeconds + anchorTimestampMs: anchor math eliminates the need
 *   for per-second server timers while providing exact time-based position computation.
 * - Participant roster is kept here for fast authorization checks without DB queries
 *   on every socket event.
 */

import { Role, PlaybackStatus, PlaybackAction, RoomPlaybackState } from '@watchparty/types';

export interface RoomParticipantState {
  userId: string;
  displayName: string;
  role: Role;
  isOnline: boolean;
  socketId: string | null;
  joinedAt: Date;
}

export interface ActiveRoom {
  roomId: string;
  roomCode: string;
  title: string;
  hostUserId: string; // Canonical Host — mirrors Room.hostUserId in DB
  playback: RoomPlaybackState;
  participants: Map<string, RoomParticipantState>; // keyed by userId
}

class RoomStateManager {
  private rooms: Map<string, ActiveRoom> = new Map(); // keyed by roomCode

  // ─── Room Lifecycle ─────────────────────────────────────────────────────────

  /**
   * Load a room into memory (called on first join after cold start or cache miss).
   */
  loadRoom(room: Omit<ActiveRoom, 'participants'> & { participants: RoomParticipantState[] }): void {
    const participantMap = new Map<string, RoomParticipantState>();
    for (const p of room.participants) {
      participantMap.set(p.userId, p);
    }
    this.rooms.set(room.roomCode, {
      ...room,
      participants: participantMap,
    });
  }

  /**
   * Remove a room from memory (when closed or all users have left).
   */
  unloadRoom(roomCode: string): void {
    this.rooms.delete(roomCode);
  }

  getRoom(roomCode: string): ActiveRoom | undefined {
    return this.rooms.get(roomCode);
  }

  hasRoom(roomCode: string): boolean {
    return this.rooms.has(roomCode);
  }

  // ─── Participant Management ─────────────────────────────────────────────────

  addParticipant(roomCode: string, participant: RoomParticipantState): void {
    const room = this.rooms.get(roomCode);
    if (!room) return;
    room.participants.set(participant.userId, participant);
  }

  updateParticipantSocket(roomCode: string, userId: string, socketId: string | null): void {
    const room = this.rooms.get(roomCode);
    if (!room) return;
    const participant = room.participants.get(userId);
    if (participant) {
      participant.socketId = socketId;
      participant.isOnline = socketId !== null;
    }
  }

  updateParticipantOnlineStatus(roomCode: string, userId: string, isOnline: boolean): void {
    const room = this.rooms.get(roomCode);
    if (!room) return;
    const participant = room.participants.get(userId);
    if (participant) {
      participant.isOnline = isOnline;
      if (!isOnline) participant.socketId = null;
    }
  }

  removeParticipant(roomCode: string, userId: string): void {
    const room = this.rooms.get(roomCode);
    if (!room) return;
    room.participants.delete(userId);
  }

  getParticipant(roomCode: string, userId: string): RoomParticipantState | undefined {
    return this.rooms.get(roomCode)?.participants.get(userId);
  }

  /**
   * Returns the current role of a user in a room.
   * Returns null if the room doesn't exist or user is not a member.
   */
  getParticipantRole(roomCode: string, userId: string): Role | null {
    return this.rooms.get(roomCode)?.participants.get(userId)?.role ?? null;
  }

  updateParticipantRole(roomCode: string, userId: string, newRole: Role): void {
    const room = this.rooms.get(roomCode);
    if (!room) return;
    const participant = room.participants.get(userId);
    if (participant) {
      participant.role = newRole;
    }
  }

  getParticipants(roomCode: string): RoomParticipantState[] {
    return Array.from(this.rooms.get(roomCode)?.participants.values() ?? []);
  }

  getOnlineParticipants(roomCode: string): RoomParticipantState[] {
    return this.getParticipants(roomCode).filter((p) => p.isOnline);
  }

  // ─── Playback State ─────────────────────────────────────────────────────────

  /**
   * Apply a PLAY event. Updates status, anchor position, and anchor timestamp.
   * Increments stateVersion to allow stale checkpoint rejection.
   *
   * Returns the new playback state (for broadcasting and DB checkpointing).
   */
  applyPlay(
    roomCode: string,
    positionSeconds: number,
    serverTimeMs: number = Date.now(),
  ): RoomPlaybackState | null {
    const room = this.rooms.get(roomCode);
    if (!room) return null;

    room.playback = {
      ...room.playback,
      status: 'PLAYING',
      anchorPositionSeconds: positionSeconds,
      anchorTimestampMs: serverTimeMs,
      stateVersion: room.playback.stateVersion + 1,
    };
    return room.playback;
  }

  /**
   * Apply a PAUSE event. Freezes position at the given timestamp.
   */
  applyPause(
    roomCode: string,
    positionSeconds: number,
  ): RoomPlaybackState | null {
    const room = this.rooms.get(roomCode);
    if (!room) return null;

    room.playback = {
      ...room.playback,
      status: 'PAUSED',
      anchorPositionSeconds: positionSeconds,
      anchorTimestampMs: Date.now(),
      stateVersion: room.playback.stateVersion + 1,
    };
    return room.playback;
  }

  /**
   * Apply a SEEK event. Position and anchor are updated; status is preserved.
   */
  applySeek(
    roomCode: string,
    targetPositionSeconds: number,
  ): RoomPlaybackState | null {
    const room = this.rooms.get(roomCode);
    if (!room) return null;

    const nowMs = Date.now();
    room.playback = {
      ...room.playback,
      anchorPositionSeconds: targetPositionSeconds,
      anchorTimestampMs: nowMs,
      stateVersion: room.playback.stateVersion + 1,
    };
    return room.playback;
  }

  /**
   * Apply a CHANGE_VIDEO event. Resets playback to PAUSED at position 0.
   */
  applyChangeVideo(
    roomCode: string,
    videoId: string,
  ): RoomPlaybackState | null {
    const room = this.rooms.get(roomCode);
    if (!room) return null;

    room.playback = {
      videoId,
      status: 'PAUSED',
      anchorPositionSeconds: 0,
      anchorTimestampMs: Date.now(),
      stateVersion: room.playback.stateVersion + 1,
    };
    return room.playback;
  }

  getPlaybackState(roomCode: string): RoomPlaybackState | null {
    return this.rooms.get(roomCode)?.playback ?? null;
  }

  /**
   * Computes the live authoritative position at the given wall-clock time.
   * Uses anchor math: position = anchorPositionSeconds + elapsed_seconds
   *
   * This is the core of the synchronization algorithm — no per-second timer needed.
   */
  computeCurrentPosition(roomCode: string, atMs: number = Date.now()): number | null {
    const state = this.getPlaybackState(roomCode);
    if (!state) return null;

    if (state.status === 'PAUSED') {
      return state.anchorPositionSeconds;
    }

    const elapsedSeconds = (atMs - state.anchorTimestampMs) / 1000;
    return Math.max(0, state.anchorPositionSeconds + elapsedSeconds);
  }

  // ─── Host Management ────────────────────────────────────────────────────────

  updateHostUserId(roomCode: string, newHostUserId: string): void {
    const room = this.rooms.get(roomCode);
    if (!room) return;
    room.hostUserId = newHostUserId;
  }

  // ─── Diagnostics ────────────────────────────────────────────────────────────

  getActiveRoomCount(): number {
    return this.rooms.size;
  }

  getActiveRoomCodes(): string[] {
    return Array.from(this.rooms.keys());
  }
}

// Export the class for test isolation (tests create their own instances)
export { RoomStateManager };

// Singleton instance — shared across the entire server process
export const roomStateManager = new RoomStateManager();
