'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { loadSession, saveSession } from '@/lib/session';

export default function JoinPage() {
  const params = useParams<{ code: string }>();
  const router = useRouter();
  const roomCode = (params.code ?? '').toUpperCase();

  /* ── Always dark on the join page ── */
  useEffect(() => {
    const prev = document.documentElement.getAttribute('data-theme');
    document.documentElement.setAttribute('data-theme', 'dark');
    return () => {
      if (prev) document.documentElement.setAttribute('data-theme', prev);
      else document.documentElement.removeAttribute('data-theme');
    };
  }, []);

  const [roomInfo, setRoomInfo] = useState<{ title: string; onlineCount: number } | null>(null);
  const [roomError, setRoomError] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState('');

  useEffect(() => {
    const existing = loadSession();
    if (existing?.roomCode === roomCode) { router.replace(`/room/${roomCode}`); return; }
    if (!/^[A-Z0-9]{8}$/.test(roomCode)) { setRoomError('Invalid room code format.'); return; }
    api.getRoom(roomCode)
      .then((info) => {
        if (info.isClosed) setRoomError('This room has been closed by the host.');
        else setRoomInfo({ title: info.title, onlineCount: info.onlineCount });
      })
      .catch(() => setRoomError('Room not found. The invite link may be expired.'));
  }, [roomCode, router]);

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = displayName.trim();
    if (!name) { setJoinError('Please enter a display name.'); return; }
    setJoining(true); setJoinError('');
    try {
      const res = await api.joinRoom({ roomCode, displayName: name });
      saveSession({ token: res.sessionToken, userId: res.userId, roomId: res.room.id, roomCode: res.room.code, displayName: res.displayName });
      router.push(`/room/${roomCode}`);
    } catch (err) {
      setJoinError(err instanceof ApiError ? err.message : 'Failed to join. Please try again.');
      setJoining(false);
    }
  };

  // ── Error state ─────────────────────────────────────────────────────────────
  if (roomError) return (
    <Screen>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 56, marginBottom: 16 }}>🔒</div>
        <h2 style={{ fontSize: 22, fontWeight: 800, marginBottom: 10, letterSpacing: '-0.03em' }}>
          Can&apos;t join this room
        </h2>
        <p style={{ fontSize: 14, color: 'var(--color-text-2)', marginBottom: 28, lineHeight: 1.6 }}>
          {roomError}
        </p>
        <button className="btn btn-primary btn-sm" onClick={() => router.push('/')}>
          ← Back to Home
        </button>
      </div>
    </Screen>
  );

  // ── Loading state ───────────────────────────────────────────────────────────
  if (!roomInfo) return (
    <Screen>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
        <div className="spinner" style={{ width: 36, height: 36 }} />
        <p style={{ color: 'var(--color-text-3)', fontSize: 13 }}>Loading room…</p>
      </div>
    </Screen>
  );

  // ── Join form ────────────────────────────────────────────────────────────────
  return (
    <Screen>
      <div className="glass-elevated animate-scale-in" style={{
        width: '100%', maxWidth: 420,
        borderRadius: 'var(--radius-xl)', overflow: 'hidden',
      }}>
        {/* Top accent bar */}
        <div style={{
          height: 3,
          background: 'linear-gradient(90deg, #009688, #4dffea, #7ffff6)',
        }} />

        <div style={{ padding: '32px 32px 28px' }}>
          {/* Logo */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 28 }}>
            <img
              src="/logo.png"
              alt="WatchParty"
              width={34}
              height={34}
              style={{ borderRadius: 10, objectFit: 'cover', display: 'block', boxShadow: '0 4px 14px rgba(0, 196, 180,0.4)' }}
            />
            <span style={{ fontWeight: 900, fontSize: 17, letterSpacing: '-0.04em' }}>
              Watch<span style={{ color: 'var(--color-brand-light)' }}>Party</span>
            </span>
          </div>

          {/* Invite header */}
          <div style={{ marginBottom: 24 }}>
            <p style={{
              fontSize: 11, fontWeight: 700, letterSpacing: '0.08em',
              textTransform: 'uppercase', color: 'var(--color-text-3)', marginBottom: 6,
            }}>
              You&apos;ve been invited to
            </p>
            <h1 style={{
              fontSize: 26, fontWeight: 900, letterSpacing: '-0.03em',
              lineHeight: 1.15, marginBottom: 12,
            }}>
              {roomInfo.title}
            </h1>

            {/* Room meta row */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <div style={{
                  width: 7, height: 7, borderRadius: '50%',
                  background: 'var(--color-success)',
                  boxShadow: '0 0 0 0 rgba(52,211,153,0.5)',
                  animation: 'pulse-ring 2s infinite',
                }} />
                <span style={{ fontSize: 12, color: 'var(--color-text-2)', fontWeight: 500 }}>
                  {roomInfo.onlineCount} {roomInfo.onlineCount === 1 ? 'person' : 'people'} watching
                </span>
              </div>

              <span style={{
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 11, fontWeight: 700,
                color: 'var(--color-brand-light)',
                background: 'rgba(77, 255, 234,0.1)',
                border: '1px solid rgba(77, 255, 234,0.2)',
                borderRadius: 6, padding: '2px 8px',
                letterSpacing: '0.12em',
              }}>
                {roomCode}
              </span>
            </div>
          </div>

          {/* Divider */}
          <div style={{ height: 1, background: 'var(--color-border)', marginBottom: 24 }} />

          {/* Form */}
          <form onSubmit={handleJoin} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <label style={{
                display: 'block', fontSize: 11, fontWeight: 700,
                letterSpacing: '0.07em', textTransform: 'uppercase',
                color: 'var(--color-text-2)', marginBottom: 8,
              }}>
                Pick a display name
              </label>
              <input
                id="input-display-name"
                className="input"
                placeholder="Your name…"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                maxLength={32}
                autoFocus
                required
                style={{ fontSize: 15 }}
              />
            </div>

            {joinError && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '10px 14px',
                background: 'rgba(248,113,113,0.08)',
                border: '1px solid rgba(248,113,113,0.2)',
                borderRadius: 'var(--radius-md)',
                color: 'var(--color-error)', fontSize: 13,
              }}>
                <span>⚠</span> {joinError}
              </div>
            )}

            <button id="btn-join-room" type="submit" className="btn btn-primary btn-lg"
              disabled={joining} style={{ width: '100%', marginTop: 4 }}>
              {joining
                ? <><span className="spinner" style={{ width: 18, height: 18 }} /> Joining…</>
                : <>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M5 12h14M12 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Join the Room
                </>
              }
            </button>
          </form>

          <button className="btn btn-ghost btn-sm"
            style={{ width: '100%', marginTop: 12, color: 'var(--color-text-3)' }}
            onClick={() => router.push('/')}>
            ← Back to Home
          </button>
        </div>
      </div>
    </Screen>
  );
}

// ── layout wrapper ───────────────────────────────────────────────────────────
function Screen({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      minHeight: '100vh', background: 'var(--color-bg)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24, position: 'relative', overflow: 'hidden',
    }}>
      <div className="orb orb-1" />
      <div className="orb orb-2" />
      <div className="bg-grid" style={{ position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none' }} />
      <div style={{ position: 'relative', zIndex: 1, width: '100%', display: 'flex', justifyContent: 'center' }}>
        {children}
      </div>
    </div>
  );
}
