'use client';

import { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { api, ApiError } from '@/lib/api';
import { saveSession } from '@/lib/session';

/* ─── helpers ─────────────────────────────────────────────────────────── */
const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
function extractVideoId(input: string): string | undefined {
  if (!input.trim()) return undefined;
  const t = input.trim();
  if (VIDEO_ID_RE.test(t)) return t;
  try {
    const u = new URL(t);
    const h = u.hostname.replace(/^www\./, '');
    if (h === 'youtube.com' || h === 'm.youtube.com') {
      if (u.pathname === '/watch') { const v = u.searchParams.get('v'); if (v && VIDEO_ID_RE.test(v)) return v; }
      const m = u.pathname.match(/^\/(?:embed|shorts|v)\/([a-zA-Z0-9_-]{11})/);
      if (m) return m[1];
    }
    if (h === 'youtu.be') { const id = u.pathname.slice(1).split('?')[0]; if (id && VIDEO_ID_RE.test(id)) return id; }
  } catch { /**/ }
  return undefined;
}

/* ─── avatar colors ───────────────────────────────────────────────────── */
const AVATAR_COLORS = ['#7c3aed', '#0891b2', '#059669', '#b45309', '#be185d'];
function avatarColor(name: string) { return AVATAR_COLORS[(name.charCodeAt(0) ?? 0) % AVATAR_COLORS.length]; }

/* ─── feature data — matches reference image bottom strip ─────────────── */
const FEATURES = [
  {
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
      </svg>
    ),
    label: 'Real-time sync',
    sub: 'Play, pause, seek together',
  },
  {
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
      </svg>
    ),
    label: 'Host controls',
    sub: 'Keep everyone in sync',
  },
  {
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
      </svg>
    ),
    label: 'Live chat',
    sub: 'React and discuss',
  },
  {
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
      </svg>
    ),
    label: 'Invite links',
    sub: 'Bring your friends',
  },
] as const;

/* ─── chat messages for hero card ─────────────────────────────────────── */
const DEMO_CHAT = [
  { name: 'Rahul', time: '12:30 PM', msg: 'This video is amazing! 🔥' },
  { name: 'Priya', time: '12:31 PM', msg: 'Agreed! The visuals are next level ✨' },
  { name: 'Sam', time: '12:32 PM', msg: "Let's watch the next one after this?" },
] as const;

const DEMO_AVATARS = ['Rahul', 'Priya', 'Sam', 'Alex'] as const;

/* ─── modal helpers ───────────────────────────────────────────────────── */
function ModalField({ label, hint, required, children }: {
  label: string; hint?: string; required?: boolean; children: React.ReactNode;
}) {
  return (
    <div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.4)', marginBottom: 8 }}>
        {label}
        {required && <span style={{ color: '#a78bfa' }}>*</span>}
        {hint && <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'rgba(255,255,255,0.25)' }}>({hint})</span>}
      </label>
      {children}
    </div>
  );
}

function ErrBox({ msg }: { msg: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.18)', borderRadius: 10, color: '#f87171', fontSize: 13, lineHeight: 1.4 }}>
      <span style={{ flexShrink: 0 }}>⚠</span> {msg}
    </div>
  );
}

function FooterLink({ label }: { label: string }) {
  return (
    <span
      style={{ fontSize: 13, color: 'rgba(255,255,255,0.35)', cursor: 'default', transition: 'color 0.14s', display: 'inline-block' }}
      onMouseEnter={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.7)')}
      onMouseLeave={e => (e.currentTarget.style.color = 'rgba(255,255,255,0.35)')}>
      {label}
    </span>
  );
}

