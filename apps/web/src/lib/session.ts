/**
 * Session storage utilities
 *
 * Persists the session token and user identity in sessionStorage.
 * Using sessionStorage (not localStorage) means the session is cleared
 * when the tab is closed — appropriate for guest sessions.
 */

import { SessionTokenPayload } from '@watchparty/types';

const SESSION_KEY = 'watchparty_session';

export interface StoredSession {
  token: string;
  userId: string;
  roomId: string;
  roomCode: string;
  displayName: string;
}

export function saveSession(session: StoredSession): void {
  if (typeof window === 'undefined') return;
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

export function loadSession(): StoredSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as StoredSession;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  if (typeof window === 'undefined') return;
  sessionStorage.removeItem(SESSION_KEY);
}

export function hasSession(roomCode?: string): boolean {
  const session = loadSession();
  if (!session) return false;
  if (roomCode && session.roomCode !== roomCode) return false;
  return true;
}
