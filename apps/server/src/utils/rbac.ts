/**
 * Role-based Access Control (RBAC) Engine
 *
 * Single source of truth for permission rules.
 * Pure functions — no database calls, no side effects.
 * Tested in: src/utils/rbac.test.ts
 *
 * Design decision: The Role is NEVER read from the JWT.
 * All RBAC checks on the backend use the role fetched from
 * the database (RoomParticipant.role) or from the in-memory
 * RoomStateManager, never from socket.data.session.
 */

import { Role, PlaybackAction } from '@watchparty/types';

export type ProtectedAction =
  | 'play'
  | 'pause'
  | 'seek'
  | 'change_video'
  | 'request_playback_action'
  | 'resolve_playback_request'
  | 'assign_role'
  | 'remove_participant'
  | 'close_room';

const PERMISSION_MAP: Record<ProtectedAction, Role[]> = {
  play: ['HOST', 'MODERATOR'],
  pause: ['HOST', 'MODERATOR'],
  seek: ['HOST', 'MODERATOR'],
  change_video: ['HOST', 'MODERATOR'],
  request_playback_action: ['HOST', 'MODERATOR', 'PARTICIPANT'],
  resolve_playback_request: ['HOST', 'MODERATOR'],
  assign_role: ['HOST'],
  remove_participant: ['HOST'],
  close_room: ['HOST'],
};

/**
 * Returns true if the given role is allowed to perform the given action.
 */
export function canPerformAction(role: Role, action: ProtectedAction): boolean {
  return PERMISSION_MAP[action].includes(role);
}

/**
 * Returns true if the role can directly control playback
 * (without needing to submit a request).
 */
export function canControlPlayback(role: Role): boolean {
  return role === 'HOST' || role === 'MODERATOR';
}

/**
 * Returns true if the role can resolve (approve/reject) playback requests.
 */
export function canResolveRequests(role: Role): boolean {
  return role === 'HOST' || role === 'MODERATOR';
}

/**
 * Returns true if the given target role can be assigned by the assigner.
 *
 * Rules:
 * - Only HOST can assign roles
 * - HOST cannot be assigned via assign_role (only via room creation or explicit transfer)
 * - Valid assignments: PARTICIPANT→MODERATOR, MODERATOR→PARTICIPANT
 */
export function canAssignRole(
  assignerRole: Role,
  targetCurrentRole: Role,
  newRole: Role,
): boolean {
  if (assignerRole !== 'HOST') return false;
  if (newRole === 'HOST') return false; // HOST cannot be assigned via this event
  if (targetCurrentRole === 'HOST') return false; // Cannot reassign the Host's role
  return true;
}

/**
 * Validates a PlaybackAction for a given role.
 * Participants must submit requests; only HOST/MODERATOR can act directly.
 */
export function validatePlaybackAction(
  role: Role,
  action: PlaybackAction,
): { allowed: boolean; requiresRequest: boolean } {
  if (role === 'HOST' || role === 'MODERATOR') {
    return { allowed: true, requiresRequest: false };
  }
  // Participants must go through the request workflow
  return { allowed: true, requiresRequest: true };
}