/* ─── hero card — matches reference mockup ─────────────────────────────── */
function HeroCard() {
  return (
    <div style={{ position: 'relative', width: '100%', maxWidth: 500 }}>
      {/* Card */}
      <div style={{
        background: '#131316',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 20,
        overflow: 'hidden',
        boxShadow: '0 32px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(124,58,237,0.1)',
      }}>
        {/* ── status bar ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#34d399', boxShadow: '0 0 8px rgba(52,211,153,0.7)', animation: 'pulse-ring 2s infinite', flexShrink: 0 }} />
          <span style={{ fontSize: 12, fontWeight: 700, color: '#e2e2e6' }}>Live Room</span>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* viewer count */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.4)" strokeWidth="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75" strokeLinecap="round" /></svg>
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', fontWeight: 500 }}>4 watching</span>
            </div>
            {/* avatar stack */}
            <div style={{ display: 'flex' }}>
              {DEMO_AVATARS.slice(0, 3).map((name, i) => (
                <div key={name} style={{ width: 26, height: 26, borderRadius: '50%', background: avatarColor(name), border: '2px solid #131316', marginLeft: i > 0 ? -7 : 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 800, color: '#fff', zIndex: 3 - i, position: 'relative' }}>
                  {name[0]}
                </div>
              ))}
              <div style={{ width: 26, height: 26, borderRadius: '50%', background: 'rgba(255,255,255,0.1)', border: '2px solid #131316', marginLeft: -7, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, color: 'rgba(255,255,255,0.6)' }}>+</div>
            </div>
            {/* more options */}
            <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.3)', display: 'flex', padding: 2 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></svg>
            </button>
          </div>
        </div>

        {/* ── video frame — city night skyline like reference ── */}
        <div style={{ position: 'relative', aspectRatio: '16/9', background: 'linear-gradient(180deg,#1a1035 0%,#0d1a2e 35%,#0a1520 60%,#060c12 100%)', overflow: 'hidden' }}>
          {/* Sky */}
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg,#1e1040 0%,#0c1830 45%,#04090e 100%)' }} />
          {/* Moon */}
          <div style={{ position: 'absolute', top: '12%', right: '22%', width: 28, height: 28, borderRadius: '50%', background: 'radial-gradient(circle at 38% 38%, #fff8e1 0%, #f0d080 60%, #c8a840 100%)', boxShadow: '0 0 20px rgba(240,210,80,0.5), 0 0 60px rgba(240,210,80,0.15)' }} />
          {/* Stars */}
          {[...Array(24)].map((_, i) => (
            <div key={i} style={{ position: 'absolute', width: i % 4 === 0 ? 2 : 1, height: i % 4 === 0 ? 2 : 1, borderRadius: '50%', background: '#fff', top: `${4 + (i * 13) % 38}%`, left: `${(i * 19 + 5) % 98}%`, opacity: 0.3 + (i % 3) * 0.2 }} />
          ))}
          {/* City silhouette — more detailed like reference */}
          <svg style={{ position: 'absolute', bottom: '22%', left: 0, width: '100%' }} viewBox="0 0 500 80" xmlns="http://www.w3.org/2000/svg">
            <path d="M0 80V45l15-0v-18h6v-8h4v8h6V45h10V32h5V20h8V32h5V28h4v-15h3v15h4V28h10V42h8V30h6V18h4v12h4V18h6V30h8V42h6V35h5V20h6V35h5V38h8V25h7V38h5V30h12V42h8V35h6V45h8V40h5V50h7V42h10V80Z" fill="#04090e" />
            {/* Building windows lit up */}
            {[
              [38, 35], [38, 41], [44, 35], [44, 41],
              [75, 25], [75, 31], [81, 25], [81, 31],
              [130, 22], [136, 22], [130, 28],
              [175, 25], [181, 25], [175, 31],
              [235, 30], [241, 30], [247, 30],
              [295, 26], [295, 32], [301, 26],
              [360, 28], [366, 28], [372, 28],
              [415, 33], [421, 33], [427, 33],
            ].map(([x, y], i) => (
              <rect key={i} x={x} y={y} width="3" height="2" fill={`rgba(${[255, 240, 220, 200][i % 4]},${[210, 190, 170, 240][i % 4]},${[100, 120, 80, 60][i % 4]},0.7)`} rx="0.5" />
            ))}
          </svg>
          {/* Ground/water reflection */}
          <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: '24%', background: 'linear-gradient(180deg,rgba(10,20,40,0.6) 0%,#04090e 100%)' }} />
          {/* Water shimmer */}
          <div style={{ position: 'absolute', bottom: '2%', left: '20%', right: '20%', height: 1, background: 'linear-gradient(90deg, transparent, rgba(180,160,255,0.2), rgba(255,200,100,0.15), transparent)' }} />

          {/* Play button */}
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'rgba(124,58,237,0.85)', backdropFilter: 'blur(8px)', border: '1.5px solid rgba(255,255,255,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 6px 24px rgba(109,40,217,0.5)', cursor: 'pointer' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21" /></svg>
            </div>
          </div>

          {/* Progress bar + controls */}
          <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: '4px 14px 10px', background: 'linear-gradient(transparent, rgba(0,0,0,0.85))' }}>
            {/* Progress */}
            <div style={{ height: 3, background: 'rgba(255,255,255,0.15)', borderRadius: 99, overflow: 'hidden', marginBottom: 8, position: 'relative' }}>
              <div style={{ width: '27%', height: '100%', background: '#7c3aed', borderRadius: 99, position: 'relative' }}>
                <div style={{ position: 'absolute', right: -4, top: -2.5, width: 8, height: 8, borderRadius: '50%', background: '#a78bfa', boxShadow: '0 0 6px rgba(167,139,250,0.8)' }} />
              </div>
            </div>
            {/* Controls */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21" /></svg>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M15.54 8.46a5 5 0 010 7.07" strokeLinecap="round" /></svg>
              <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.55)', fontFamily: 'JetBrains Mono,monospace', letterSpacing: '0.04em' }}>12:34 / 45:20</span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                {[
                  <svg key="cc" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.45)" strokeWidth="2"><rect x="2" y="7" width="20" height="15" rx="2" /><path d="M7 11h4M7 15h6M17 11h2M17 15h2" strokeLinecap="round" /></svg>,
                  <svg key="gear" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.45)" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M19.07 4.93a10 10 0 010 14.14M4.93 19.07a10 10 0 010-14.14" strokeLinecap="round" /></svg>,
                  <svg key="pip" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.45)" strokeWidth="2"><rect x="2" y="2" width="20" height="20" rx="2" /><rect x="12" y="12" width="8" height="8" rx="1" /></svg>,
                  <svg key="fs" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.45)" strokeWidth="2"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3" strokeLinecap="round" /></svg>,
                ].map((icon, i) => <span key={i}>{icon}</span>)}
              </div>
            </div>
          </div>
        </div>

        {/* ── In sync row ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
          <div style={{ display: 'flex' }}>
            {DEMO_AVATARS.slice(0, 3).map((name, i) => (
              <div key={name} style={{ width: 20, height: 20, borderRadius: '50%', background: avatarColor(name), border: '2px solid #131316', marginLeft: i > 0 ? -5 : 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 7, fontWeight: 800, color: '#fff' }}>{name[0]}</div>
            ))}
          </div>
          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', fontWeight: 500 }}>3 people in sync</span>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5 }}>
            {/* animated waveform */}
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1.5, height: 12 }}>
              {[4, 8, 6, 10, 5].map((h, i) => (
                <div key={i} className="wave-bar" style={{ height: h, width: 2 }} />
              ))}
            </div>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#34d399' }}>In sync</span>
          </div>
        </div>

        {/* ── Chat ── */}
        <div style={{ padding: '8px 14px 4px' }}>
          {DEMO_CHAT.map((m, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 10 }}>
              <div style={{ width: 30, height: 30, borderRadius: '50%', background: avatarColor(m.name), flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, color: '#fff' }}>{m.name[0]}</div>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 2 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: '#e2e2e6' }}>{m.name}</span>
                  <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)' }}>{m.time}</span>
                </div>
                <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.55)', margin: 0, lineHeight: 1.4 }}>{m.msg}</p>
              </div>
            </div>
          ))}
        </div>

        {/* ── Chat input ── */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 12px 12px', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
          <button style={{ width: 32, height: 32, borderRadius: 9, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 17, flexShrink: 0, color: 'rgba(255,255,255,0.35)', transition: 'color 0.14s' }}>😊</button>
          <div style={{ flex: 1, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 10, padding: '8px 13px', fontSize: 12, color: 'rgba(255,255,255,0.22)', userSelect: 'none', cursor: 'text' }}>
            Type a message...
          </div>
          <button style={{ width: 34, height: 34, borderRadius: 10, background: '#7c3aed', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0, boxShadow: '0 2px 10px rgba(124,58,237,0.45)' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5"><path d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </div>
      </div>

      {/* Ambient glow */}
      <div style={{ position: 'absolute', inset: -50, background: 'radial-gradient(ellipse at 50% 55%, rgba(124,58,237,0.18) 0%, transparent 60%)', filter: 'blur(40px)', pointerEvents: 'none', zIndex: -1 }} />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════ */
/* PAGE                                                                   */
/* ═══════════════════════════════════════════════════════════════════════ */
export default function HomePage() {
  const router = useRouter();

  const [quickInput, setQuickInput] = useState('');
  const [quickErr, setQuickErr] = useState('');
  const [modal, setModal] = useState<'none' | 'create' | 'join'>('none');

  const [createName, setCreateName] = useState('');
  const [roomTitle, setRoomTitle] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [creating, setCreating] = useState(false);
  const [createErr, setCreateErr] = useState('');

  const [joinName, setJoinName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [joining, setJoining] = useState(false);
  const [joinErr, setJoinErr] = useState('');

  const openCreate = useCallback((prefillVideo = '') => {
    setVideoUrl(prefillVideo); setCreateName(''); setRoomTitle('');
    setCreateErr(''); setCreating(false); setModal('create');
  }, []);

  const openJoin = useCallback((prefillCode = '') => {
    setJoinCode(prefillCode); setJoinName('');
    setJoinErr(''); setJoining(false); setModal('join');
  }, []);

  const closeModal = useCallback(() => {
    setModal('none'); setCreateErr(''); setJoinErr('');
    setCreating(false); setJoining(false);
  }, []);

  const handleQuickStart = () => {
    const val = quickInput.trim();
    if (!val) { setQuickErr('Paste a YouTube link or enter a room code'); return; }
    setQuickErr('');
    if (/^[A-Z0-9]{6,8}$/.test(val.toUpperCase())) openJoin(val.toUpperCase());
    else openCreate(val);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!createName.trim()) { setCreateErr('Display name is required'); return; }
    setCreating(true); setCreateErr('');
    try {
      const res = await api.createRoom({ displayName: createName.trim(), title: roomTitle.trim() || undefined, initialVideoId: extractVideoId(videoUrl) });
      saveSession({ token: res.sessionToken, userId: res.userId, roomId: res.room.id, roomCode: res.room.code, displayName: res.displayName });
      router.push(`/room/${res.room.code}`);
    } catch (err) { setCreateErr(err instanceof ApiError ? err.message : 'Failed to create room'); setCreating(false); }
  };

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = joinCode.trim().toUpperCase();
    if (!joinName.trim()) { setJoinErr('Display name is required'); return; }
    if (!code || !/^[A-Z0-9]{8}$/.test(code)) { setJoinErr('Enter a valid 8-character room code'); return; }
    setJoining(true); setJoinErr('');
    try {
      const res = await api.joinRoom({ roomCode: code, displayName: joinName.trim() });
      saveSession({ token: res.sessionToken, userId: res.userId, roomId: res.room.id, roomCode: res.room.code, displayName: res.displayName });
      router.push(`/room/${res.room.code}`);
    } catch (err) { setJoinErr(err instanceof ApiError ? err.message : 'Failed to join room'); setJoining(false); }
  };

  useEffect(() => {
    if (modal !== 'none') {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = prev; };
    }
  }, [modal]);

  /* ── theme toggle ── */
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  // Initialise from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem('wp-theme') as 'dark' | 'light' | null;
    const initial = saved ?? 'dark';
    setTheme(initial);
    document.documentElement.setAttribute('data-theme', initial);
  }, []);

  const toggleTheme = useCallback(() => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('wp-theme', next);
  }, [theme]);

  return (
    <div style={{ minHeight: '100vh', background: '#0e0e10', display: 'flex', flexDirection: 'column', overflow: 'clip', position: 'relative' }}>

      {/* ── single subtle orb — not distracting ── */}
      <div style={{ position: 'fixed', top: '-20%', left: '50%', transform: 'translateX(-50%)', width: 900, height: 600, borderRadius: '50%', background: 'radial-gradient(ellipse, rgba(109,40,217,0.12) 0%, transparent 60%)', filter: 'blur(100px)', pointerEvents: 'none', zIndex: 0 }} />
      {/* dot-grid — very faint */}
      <div style={{ position: 'fixed', inset: 0, zIndex: 0, pointerEvents: 'none', backgroundImage: 'radial-gradient(rgba(255,255,255,0.03) 1px, transparent 1px)', backgroundSize: '28px 28px' }} />

      {/* ══════════════════ NAVBAR ════════════════════════════ */}
      <nav style={{
        position: 'relative', zIndex: 20,
        display: 'flex', alignItems: 'center',
        padding: '0 48px', height: 64,
        borderBottom: '1px solid rgba(255,255,255,0.05)',
        background: 'rgba(14,14,16,0.88)',
        backdropFilter: 'blur(20px)',
      }}>
        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <Image src="/logo.png" alt="WatchParty" width={34} height={34}
            style={{ borderRadius: 9, objectFit: 'cover', display: 'block' }} priority />
          <span style={{ fontWeight: 800, fontSize: 18, letterSpacing: '-0.03em', color: '#f0f0f3' }}>
            Watch<span style={{ color: '#8b5cf6' }}>Party</span>
          </span>
        </div>

        {/* spacer — no center nav links */}
        <div style={{ flex: 1 }} />

        {/* CTA */}
        <button
          onClick={() => openCreate()}
          style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '9px 22px', background: '#7c3aed', border: 'none', borderRadius: 10, color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer', boxShadow: '0 4px 20px rgba(124,58,237,0.4)', transition: 'all 0.15s', fontFamily: 'inherit', flexShrink: 0 }}
          onMouseEnter={e => { e.currentTarget.style.background = '#8b5cf6'; e.currentTarget.style.boxShadow = '0 6px 28px rgba(124,58,237,0.55)'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = '#7c3aed'; e.currentTarget.style.boxShadow = '0 4px 20px rgba(124,58,237,0.4)'; e.currentTarget.style.transform = 'none'; }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8"><path d="M12 5v14M5 12h14" strokeLinecap="round" /></svg>
          Create room
        </button>
      </nav>

      {/* ══════════════════ HERO ══════════════════════════════ */}
      <main style={{
        position: 'relative', zIndex: 1, flex: 1,
        display: 'grid', gridTemplateColumns: '1fr 1fr',
        maxWidth: 1200, width: '100%', margin: '0 auto',
        padding: '0 48px', alignItems: 'center',
        minHeight: 'calc(100vh - 64px)', gap: 56,
      }}>

        {/* ── LEFT ──────────────────────────────────────────── */}
        <div style={{ paddingTop: 24, paddingBottom: 60 }}>

          {/* Free badge — matches reference exactly */}
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '5px 14px', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 99, marginBottom: 28 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#34d399' }} />
            <span style={{ fontSize: 12, fontWeight: 500, color: 'rgba(255,255,255,0.55)', letterSpacing: '0.01em' }}>Free &bull; No account needed</span>
          </div>

          {/* Headline — "Your people. Your videos. In sync." */}
          <h1 style={{
            fontSize: 'clamp(40px,5vw,68px)',
            fontWeight: 900,
            lineHeight: 1.04,
            letterSpacing: '-0.045em',
            margin: '0 0 24px 0',
            color: '#f0f0f3',
          }}>
            Your people.<br />
            Your videos.<br />
            <span style={{ color: '#7c3aed' }}>In sync.</span>
          </h1>

          {/* Description */}
          <p style={{ fontSize: 15, color: 'rgba(255,255,255,0.45)', lineHeight: 1.75, maxWidth: 400, marginBottom: 36 }}>
            Create a private room, share a YouTube link, and watch together in perfect real-time sync — with live chat, host controls and more. From anywhere, with anyone.
          </p>

          {/* Quick-start bar */}
          <div style={{ marginBottom: 12 }}>
            <div style={{
              display: 'flex', alignItems: 'center',
              background: '#1a1a1f',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 12,
              overflow: 'hidden',
              transition: 'border-color 0.15s, box-shadow 0.15s',
            }}
              onFocus={() => { }}
              onBlur={() => { }}>
              <svg style={{ marginLeft: 16, flexShrink: 0 }} width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" strokeLinecap="round" /></svg>
              <input
                id="input-quick-start"
                style={{ flex: 1, padding: '14px 12px', background: 'transparent', border: 'none', outline: 'none', color: '#f0f0f3', fontSize: 14, fontFamily: 'inherit' }}
                placeholder="Paste a YouTube link or enter room code..."
                value={quickInput}
                onChange={e => { setQuickInput(e.target.value); setQuickErr(''); }}
                onKeyDown={e => e.key === 'Enter' && handleQuickStart()}
              />
              <button
                id="btn-quick-start"
                onClick={handleQuickStart}
                style={{ margin: 6, padding: '10px 22px', background: '#7c3aed', border: 'none', borderRadius: 9, color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 7, whiteSpace: 'nowrap', fontFamily: 'inherit', transition: 'background 0.15s', flexShrink: 0 }}
                onMouseEnter={e => e.currentTarget.style.background = '#8b5cf6'}
                onMouseLeave={e => e.currentTarget.style.background = '#7c3aed'}>
                Start watching
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14M12 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
            </div>
            {quickErr && <p style={{ fontSize: 12, color: '#f87171', marginTop: 6, paddingLeft: 4 }}>{quickErr}</p>}
          </div>

          {/* "or" divider */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
            <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.06)' }} />
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.22)' }}>or</span>
            <div style={{ flex: 1, height: 1, background: 'rgba(255,255,255,0.06)' }} />
          </div>

          {/* CTA pair — exactly like reference */}
          <div style={{ display: 'flex', gap: 10, marginBottom: 44 }}>
            <button
              id="btn-create-room-hero"
              onClick={() => openCreate()}
              style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '14px 20px', background: '#7c3aed', border: 'none', borderRadius: 11, color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', boxShadow: '0 4px 22px rgba(124,58,237,0.38)', transition: 'all 0.15s', position: 'relative', overflow: 'hidden' }}
              onMouseEnter={e => { e.currentTarget.style.background = '#8b5cf6'; e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 8px 32px rgba(124,58,237,0.52)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = '#7c3aed'; e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = '0 4px 22px rgba(124,58,237,0.38)'; }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12h14" strokeLinecap="round" /></svg>
              Create a room
            </button>
            <button
              id="btn-join-room-hero"
              onClick={() => openJoin()}
              style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '14px 20px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 11, color: 'rgba(255,255,255,0.8)', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.15s' }}
              onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.1)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.18)'; e.currentTarget.style.color = '#fff'; e.currentTarget.style.transform = 'translateY(-2px)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; e.currentTarget.style.color = 'rgba(255,255,255,0.8)'; e.currentTarget.style.transform = 'none'; }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>
              Join with code
            </button>
          </div>

          {/* Feature strip — 4 items, horizontal, matches reference */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 0, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 24 }}>
            {FEATURES.map((f, i) => (
              <div key={f.label} style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingRight: i < 3 ? 16 : 0, borderRight: i < 3 ? '1px solid rgba(255,255,255,0.06)' : 'none', paddingLeft: i > 0 ? 16 : 0 }}>
                <div style={{ color: '#7c3aed', marginBottom: 2 }}>{f.icon}</div>
                <span style={{ fontSize: 12, fontWeight: 700, color: 'rgba(255,255,255,0.8)', letterSpacing: '-0.01em' }}>{f.label}</span>
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', lineHeight: 1.4 }}>{f.sub}</span>
              </div>
            ))}
          </div>
        </div>

        {/* ── RIGHT: hero card ───────────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', paddingTop: 60, paddingBottom: 60 }}>
          <HeroCard />
        </div>
      </main>

      {/* ══════════════════ FOOTER ════════════════════════════ */}
      <footer style={{ position: 'relative', zIndex: 10, flexShrink: 0, borderTop: '1px solid rgba(255,255,255,0.05)', background: 'rgba(10,10,12,0.8)', backdropFilter: 'blur(16px)' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto', padding: '36px 48px 28px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr 1fr 1fr', gap: 40, marginBottom: 36 }}>
            {/* Brand */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 14 }}>
                <div style={{ width: 28, height: 28, borderRadius: 8, background: 'linear-gradient(135deg,#7c3aed,#6d28d9)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21" /></svg>
                </div>
                <span style={{ fontWeight: 800, fontSize: 16, letterSpacing: '-0.03em', color: '#f0f0f3' }}>
                  Watch<span style={{ color: '#8b5cf6' }}>Party</span>
                </span>
              </div>
              <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.35)', lineHeight: 1.75, maxWidth: 250, marginBottom: 18 }}>
                Watch YouTube videos in perfect sync with friends. No accounts, no downloads — just a link.
              </p>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '5px 12px', background: 'rgba(52,211,153,0.07)', border: '1px solid rgba(52,211,153,0.15)', borderRadius: 99 }}>
                <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#34d399', animation: 'pulse-ring 2s infinite' }} />
                <span style={{ fontSize: 11, fontWeight: 600, color: '#34d399' }}>All systems operational</span>
              </div>
            </div>
            {/* Product */}
            <div>
              <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.22)', marginBottom: 14 }}>Product</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {['Create a Room', 'Join with Code', 'How It Works', 'Invite a Friend'].map(l => <FooterLink key={l} label={l} />)}
              </div>
            </div>
            {/* Features */}
            <div>
              <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.22)', marginBottom: 14 }}>Features</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {['Real-time Sync', 'Host Controls', 'Moderator Roles', 'Request System', 'Live Chat'].map(l => <FooterLink key={l} label={l} />)}
              </div>
            </div>
            {/* Tech stack */}
            <div>
              <p style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.22)', marginBottom: 14 }}>Built With</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {['Next.js', 'Socket.IO', 'TypeScript', 'Prisma', 'PostgreSQL', 'Neon DB', 'Express', 'Zod'].map(t => (
                  <span key={t} style={{ fontSize: 11, fontWeight: 500, color: 'rgba(255,255,255,0.4)', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 6, padding: '3px 9px' }}>{t}</span>
                ))}
              </div>
            </div>
          </div>
          <div style={{ height: 1, background: 'rgba(255,255,255,0.05)', marginBottom: 20 }} />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.2)', margin: 0 }}>
              © {new Date().getFullYear()} WatchParty. Built for internship. All rights reserved.
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.15)' }}>Made with ♥ for watching together</span>
              {[
                { href: 'https://github.com', icon: <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" /></svg> },
                { href: 'https://twitter.com', icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.747l7.73-8.835L1.254 2.25H8.08l4.264 5.638L18.244 2.25zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77z" /></svg> },
              ].map(({ href, icon }) => (
                <a key={href} href={href} target="_blank" rel="noopener noreferrer"
                  style={{ width: 30, height: 30, borderRadius: 8, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.35)', transition: 'all 0.15s', textDecoration: 'none' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLAnchorElement).style.color = '#fff'; (e.currentTarget as HTMLAnchorElement).style.borderColor = 'rgba(255,255,255,0.15)'; (e.currentTarget as HTMLAnchorElement).style.background = 'rgba(255,255,255,0.08)'; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLAnchorElement).style.color = 'rgba(255,255,255,0.35)'; (e.currentTarget as HTMLAnchorElement).style.borderColor = 'rgba(255,255,255,0.07)'; (e.currentTarget as HTMLAnchorElement).style.background = 'rgba(255,255,255,0.04)'; }}>
                  {icon}
                </a>
              ))}
            </div>
          </div>
        </div>
      </footer>

      {/* ══════════════════ CREATE MODAL ══════════════════════ */}
      {modal === 'create' && (
        <div className="modal-portal" role="dialog" aria-modal="true" aria-label="Create a Room">
          <div className="overlay-bg" onClick={closeModal} />
          <div className="modal-panel glass-elevated" onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
              <div style={{ width: 44, height: 44, borderRadius: 12, background: 'linear-gradient(135deg,#7c3aed,#6d28d9)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5"><path d="M12 5v14M5 12h14" strokeLinecap="round" /></svg>
              </div>
              <div>
                <h2 style={{ fontSize: 18, fontWeight: 800, letterSpacing: '-0.03em' }}>Create a Room</h2>
                <p style={{ fontSize: 12, color: 'var(--color-text-3)', marginTop: 2 }}>You&apos;ll be the Host with full controls</p>
              </div>
            </div>
            <form id="form-create-room" onSubmit={handleCreate} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <ModalField label="Your Display Name" required>
                <input id="input-create-name" className="input" placeholder="e.g. Alex" value={createName} onChange={e => setCreateName(e.target.value)} maxLength={32} autoFocus autoComplete="off" />
              </ModalField>
              <ModalField label="Room Title" hint="optional">
                <input id="input-room-title" className="input" placeholder="Friday Night Movies" value={roomTitle} onChange={e => setRoomTitle(e.target.value)} maxLength={100} autoComplete="off" />
              </ModalField>
              <ModalField label="First Video" hint="optional">
                <input id="input-video-url" className="input" placeholder="YouTube URL or video ID…" value={videoUrl} onChange={e => setVideoUrl(e.target.value)} autoComplete="off" />
                <p style={{ fontSize: 11, color: 'var(--color-text-3)', marginTop: 5 }}>Supports youtube.com/watch, youtu.be, Shorts, and bare video IDs</p>
              </ModalField>
              {createErr && <ErrBox msg={createErr} />}
              <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
                <button id="btn-create-room" type="submit" className="btn btn-primary" disabled={creating} style={{ flex: 1, justifyContent: 'center' }}>
                  {creating ? <><span className="spinner" style={{ width: 16, height: 16 }} /> Creating…</> : <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12h14" strokeLinecap="round" /></svg>Create Room</>}
                </button>
                <button type="button" className="btn btn-ghost" onClick={closeModal} style={{ paddingLeft: 16, paddingRight: 16 }}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ══════════════════ JOIN MODAL ════════════════════════ */}
      {modal === 'join' && (
        <div className="modal-portal" role="dialog" aria-modal="true" aria-label="Join a Room">
          <div className="overlay-bg" onClick={closeModal} />
          <div className="modal-panel glass-elevated" onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
              <div style={{ width: 44, height: 44, borderRadius: 12, background: 'rgba(124,58,237,0.12)', border: '1px solid rgba(124,58,237,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2.5"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>
              </div>
              <div>
                <h2 style={{ fontSize: 18, fontWeight: 800, letterSpacing: '-0.03em' }}>Join a Room</h2>
                <p style={{ fontSize: 12, color: 'var(--color-text-3)', marginTop: 2 }}>Enter the 8-character room code</p>
              </div>
            </div>
            <form id="form-join-room" onSubmit={handleJoin} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <ModalField label="Display Name" required>
                <input id="input-join-name" className="input" placeholder="e.g. Jordan" value={joinName} onChange={e => setJoinName(e.target.value)} maxLength={32} autoFocus autoComplete="off" />
              </ModalField>
              <ModalField label="Room Code" required>
                <input id="input-room-code" className="input font-mono" placeholder="AB12CD34" value={joinCode}
                  onChange={e => setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8))}
                  maxLength={8} autoComplete="off"
                  style={{ letterSpacing: '0.2em', fontSize: 20, textAlign: 'center', fontWeight: 800 }} />
                {joinCode.length > 0 && joinCode.length < 8 && <p style={{ fontSize: 11, color: 'var(--color-text-3)', marginTop: 5 }}>{8 - joinCode.length} more character{8 - joinCode.length !== 1 ? 's' : ''} needed</p>}
                {joinCode.length === 8 && <p style={{ fontSize: 11, color: 'var(--color-success)', marginTop: 5 }}>✓ Valid room code format</p>}
              </ModalField>
              {joinErr && <ErrBox msg={joinErr} />}
              <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
                <button id="btn-join-room" type="submit" className="btn btn-primary" disabled={joining} style={{ flex: 1, justifyContent: 'center' }}>
                  {joining ? <><span className="spinner" style={{ width: 16, height: 16 }} /> Joining…</> : <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M5 12h14M12 5l7 7-7 7" strokeLinecap="round" strokeLinejoin="round" /></svg>Join Room</>}
                </button>
                <button type="button" className="btn btn-ghost" onClick={closeModal} style={{ paddingLeft: 16, paddingRight: 16 }}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
