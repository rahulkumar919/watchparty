import { describe, it, expect, beforeEach } from 'vitest';
import { RoomStateManager } from '../state/RoomStateManager';

describe('RoomStateManager', () => {
  let manager: RoomStateManager;


  const ROOM_CODE = 'TESTROOM';
  const ROOM_ID = 'room-id-1';

  const defaultRoom = {
    roomId: ROOM_ID,
    roomCode: ROOM_CODE,
    title: 'Test Room',
    hostUserId: 'user-1',
    playback: {
      videoId: 'dQw4w9WgXcQ',
      status: 'PAUSED' as const,
      anchorPositionSeconds: 0,
      anchorTimestampMs: Date.now(),
      serverTimeMs: Date.now(),
      stateVersion: 0,
    },
    participants: [],
  };

  beforeEach(() => {
    manager = new RoomStateManager();
    manager.loadRoom(defaultRoom);
  });

  describe('loadRoom and getRoom', () => {
    it('loads and retrieves a room', () => {
      const room = manager.getRoom(ROOM_CODE);
      expect(room).toBeDefined();
      expect(room?.roomCode).toBe(ROOM_CODE);
      expect(room?.hostUserId).toBe('user-1');
    });

    it('returns undefined for unknown room', () => {
      expect(manager.getRoom('UNKNOWN1')).toBeUndefined();
    });
  });

  describe('applyPlay', () => {
    it('sets status to PLAYING', () => {
      const state = manager.applyPlay(ROOM_CODE, 30, 1_000_000);
      expect(state?.status).toBe('PLAYING');
    });

    it('sets anchorPositionSeconds correctly', () => {
      const state = manager.applyPlay(ROOM_CODE, 45.5, 1_000_000);
      expect(state?.anchorPositionSeconds).toBe(45.5);
    });

    it('increments stateVersion', () => {
      manager.applyPlay(ROOM_CODE, 0, 1_000_000);
      const state = manager.getPlaybackState(ROOM_CODE);
      expect(state?.stateVersion).toBe(1);
    });

    it('returns null for unknown room', () => {
      expect(manager.applyPlay('UNKNOWN1', 0, 0)).toBeNull();
    });
  });

  describe('applyPause', () => {
    it('sets status to PAUSED', () => {
      manager.applyPlay(ROOM_CODE, 30, 1_000_000);
      const state = manager.applyPause(ROOM_CODE, 35);
      expect(state?.status).toBe('PAUSED');
    });

    it('freezes position at given seconds', () => {
      const state = manager.applyPause(ROOM_CODE, 123);
      expect(state?.anchorPositionSeconds).toBe(123);
    });
  });

  describe('applySeek', () => {
    it('updates anchorPositionSeconds', () => {
      const state = manager.applySeek(ROOM_CODE, 99);
      expect(state?.anchorPositionSeconds).toBe(99);
    });

    it('preserves existing status', () => {
      manager.applyPlay(ROOM_CODE, 10, Date.now());
      const state = manager.applySeek(ROOM_CODE, 50);
      expect(state?.status).toBe('PLAYING');
    });
  });

  describe('applyChangeVideo', () => {
    it('resets to PAUSED at position 0 with new video ID', () => {
      manager.applyPlay(ROOM_CODE, 120, Date.now());
      const state = manager.applyChangeVideo(ROOM_CODE, 'newVidId11c');
      expect(state?.videoId).toBe('newVidId11c');
      expect(state?.status).toBe('PAUSED');
      expect(state?.anchorPositionSeconds).toBe(0);
    });
  });

  describe('computeCurrentPosition', () => {
    it('returns anchorPositionSeconds when PAUSED', () => {
      manager.applyPause(ROOM_CODE, 42);
      const pos = manager.computeCurrentPosition(ROOM_CODE, Date.now() + 5000);
      expect(pos).toBe(42); // Position does not advance when paused
    });

    it('computes advancing position when PLAYING', () => {
      const anchor = 10;
      const anchorTime = 1_000_000;
      manager.applyPlay(ROOM_CODE, anchor, anchorTime);

      const laterTime = anchorTime + 5000; // 5 seconds later
      const pos = manager.computeCurrentPosition(ROOM_CODE, laterTime);
      expect(pos).toBeCloseTo(15, 1); // 10 + 5 = 15
    });

    it('never returns a negative position', () => {
      manager.applyPlay(ROOM_CODE, 0, Date.now() + 10_000);
      const pos = manager.computeCurrentPosition(ROOM_CODE, Date.now());
      expect(pos).toBeGreaterThanOrEqual(0);
    });
  });

  describe('participant management', () => {
    const participant = {
      userId: 'user-2',
      displayName: 'Alice',
      role: 'PARTICIPANT' as const,
      isOnline: true,
      socketId: 'socket-1',
      joinedAt: new Date(),
    };

    it('adds and retrieves a participant', () => {
      manager.addParticipant(ROOM_CODE, participant);
      expect(manager.getParticipant(ROOM_CODE, 'user-2')).toBeDefined();
    });

    it('returns the correct role', () => {
      manager.addParticipant(ROOM_CODE, participant);
      expect(manager.getParticipantRole(ROOM_CODE, 'user-2')).toBe('PARTICIPANT');
    });

    it('updates participant role', () => {
      manager.addParticipant(ROOM_CODE, participant);
      manager.updateParticipantRole(ROOM_CODE, 'user-2', 'MODERATOR');
      expect(manager.getParticipantRole(ROOM_CODE, 'user-2')).toBe('MODERATOR');
    });

    it('removes a participant', () => {
      manager.addParticipant(ROOM_CODE, participant);
      manager.removeParticipant(ROOM_CODE, 'user-2');
      expect(manager.getParticipant(ROOM_CODE, 'user-2')).toBeUndefined();
    });

    it('returns null role for unknown user', () => {
      expect(manager.getParticipantRole(ROOM_CODE, 'unknown-user')).toBeNull();
    });
  });
});
