/**
 * Zod Schema Validation Unit Tests
 * Verifies that all socket event payloads are validated at runtime.
 */

import { describe, it, expect } from 'vitest';
import {
  JoinRoomPayloadSchema,
  PlayPayloadSchema,
  PausePayloadSchema,
  SeekPayloadSchema,
  ChangeVideoPayloadSchema,
  RequestPlaybackActionPayloadSchema,
  ResolvePlaybackRequestPayloadSchema,
  AssignRolePayloadSchema,
  RemoveParticipantPayloadSchema,
} from '@watchparty/types';

describe('JoinRoomPayloadSchema', () => {
  it('accepts a valid room code', () => {
    expect(JoinRoomPayloadSchema.safeParse({ roomCode: 'AB12CD34' }).success).toBe(true);
  });
  it('rejects lowercase room codes', () => {
    expect(JoinRoomPayloadSchema.safeParse({ roomCode: 'ab12cd34' }).success).toBe(false);
  });
  it('rejects codes that are not 8 chars', () => {
    expect(JoinRoomPayloadSchema.safeParse({ roomCode: 'ABCD' }).success).toBe(false);
  });
  it('rejects missing roomCode', () => {
    expect(JoinRoomPayloadSchema.safeParse({}).success).toBe(false);
  });
});

describe('PlayPayloadSchema', () => {
  it('accepts valid position', () => {
    expect(PlayPayloadSchema.safeParse({ positionSeconds: 120.5 }).success).toBe(true);
  });
  it('accepts position 0', () => {
    expect(PlayPayloadSchema.safeParse({ positionSeconds: 0 }).success).toBe(true);
  });
  it('rejects negative position', () => {
    expect(PlayPayloadSchema.safeParse({ positionSeconds: -1 }).success).toBe(false);
  });
  it('rejects position > 24 hours', () => {
    expect(PlayPayloadSchema.safeParse({ positionSeconds: 86401 }).success).toBe(false);
  });
  it('rejects non-numeric position', () => {
    expect(PlayPayloadSchema.safeParse({ positionSeconds: '120' }).success).toBe(false);
  });
});

describe('SeekPayloadSchema', () => {
  it('accepts valid seek target', () => {
    expect(SeekPayloadSchema.safeParse({ targetPositionSeconds: 300 }).success).toBe(true);
  });
  it('rejects negative seek', () => {
    expect(SeekPayloadSchema.safeParse({ targetPositionSeconds: -10 }).success).toBe(false);
  });
});

describe('ChangeVideoPayloadSchema', () => {
  it('accepts a URL string', () => {
    expect(ChangeVideoPayloadSchema.safeParse({ videoUrlOrId: 'https://www.youtube.com/watch?v=abc' }).success).toBe(true);
  });
  it('rejects empty string', () => {
    expect(ChangeVideoPayloadSchema.safeParse({ videoUrlOrId: '' }).success).toBe(false);
  });
});

describe('RequestPlaybackActionPayloadSchema', () => {
  it('accepts SEEK with position', () => {
    expect(RequestPlaybackActionPayloadSchema.safeParse({
      action: 'SEEK',
      targetPositionSeconds: 60,
    }).success).toBe(true);
  });
  it('accepts CHANGE_VIDEO with URL', () => {
    expect(RequestPlaybackActionPayloadSchema.safeParse({
      action: 'CHANGE_VIDEO',
      videoUrlOrId: 'https://youtu.be/dQw4w9WgXcQ',
    }).success).toBe(true);
  });
  it('rejects invalid action', () => {
    expect(RequestPlaybackActionPayloadSchema.safeParse({
      action: 'REWIND',
    }).success).toBe(false);
  });
  it('rejects note over 200 chars', () => {
    expect(RequestPlaybackActionPayloadSchema.safeParse({
      action: 'PLAY',
      note: 'a'.repeat(201),
    }).success).toBe(false);
  });
});

describe('ResolvePlaybackRequestPayloadSchema', () => {
  it('accepts APPROVED decision', () => {
    expect(ResolvePlaybackRequestPayloadSchema.safeParse({
      requestId: 'clxxx1234567890abcdefghij',
      decision: 'APPROVED',
    }).success).toBe(true);
  });
  it('accepts REJECTED with reason', () => {
    expect(ResolvePlaybackRequestPayloadSchema.safeParse({
      requestId: 'clxxx1234567890abcdefghij',
      decision: 'REJECTED',
      reason: 'Not appropriate',
    }).success).toBe(true);
  });
  it('rejects invalid decision', () => {
    expect(ResolvePlaybackRequestPayloadSchema.safeParse({
      requestId: 'clxxx1234567890abcdefghij',
      decision: 'PENDING',
    }).success).toBe(false);
  });
  it('rejects missing requestId', () => {
    expect(ResolvePlaybackRequestPayloadSchema.safeParse({
      decision: 'APPROVED',
    }).success).toBe(false);
  });
});

describe('AssignRolePayloadSchema', () => {
  it('accepts MODERATOR assignment', () => {
    expect(AssignRolePayloadSchema.safeParse({
      targetUserId: 'clxxx1234567890abcdefghij',
      newRole: 'MODERATOR',
    }).success).toBe(true);
  });
  it('rejects HOST assignment (not allowed via this event)', () => {
    expect(AssignRolePayloadSchema.safeParse({
      targetUserId: 'clxxx1234567890abcdefghij',
      newRole: 'HOST',
    }).success).toBe(false);
  });
});

describe('RemoveParticipantPayloadSchema', () => {
  it('accepts valid removal without ban', () => {
    expect(RemoveParticipantPayloadSchema.safeParse({
      targetUserId: 'clxxx1234567890abcdefghij',
    }).success).toBe(true);
  });
  it('accepts removal with ban: true', () => {
    expect(RemoveParticipantPayloadSchema.safeParse({
      targetUserId: 'clxxx1234567890abcdefghij',
      ban: true,
    }).success).toBe(true);
  });
  it('rejects missing targetUserId', () => {
    expect(RemoveParticipantPayloadSchema.safeParse({}).success).toBe(false);
  });
});
