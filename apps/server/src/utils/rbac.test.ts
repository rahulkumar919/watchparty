/**
 * Unit tests: RBAC permission rules
 * Run: npm run test --workspace=apps/server
 */

import { describe, it, expect } from 'vitest';
import { canPerformAction, canAssignRole, canControlPlayback, canResolveRequests } from '../utils/rbac';
import type { Role } from '@watchparty/types';

const ROLES: Role[] = ['HOST', 'MODERATOR', 'PARTICIPANT'];

describe('canPerformAction', () => {
  describe('play', () => {
    it('allows HOST and MODERATOR', () => {
      expect(canPerformAction('HOST', 'play')).toBe(true);
      expect(canPerformAction('MODERATOR', 'play')).toBe(true);
    });
    it('forbids PARTICIPANT', () => {
      expect(canPerformAction('PARTICIPANT', 'play')).toBe(false);
    });
  });

  describe('pause', () => {
    it('allows HOST and MODERATOR', () => {
      expect(canPerformAction('HOST', 'pause')).toBe(true);
      expect(canPerformAction('MODERATOR', 'pause')).toBe(true);
    });
    it('forbids PARTICIPANT', () => {
      expect(canPerformAction('PARTICIPANT', 'pause')).toBe(false);
    });
  });

  describe('seek', () => {
    it('allows HOST and MODERATOR', () => {
      expect(canPerformAction('HOST', 'seek')).toBe(true);
      expect(canPerformAction('MODERATOR', 'seek')).toBe(true);
    });
    it('forbids PARTICIPANT', () => {
      expect(canPerformAction('PARTICIPANT', 'seek')).toBe(false);
    });
  });

  describe('change_video', () => {
    it('allows HOST and MODERATOR', () => {
      expect(canPerformAction('HOST', 'change_video')).toBe(true);
      expect(canPerformAction('MODERATOR', 'change_video')).toBe(true);
    });
    it('forbids PARTICIPANT', () => {
      expect(canPerformAction('PARTICIPANT', 'change_video')).toBe(false);
    });
  });

  describe('request_playback_action', () => {
    it('allows all roles', () => {
      for (const role of ROLES) {
        expect(canPerformAction(role, 'request_playback_action')).toBe(true);
      }
    });
  });

  describe('resolve_playback_request', () => {
    it('allows HOST and MODERATOR', () => {
      expect(canPerformAction('HOST', 'resolve_playback_request')).toBe(true);
      expect(canPerformAction('MODERATOR', 'resolve_playback_request')).toBe(true);
    });
    it('forbids PARTICIPANT', () => {
      expect(canPerformAction('PARTICIPANT', 'resolve_playback_request')).toBe(false);
    });
  });

  describe('assign_role', () => {
    it('allows only HOST', () => {
      expect(canPerformAction('HOST', 'assign_role')).toBe(true);
      expect(canPerformAction('MODERATOR', 'assign_role')).toBe(false);
      expect(canPerformAction('PARTICIPANT', 'assign_role')).toBe(false);
    });
  });

  describe('remove_participant', () => {
    it('allows only HOST', () => {
      expect(canPerformAction('HOST', 'remove_participant')).toBe(true);
      expect(canPerformAction('MODERATOR', 'remove_participant')).toBe(false);
      expect(canPerformAction('PARTICIPANT', 'remove_participant')).toBe(false);
    });
  });
});

describe('canAssignRole', () => {
  it('HOST can promote PARTICIPANT to MODERATOR', () => {
    expect(canAssignRole('HOST', 'PARTICIPANT', 'MODERATOR')).toBe(true);
  });

  it('HOST can demote MODERATOR to PARTICIPANT', () => {
    expect(canAssignRole('HOST', 'MODERATOR', 'PARTICIPANT')).toBe(true);
  });

  it('HOST cannot assign HOST role', () => {
    expect(canAssignRole('HOST', 'PARTICIPANT', 'HOST')).toBe(false);
  });

  it('HOST cannot change another HOST role', () => {
    expect(canAssignRole('HOST', 'HOST', 'MODERATOR')).toBe(false);
  });

  it('MODERATOR cannot assign any roles', () => {
    expect(canAssignRole('MODERATOR', 'PARTICIPANT', 'MODERATOR')).toBe(false);
  });

  it('PARTICIPANT cannot assign any roles', () => {
    expect(canAssignRole('PARTICIPANT', 'PARTICIPANT', 'MODERATOR')).toBe(false);
  });
});

describe('canControlPlayback', () => {
  it('returns true for HOST and MODERATOR', () => {
    expect(canControlPlayback('HOST')).toBe(true);
    expect(canControlPlayback('MODERATOR')).toBe(true);
  });
  it('returns false for PARTICIPANT', () => {
    expect(canControlPlayback('PARTICIPANT')).toBe(false);
  });
});

describe('canResolveRequests', () => {
  it('returns true for HOST and MODERATOR', () => {
    expect(canResolveRequests('HOST')).toBe(true);
    expect(canResolveRequests('MODERATOR')).toBe(true);
  });
  it('returns false for PARTICIPANT', () => {
    expect(canResolveRequests('PARTICIPANT')).toBe(false);
  });
});
