'use client';

export const dynamic = 'force-dynamic';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Image from 'next/image';
import { useSocket } from '@/hooks/useSocket';
import { useRoomState } from '@/hooks/useRoomState';
import { useChat } from '@/hooks/useChat';
import { useYouTubePlayer } from '@/hooks/useYouTubePlayer';
import { useDriftCorrection } from '@/hooks/useDriftCorrection';
import { loadSession, clearSession } from '@/lib/session';
import type { Role, PlaybackRequestDTO, SocketResponse, SyncStatePayload, ParticipantDTO, PlaybackUpdatedPayload, ChatMessageDTO } from '@watchparty/types';

/* ── helpers ─────────────────────────────────────────────────────────────── */
function formatTime(s: number) {
  const t = Math.max(0, Math.floor(s));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}
function roleBadge(r: Role) {
  return r === 'HOST' ? 'badge badge-host' : r === 'MODERATOR' ? 'badge badge-moderator' : 'badge badge-participant';
}
function roleLabel(r: Role) { return r === 'HOST' ? '👑 Host' : r === 'MODERATOR' ? '🛡 Mod' : 'Viewer'; }
function avatarBg(name: string) {
  const p = ['#9333ea', '#0891b2', '#d97706', '#be185d', '#047857', '#7c3aed', '#0369a1', '#b45309'];
  return p[(name.charCodeAt(0) ?? 0) % p.length];
}
function canControl(r?: Role) { return r === 'HOST' || r === 'MODERATOR'; }

/* ── SVG icon atoms ─────────────────────────────────────────────────────── */
const IconPlay = ({ size = 14, color = 'white' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
    <polygon points="5,3 19,12 5,21" />
  </svg>
);
const IconPause = ({ size = 14, color = 'currentColor' }: { size?: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
    <rect x="5" y="3" width="4" height="18" rx="1" />
    <rect x="15" y="3" width="4" height="18" rx="1" />
  </svg>
);
const IconVolume = ({ muted, size = 14 }: { muted: boolean; size?: number }) => muted
  ? <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" /></svg>
  : <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M15.54 8.46a5 5 0 010 7.07" strokeLinecap="round" /><path d="M19.07 4.93a10 10 0 010 14.14" strokeLinecap="round" /></svg>;

interface Toast { id: number; message: string; type: 'info' | 'success' | 'error' | 'warning'; }
let _tid = 0;

/* ── in-flight guard ────────────────────────────────────────────────────── *
 * Returns a wrapper that blocks duplicate calls while one is already pending.
 * Usage:  const guard = useInFlight();
 *         guard('assign:uid', () => socket.emit(..., cb))
 * The key is released automatically when the wrapped callback is invoked.
 */
function useInFlight() {
  const inFlight = useRef<Set<string>>(new Set());
  return useCallback(<T,>(key: string, fn: (done: () => void) => T): T | undefined => {
    if (inFlight.current.has(key)) return undefined;
    inFlight.current.add(key);
    const done = () => inFlight.current.delete(key);
    return fn(done);
  }, []);
}

/* ══════════════════════════════════════════════════════════════════════════ */
export default function RoomPage() {
  const params = useParams<{ code: string }>();
  const router = useRouter();
  const roomCode = (params.code ?? '').toUpperCase();

  /* ── Always render the room in dark mode regardless of home page theme ── */
  useEffect(() => {
    const prev = document.documentElement.getAttribute('data-theme');
    document.documentElement.setAttribute('data-theme', 'dark');
    return () => {
      // Restore whatever theme was active when the user came from the home page
      if (prev) document.documentElement.setAttribute('data-theme', prev);
      else document.documentElement.removeAttribute('data-theme');
    };
  }, []);

  const [session, setSession] = useState<ReturnType<typeof loadSession>>(null);
  useEffect(() => {
    const s = loadSession();
    if (!s || s.roomCode !== roomCode) { router.replace(`/join/${roomCode}`); return; }
    setSession(s);
  }, [roomCode, router]);

  const { socket, status: connStatus } = useSocket(session?.token ?? null);
  const { state, dispatch, computeCurrentPosition } = useRoomState(socket);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const joinedRef = useRef(false);

  useEffect(() => {
    if (!socket || !session || joinedRef.current || connStatus !== 'connected') return;
    joinedRef.current = true; setLoadError(null);
    const tid = setTimeout(() => { if (!state.isLoaded) setLoadError('Server did not respond. Please retry.'); }, 10_000);
    socket.emit('join_room', { roomCode }, (res: SocketResponse<SyncStatePayload>) => {
      clearTimeout(tid);
      if (!res.success) { setLoadError(res.error?.message ?? 'Failed to join.'); return; }
      if (res.data && !state.isLoaded) dispatch({ type: 'SYNC_STATE', payload: res.data });
      if (res.data?.recentMessages && !chatHistorySeededRef.current) {
        chatHistorySeededRef.current = true;
        setInitialChatMessages(res.data.recentMessages);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, connStatus, session, roomCode, retryCount]);

  useEffect(() => {
    if (connStatus === 'disconnected' || connStatus === 'error') {
      joinedRef.current = false;
      chatHistorySeededRef.current = false;
    }
  }, [connStatus]);

  const [toasts, setToasts] = useState<Toast[]>([]);
  const addToast = useCallback((message: string, type: Toast['type'] = 'info') => {
    const id = ++_tid;
    setToasts(p => [...p, { id, message, type }]);
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 4000);
  }, []);

  const videoId = state.playback?.videoId ?? '';
  const myRole = state.currentUser?.role;

  const { controls, isMuted, playerState } = useYouTubePlayer('yt-player', videoId, {
    onPlay: useCallback((pos: number) => {
      console.log('[RoomPage] onPlay callback fired, role:', myRole, 'pos:', pos);
      if (!socket || !canControl(myRole)) {
        console.log('[RoomPage] Ignoring play - no permission');
        return;
      }
      console.log('[RoomPage] Emitting play event to server');
      socket.emit('play', { positionSeconds: pos });
    }, [socket, myRole]),
    onPause: useCallback((pos: number) => {
      console.log('[RoomPage] onPause callback fired, role:', myRole, 'pos:', pos);
      if (!socket || !canControl(myRole)) {
        console.log('[RoomPage] Ignoring pause - no permission');
        return;
      }
      console.log('[RoomPage] Emitting pause event to server');
      socket.emit('pause', { positionSeconds: pos });
    }, [socket, myRole]),
    onSeek: useCallback((pos: number) => {
      console.log('[RoomPage] onSeek callback fired, role:', myRole, 'pos:', pos);
      if (!socket || !canControl(myRole)) {
        console.log('[RoomPage] Ignoring seek - no permission');
        return;
      }
      console.log('[RoomPage] Emitting seek event to server');
      socket.emit('seek', { targetPositionSeconds: pos });
    }, [socket, myRole]),
    onReady: useCallback(() => {
      console.log('[RoomPage] YouTube player ready');
    }, []),
    onError: useCallback((code: number) => {
      console.error('[RoomPage] YouTube player error:', code);
      addToast(`Player error (${code})`, 'error');
    }, [addToast]),
  });

  const lastVer = useRef(-1);
  const driftControl = useDriftCorrection(socket, state.playback, controls);

  useEffect(() => {
    if (!state.playback) return;
    if (state.playback.stateVersion <= lastVer.current) return;

    console.log('[RoomPage] Playback state updated, version:', state.playback.stateVersion, 'status:', state.playback.status);
    lastVer.current = state.playback.stateVersion;
    const t = computeCurrentPosition();

    if (state.playback.status === 'PLAYING') {
      // Check if position is already close enough to avoid redundant seek
      const currentPos = controls.getCurrentTime();
      console.log('[RoomPage] Applying PLAY state - target:', t, 'current:', currentPos);
      if (Math.abs(currentPos - t) < 0.5) {
        controls.play(); // Just play, no seek
      } else {
        controls.play(t);
      }
      driftControl.notifyRemoteUpdate();
    } else {
      console.log('[RoomPage] Applying PAUSE state - position:', state.playback.anchorPositionSeconds);
      controls.pause();
      controls.seekTo(state.playback.anchorPositionSeconds);
      driftControl.notifyRemoteUpdate();
    }
  }, [state.playback, controls, computeCurrentPosition, driftControl]);

  const [showBanner, setShowBanner] = useState(true);

  const [initialChatMessages, setInitialChatMessages] = useState<ChatMessageDTO[]>([]);
  const chatHistorySeededRef = useRef(false);

  const [sideTab, setSideTab] = useState<'chat' | 'people' | 'requests'>('people');
  const [chatInput, setChatInput] = useState('');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const { messages: chatMessages, sendMessage, sending: chatSending,
    sendError: chatSendError, setSendError: setChatSendError,
    scrollRef: chatScrollRef, onScroll: onChatScroll,
  } = useChat(socket, { initialMessages: initialChatMessages });

  const [showVideoInput, setShowVideoInput] = useState(false);
  const [videoInput, setVideoInput] = useState('');
  const [showReqModal, setShowReqModal] = useState(false);
  const [reqAction, setReqAction] = useState<'PLAY' | 'PAUSE' | 'SEEK' | 'CHANGE_VIDEO'>('PLAY');
  const [reqNote, setReqNote] = useState('');
  const [reqVideoUrl, setReqVideoUrl] = useState('');
  const [showInvite, setShowInvite] = useState(false);

  /* user context-menu: show inline popover on the participant row */
  const [menuUserId, setMenuUserId] = useState<string | null>(null);

  /* ── in-flight guard: blocks duplicate socket calls while one is pending ── */
  const guard = useInFlight();

  useEffect(() => {
    if (!socket) return;
    socket.on('user_joined', (p: ParticipantDTO) => addToast(`${p.displayName} joined`, 'info'));
    socket.on('user_left', (p: { userId: string; displayName: string; reason?: 'left' | 'disconnected' }) => addToast(`${p.displayName} left`, 'info'));
    socket.on('role_assigned', (p: { userId: string; displayName: string; newRole: Role; updatedByUserId: string; updatedByDisplayName: string }) => addToast(`${p.displayName} is now ${p.newRole}`, 'info'));
    socket.on('participant_removed', (p: { userId: string; displayName: string; isBanned: boolean; removedByDisplayName: string }) => addToast(`${p.displayName} was ${p.isBanned ? 'banned' : 'kicked'}`, 'warning'));
    socket.on('host_transferred', (p: { previousHostUserId: string; previousHostDisplayName: string; newHostUserId: string; newHostDisplayName: string }) => addToast(`👑 ${p.newHostDisplayName} is now Host`, 'info'));
    socket.on('error_notification', (e: { code: string; message: string }) => addToast(e.message, 'error'));
    socket.on('playback_request_resolved', (p: { requestId: string; status: 'APPROVED' | 'REJECTED'; resolvedByDisplayName: string; actionApplied: boolean; rejectionReason?: string }) => {
      if (p.status === 'APPROVED') addToast('Request approved ✓', 'success');
      else addToast(`Request rejected${p.rejectionReason ? `: ${p.rejectionReason}` : ''}`, 'warning');
    });
    return () => {
      socket.off('user_joined'); socket.off('user_left'); socket.off('role_assigned');
      socket.off('participant_removed'); socket.off('host_transferred');
      socket.off('error_notification'); socket.off('playback_request_resolved');
    };
  }, [socket, addToast]);

  const handleLeave = useCallback(() => { socket?.emit('leave_room'); clearSession(); router.push('/'); }, [socket, router]);

  const handleChangeVideo = useCallback(() => {
    if (!socket || !videoInput.trim()) return;
    guard('change_video', done => {
      socket.emit('change_video', { videoUrlOrId: videoInput.trim() }, (res: SocketResponse<{ videoId: string }>) => {
        done();
        if (res.success) { addToast('Video changed', 'success'); setVideoInput(''); setShowVideoInput(false); }
        else addToast(res.error?.message ?? 'Failed', 'error');
      });
    });
  }, [socket, videoInput, addToast, guard]);

  const handleSubmitRequest = useCallback(() => {
    if (!socket) return;
    guard('submit_request', done => {
      socket.emit('request_playback_action', {
        action: reqAction, note: reqNote.trim() || undefined,
        targetPositionSeconds: reqAction === 'SEEK' ? computeCurrentPosition() : undefined,
        videoUrlOrId: reqAction === 'CHANGE_VIDEO' ? reqVideoUrl.trim() || undefined : undefined,
      }, (res: SocketResponse<PlaybackRequestDTO>) => {
        done();
        if (res.success) { addToast('Request sent', 'success'); setShowReqModal(false); setReqNote(''); setReqVideoUrl(''); }
        else addToast(res.error?.message ?? 'Failed', 'error');
      });
    });
  }, [socket, reqAction, reqNote, reqVideoUrl, computeCurrentPosition, addToast, guard]);

  const handleResolve = useCallback((id: string, decision: 'APPROVED' | 'REJECTED') => {
    guard(`resolve:${id}`, done => {
      socket?.emit('resolve_playback_request', { requestId: id, decision }, (res: SocketResponse) => {
        done();
        if (!res.success) addToast(res.error?.message ?? 'Failed', 'error');
      });
    });
  }, [socket, addToast, guard]);

  const handleAssignRole = useCallback((uid: string, newRole: 'MODERATOR' | 'PARTICIPANT') => {
    guard(`assign:${uid}`, done => {
      socket?.emit('assign_role', { targetUserId: uid, newRole }, (res: SocketResponse) => {
        done();
        if (res.success) { setMenuUserId(null); addToast('Role updated', 'success'); }
        else addToast(res.error?.message ?? 'Failed', 'error');
      });
    });
  }, [socket, addToast, guard]);

  const handleKick = useCallback((uid: string, ban: boolean) => {
    guard(`kick:${uid}`, done => {
      socket?.emit('remove_participant', { targetUserId: uid, ban }, (res: SocketResponse) => {
        done();
        if (res.success) { setMenuUserId(null); addToast(ban ? 'User banned' : 'User kicked', 'success'); }
        else addToast(res.error?.message ?? 'Failed', 'error');
      });
    });
  }, [socket, addToast, guard]);

  const handleTransferHost = useCallback((uid: string) => {
    guard(`transfer:${uid}`, done => {
      socket?.emit('transfer_host', { targetUserId: uid }, (res: SocketResponse) => {
        done();
        if (res.success) { setMenuUserId(null); addToast('Host transferred', 'success'); }
        else addToast(res.error?.message ?? 'Failed', 'error');
      });
    });
  }, [socket, addToast, guard]);

  if (!session) return null;

  /* ── Loading / Error ─────────────────────────────────────────────────── */
  if (!state.isLoaded) {
    const isErr = connStatus === 'error' || loadError !== null;
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, background: 'var(--color-bg)', padding: '0 24px' }}>
        {isErr ? (
          <>
            <div style={{ fontSize: 40 }}>⚠️</div>
            <p style={{ color: 'var(--color-error)', fontSize: 15, fontWeight: 600, textAlign: 'center' }}>{loadError ?? 'Could not connect.'}</p>
            <div style={{ display: 'flex', gap: 10 }}>
              <button className="btn btn-primary btn-sm" onClick={() => { setLoadError(null); joinedRef.current = false; setRetryCount(c => c + 1); }}>↺ Retry</button>
              <button className="btn btn-ghost btn-sm" onClick={() => { clearSession(); router.replace('/'); }}>← Home</button>
            </div>
          </>
        ) : (
          <>
            <div className="spinner" style={{ width: 36, height: 36 }} />
            <p style={{ color: 'var(--color-text-3)', fontSize: 13 }}>{connStatus === 'connecting' ? 'Connecting…' : 'Joining room…'}</p>
          </>
        )}
      </div>
    );
  }

  const onlineCount = state.participants.filter(p => p.isOnline).length;
  const pendingCount = state.pendingRequests.length;
  const isPlaying = state.playback?.status === 'PLAYING';
  const pos = computeCurrentPosition();
  const inviteUrl = typeof window !== 'undefined' ? `${window.location.origin}/join/${roomCode}` : '';
  const displayName = session.displayName ?? 'You';

  /* ── RENDER ──────────────────────────────────────────────────────────── */
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--color-bg)', overflow: 'hidden' }}>

      {/* ══ TOP BAR ═════════════════════════════════════════════════════ */}
      <header style={{
        height: 56, flexShrink: 0,
        display: 'flex', alignItems: 'center', gap: 10, padding: '0 18px',
        background: 'rgba(10,10,14,0.97)',
        borderBottom: '1px solid var(--color-border)',
        backdropFilter: 'blur(16px)',
        zIndex: 40,
      }}>
        {/* ── LEFT: logo + name + code ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          {/* Logo */}
          <div style={{ flexShrink: 0 }}>
            <Image src="/logo.png" alt="WatchParty" width={32} height={32}
              style={{ borderRadius: 9, objectFit: 'cover', display: 'block' }} />
          </div>

          {/* User avatar + name chip */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '4px 12px 4px 6px', background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', borderRadius: 99, flexShrink: 0 }}>
            <div style={{ width: 22, height: 22, borderRadius: '50%', background: avatarBg(displayName), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 800, color: '#fff', flexShrink: 0 }}>
              {displayName[0]?.toUpperCase()}
            </div>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text)', letterSpacing: '-0.02em' }}>{displayName}</span>
          </div>

          {/* Room code chip */}
          <button id="btn-copy-code"
            onClick={() => { navigator.clipboard.writeText(roomCode); addToast('Copied!', 'success'); }}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 11px', background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', borderRadius: 99, cursor: 'pointer', transition: 'all 0.15s', outline: 'none' }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--color-brand)'; e.currentTarget.style.background = 'rgba(124,58,237,0.08)'; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--color-border)'; e.currentTarget.style.background = 'var(--color-surface-2)'; }}>
            <span style={{ fontSize: 12, fontWeight: 800, fontFamily: 'JetBrains Mono,monospace', color: 'var(--color-brand-light)', letterSpacing: '0.12em' }}>{roomCode}</span>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-3)" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
          </button>
        </div>

        {/* ── CENTER: room title, viewer count ── */}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, minWidth: 0 }}>
          <h1 style={{ fontSize: 17, fontWeight: 800, letterSpacing: '-0.035em', color: 'var(--color-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 340, margin: 0 }}>
            {state.roomTitle || `${displayName}'s Watch Party`}
          </h1>
          {/* Viewer avatars + count */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0 }}>
            <div style={{ display: 'flex' }}>
              {state.participants.filter(p => p.isOnline).slice(0, 4).map((p, i) => (
                <div key={p.userId} title={p.displayName} style={{ width: 24, height: 24, borderRadius: '50%', background: avatarBg(p.displayName), border: '2px solid #0a0a0e', marginLeft: i > 0 ? -7 : 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 800, color: '#fff', cursor: 'default' }}>
                  {p.displayName[0]?.toUpperCase()}
                </div>
              ))}
            </div>
            <span style={{ fontSize: 12, color: 'var(--color-text-3)', fontWeight: 500 }}>{onlineCount} watching</span>
          </div>
          {/* Live + sync pill */}
          {isPlaying && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 10px', background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.2)', borderRadius: 99, flexShrink: 0 }}>
              <div style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--color-success)', animation: 'pulse-ring 2s infinite' }} />
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-success)' }}>In sync</span>
            </div>
          )}
        </div>

        {/* ── RIGHT: live dot + role + share + leave ── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          {/* Connection status */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 10px', background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', borderRadius: 99 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: connStatus === 'connected' ? 'var(--color-success)' : connStatus === 'connecting' ? 'var(--color-warning)' : 'var(--color-error)', animation: connStatus === 'connected' ? 'pulse-ring 2s infinite' : 'none', flexShrink: 0 }} />
            <span style={{ fontSize: 11, fontWeight: 600, color: connStatus === 'connected' ? 'var(--color-success)' : 'var(--color-text-3)' }}>
              {connStatus === 'connected' ? 'Live' : connStatus === 'connecting' ? 'Connecting…' : 'Offline'}
            </span>
          </div>

          {/* Role badge */}
          {myRole && <span className={roleBadge(myRole)} style={{ fontSize: 10, padding: '3px 10px' }}>{roleLabel(myRole)}</span>}

          {/* Share button */}
          <button id="btn-invite" onClick={() => setShowInvite(true)}
            style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 18px', background: 'linear-gradient(135deg,#ef4444,#dc2626)', border: 'none', borderRadius: 9, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', boxShadow: '0 2px 12px rgba(239,68,68,0.35)', transition: 'all 0.15s', letterSpacing: '-0.01em', outline: 'none' }}
            onMouseEnter={e => { e.currentTarget.style.boxShadow = '0 4px 22px rgba(239,68,68,0.55)'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
            onMouseLeave={e => { e.currentTarget.style.boxShadow = '0 2px 12px rgba(239,68,68,0.35)'; e.currentTarget.style.transform = 'none'; }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="M8.59 13.51l6.83 3.98M15.41 6.51l-6.82 3.98" /></svg>
            Share
          </button>

          {/* Leave button — same style as Share */}
          <button id="btn-leave-room" onClick={handleLeave}
            style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 18px', background: 'linear-gradient(135deg,#ef4444,#dc2626)', border: 'none', borderRadius: 9, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', boxShadow: '0 2px 12px rgba(239,68,68,0.35)', transition: 'all 0.15s', letterSpacing: '-0.01em', outline: 'none' }}
            onMouseEnter={e => { e.currentTarget.style.boxShadow = '0 4px 22px rgba(239,68,68,0.55)'; e.currentTarget.style.transform = 'translateY(-1px)'; }}
            onMouseLeave={e => { e.currentTarget.style.boxShadow = '0 2px 12px rgba(239,68,68,0.35)'; e.currentTarget.style.transform = 'none'; }}>
            Leave
          </button>
        </div>
      </header>

      {/* ══ MAIN AREA ═══════════════════════════════════════════════════ */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* ── VIDEO COLUMN ──────────────────────────────────────────────── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'auto' }}>

          {/* Mute banner */}
          {showBanner && isMuted && state.isLoaded && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 16px', background: 'rgba(124,58,237,0.08)', borderBottom: '1px solid rgba(124,58,237,0.18)', cursor: 'pointer' }}
              onClick={() => { controls.unMute(); setShowBanner(false); }}>
              <IconVolume muted size={15} />
              <span style={{ fontSize: 12, fontWeight: 500 }}>Video muted (browser policy) — click to unmute and sync</span>
              <button id="btn-unmute" className="btn btn-primary btn-sm" style={{ marginLeft: 'auto', flexShrink: 0 }}
                onClick={e => { e.stopPropagation(); controls.unMute(); setShowBanner(false); }}>
                Unmute
              </button>
            </div>
          )}

          {/* Video area */}
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: '#000' }}>
            <div style={{ position: 'relative', width: '100%', flex: 1, minHeight: 0 }}>
              {/* Always render the player container so YouTube IFrame API can find it */}
              <div id="yt-player" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
              {playerState === 'buffering' && (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, background: 'rgba(0,0,0,0.7)', zIndex: 10, pointerEvents: 'none' }}>
                  <div className="spinner" style={{ width: 36, height: 36 }} />
                  <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>Buffering…</span>
                </div>
              )}
              {/* Overlay: shown when no video is loaded */}
              {!videoId && (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 40, background: '#000', zIndex: 5 }}>
                  <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--color-text)', letterSpacing: '-0.03em', textAlign: 'center' }}>Nothing playing yet</div>
                  <p style={{ fontSize: 14, color: 'var(--color-text-3)', textAlign: 'center', maxWidth: 360, lineHeight: 1.6 }}>
                    Paste a YouTube link to start. Everyone in the room will see it at the same moment.
                  </p>
                  {canControl(myRole) && (
                    <div style={{ display: 'flex', alignItems: 'center', background: 'rgba(255,255,255,0.05)', border: '1.5px solid rgba(255,255,255,0.1)', borderRadius: 12, overflow: 'hidden', width: '100%', maxWidth: 480 }}>
                      <svg style={{ marginLeft: 14, flexShrink: 0 }} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-3)" strokeWidth="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" /></svg>
                      <input id="input-video-url-empty" className="input" placeholder="YouTube URL or video ID…"
                        value={videoInput} onChange={e => setVideoInput(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && handleChangeVideo()}
                        style={{ flex: 1, background: 'transparent', border: 'none', fontSize: 14, padding: '12px 12px' }} />
                      <button id="btn-set-video-empty" onClick={handleChangeVideo}
                        style={{ margin: 5, padding: '8px 18px', background: 'linear-gradient(135deg,#9333ea,#6d28d9)', border: 'none', borderRadius: 8, color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', flexShrink: 0 }}>
                        Play
                      </button>
                    </div>
                  )}
                  {!canControl(myRole) && (
                    <p style={{ fontSize: 13, color: 'var(--color-text-3)' }}>Waiting for the host to add a video…</p>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* ── BOTTOM CONTROLS BAR ── */}
          <div style={{ flexShrink: 0, background: 'rgba(10,10,14,0.97)', borderTop: '1px solid var(--color-border)', padding: '10px 20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>

              {/* Video info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--color-text-3)' }}>
                  {state.playback?.videoId ? `▶ ${state.playback.videoId}` : 'No video loaded'}
                </div>
              </div>

              {/* Playback controls */}
              {canControl(myRole) ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                  {/* Play */}
                  <button id="btn-play"
                    title="Play"
                    disabled={isPlaying}
                    onClick={() => guard('play', done => {
                      socket?.emit('play', { positionSeconds: controls.getCurrentTime() }, () => done());
                    })}
                    style={{ width: 38, height: 38, borderRadius: '50%', border: 'none', cursor: isPlaying ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.15s', flexShrink: 0, background: isPlaying ? 'var(--color-surface-3)' : 'linear-gradient(135deg,#9333ea,#6d28d9)', opacity: isPlaying ? 0.4 : 1, boxShadow: isPlaying ? 'none' : '0 2px 12px rgba(109,40,217,0.45)' }}>
                    <IconPlay size={14} color="white" />
                  </button>

                  {/* Pause */}
                  <button id="btn-pause"
                    title="Pause"
                    disabled={!isPlaying}
                    onClick={() => guard('pause', done => {
                      socket?.emit('pause', { positionSeconds: controls.getCurrentTime() }, () => done());
                    })}
                    style={{ width: 38, height: 38, borderRadius: '50%', border: '1.5px solid var(--color-border)', cursor: !isPlaying ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.15s', flexShrink: 0, background: isPlaying ? 'var(--color-surface-3)' : 'var(--color-surface-2)', opacity: !isPlaying ? 0.35 : 1, color: 'var(--color-text)' }}>
                    <IconPause size={14} />
                  </button>

                  {/* Volume */}
                  <button id="btn-mute-toggle"
                    title={isMuted ? 'Unmute' : 'Mute'}
                    onClick={() => isMuted ? controls.unMute() : controls.mute()}
                    style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--color-surface-2)', border: '1.5px solid var(--color-border)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.15s', flexShrink: 0, color: isMuted ? 'var(--color-error)' : 'var(--color-text-2)' }}>
                    <IconVolume muted={isMuted} size={14} />
                  </button>

                  {/* Time */}
                  <span style={{ fontSize: 12, fontFamily: 'JetBrains Mono,monospace', color: 'var(--color-text-2)', minWidth: 44, textAlign: 'center' }}>{formatTime(pos)}</span>

                  {/* Change video */}
                  <button id="btn-change-video" className="btn btn-secondary btn-sm" style={{ gap: 6 }}
                    onClick={() => setShowVideoInput(v => !v)}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></svg>
                    Change
                  </button>
                </div>
              ) : (
                /* Viewer controls */
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
                  <button id="btn-mute-toggle"
                    onClick={() => isMuted ? controls.unMute() : controls.mute()}
                    style={{ width: 36, height: 36, borderRadius: '50%', background: 'var(--color-surface-2)', border: '1.5px solid var(--color-border)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: isMuted ? 'var(--color-error)' : 'var(--color-text-2)' }}>
                    <IconVolume muted={isMuted} size={14} />
                  </button>
                  <span style={{ fontSize: 12, fontFamily: 'JetBrains Mono,monospace', color: 'var(--color-text-2)' }}>{formatTime(pos)}</span>
                  <span style={{ fontSize: 11, color: 'var(--color-text-4)', padding: '3px 8px', background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', borderRadius: 99 }}>Controlled by host</span>
                  <button id="btn-request-action" className="btn btn-secondary btn-sm" style={{ gap: 5 }}
                    onClick={() => { setReqVideoUrl(''); setShowReqModal(true); }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 01-3.46 0" strokeLinecap="round" /></svg>
                    Request
                  </button>
                </div>
              )}
            </div>

            {/* Inline video input */}
            {showVideoInput && canControl(myRole) && (
              <div className="animate-slide-down" style={{ display: 'flex', gap: 7, marginTop: 10 }}>
                <input id="input-video-url" className="input" placeholder="YouTube URL or video ID…"
                  value={videoInput} onChange={e => setVideoInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleChangeVideo()}
                  autoFocus style={{ flex: 1, fontSize: 13 }} />
                <button id="btn-set-video" className="btn btn-primary btn-sm" onClick={handleChangeVideo}>Set</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setShowVideoInput(false)}>✕</button>
              </div>
            )}
          </div>
        </div>

        {/* ── SIDEBAR ──────────────────────────────────────────────────── */}
        <div className="room-side-panel" style={{ width: 340, flexShrink: 0, display: 'flex', flexDirection: 'column', borderLeft: '1px solid var(--color-border)', background: 'var(--color-surface)', overflow: 'hidden' }}>

          {/* Tabs */}
          <div style={{ display: 'flex', borderBottom: '1px solid var(--color-border)', flexShrink: 0 }}>
            {([
              { key: 'chat' as const, label: 'Chat', count: undefined as number | undefined },
              { key: 'people' as const, label: 'People', count: onlineCount as number | undefined },
              { key: 'requests' as const, label: 'Requests', count: (pendingCount > 0 ? pendingCount : undefined) as number | undefined },
            ]).map(tab => (
              <button key={tab.key} id={`tab-${tab.key}`} onClick={() => setSideTab(tab.key)}
                style={{ flex: 1, padding: '12px 6px', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600, color: sideTab === tab.key ? 'var(--color-text)' : 'var(--color-text-3)', borderBottom: sideTab === tab.key ? '2px solid var(--color-brand)' : '2px solid transparent', marginBottom: -1, transition: 'all var(--transition)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                {tab.label}
                {tab.count !== undefined && (
                  <span style={{ background: tab.key === 'requests' && pendingCount > 0 ? 'var(--color-brand)' : 'var(--color-surface-4)', borderRadius: 99, padding: '1px 6px', fontSize: 10, fontWeight: 700, color: tab.key === 'requests' && pendingCount > 0 ? '#fff' : 'var(--color-text-3)' }}>
                    {tab.count}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Content */}
          <div style={{ flex: 1, overflow: 'auto', padding: sideTab === 'chat' ? 0 : '10px 10px' }}>

            {/* ── CHAT TAB ── */}
            {sideTab === 'chat' && (
              <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                <div ref={chatScrollRef} onScroll={onChatScroll}
                  style={{ flex: 1, overflowY: 'auto', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {chatMessages.length === 0 ? (
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, padding: 20, minHeight: 120 }}>
                      <div style={{ width: 44, height: 44, borderRadius: 99, border: '2px solid var(--color-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.3 }}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-2)" strokeWidth="1.5"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" /></svg>
                      </div>
                      <p style={{ fontSize: 13, color: 'var(--color-text-3)', fontWeight: 500 }}>No messages yet</p>
                      <p style={{ fontSize: 12, color: 'var(--color-text-4)', textAlign: 'center' }}>Say hi to the room.</p>
                    </div>
                  ) : (
                    chatMessages.map((msg, idx) => {
                      const isMe = msg.userId === state.currentUser?.userId;
                      const prevMsg = idx > 0 ? chatMessages[idx - 1] : null;
                      const sameAuthor = prevMsg?.userId === msg.userId;
                      const timeLabel = new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                      return (
                        <div key={msg.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: sameAuthor ? 1 : 8 }}>
                          {!sameAuthor ? (
                            <div style={{ width: 26, height: 26, borderRadius: '50%', flexShrink: 0, background: avatarBg(msg.displayName), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 800, color: '#fff', marginTop: 1 }}>
                              {msg.displayName[0]?.toUpperCase()}
                            </div>
                          ) : <div style={{ width: 26, flexShrink: 0 }} />}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            {!sameAuthor && (
                              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 2 }}>
                                <span style={{ fontSize: 12, fontWeight: 700, color: isMe ? 'var(--color-brand-light)' : avatarBg(msg.displayName) }}>{isMe ? 'You' : msg.displayName}</span>
                                <span style={{ fontSize: 10, color: 'var(--color-text-4)' }}>{timeLabel}</span>
                              </div>
                            )}
                            <p style={{ fontSize: 13, lineHeight: 1.45, wordBreak: 'break-word', color: isMe ? 'var(--color-text)' : 'var(--color-text-2)', margin: 0 }}>{msg.body}</p>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
                {chatSendError && (
                  <div style={{ margin: '0 12px 6px', padding: '6px 10px', background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.2)', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ fontSize: 12, color: 'var(--color-error)' }}>⚠ {chatSendError}</span>
                    <button onClick={() => setChatSendError(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-error)', fontSize: 14, lineHeight: 1 }}>✕</button>
                  </div>
                )}
                <div style={{ padding: '8px 12px 10px', borderTop: '1px solid var(--color-border)', display: 'flex', flexDirection: 'column', gap: 0, flexShrink: 0 }}>

                  {/* ── Emoji picker panel ── */}
                  {showEmojiPicker && (
                    <div className="animate-slide-up" style={{ marginBottom: 8, background: 'var(--color-surface-3)', border: '1px solid var(--color-border)', borderRadius: 12, padding: '10px 10px 6px', boxShadow: '0 -8px 32px rgba(0,0,0,0.4)' }}>
                      {/* Category label */}
                      <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-text-4)', marginBottom: 7, paddingLeft: 2 }}>
                        Quick Reactions
                      </p>
                      {/* Emoji grid — 8 per row */}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 2, marginBottom: 6 }}>
                        {[
                          '😂', '😍', '🔥', '❤️', '👏', '😭', '🤣', '😊',
                          '🎉', '😎', '🥳', '💯', '👀', '😱', '🙌', '✨',
                          '😤', '🤔', '💀', '😴', '🫶', '🥹', '😅', '🤩',
                          '👍', '👎', '💪', '🫠', '🥲', '🤯', '😩', '🫡',
                        ].map(emoji => (
                          <button
                            key={emoji}
                            onClick={() => {
                              setChatInput(prev => prev + emoji);
                              // Don't close picker so user can pick multiple
                            }}
                            style={{ fontSize: 18, padding: '5px 2px', background: 'transparent', border: 'none', cursor: 'pointer', borderRadius: 7, lineHeight: 1, transition: 'background 0.1s', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                            onMouseEnter={e => e.currentTarget.style.background = 'var(--color-surface-4)'}
                            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                            title={emoji}
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                      {/* Second section: expressions */}
                      <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-text-4)', marginBottom: 6, paddingLeft: 2 }}>
                        Watch Party
                      </p>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 2 }}>
                        {[
                          '🎬', '🍿', '📺', '🎵', '🎶', '🎯', '🏆', '🎮',
                          '😮', '👌', '🤌', '💫', '⭐', '🌟', '💥', '🎊',
                        ].map(emoji => (
                          <button
                            key={emoji}
                            onClick={() => setChatInput(prev => prev + emoji)}
                            style={{ fontSize: 18, padding: '5px 2px', background: 'transparent', border: 'none', cursor: 'pointer', borderRadius: 7, lineHeight: 1, transition: 'background 0.1s', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                            onMouseEnter={e => e.currentTarget.style.background = 'var(--color-surface-4)'}
                            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* ── Input row ── */}
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    {/* Emoji toggle button */}
                    <button
                      title="Emoji"
                      onClick={() => setShowEmojiPicker(v => !v)}
                      style={{ width: 34, height: 34, borderRadius: 9, flexShrink: 0, border: `1px solid ${showEmojiPicker ? 'rgba(124,58,237,0.5)' : 'var(--color-border)'}`, background: showEmojiPicker ? 'rgba(124,58,237,0.12)' : 'var(--color-surface-2)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.15s', fontSize: 16 }}
                      onMouseEnter={e => { if (!showEmojiPicker) { e.currentTarget.style.borderColor = 'rgba(124,58,237,0.4)'; e.currentTarget.style.background = 'rgba(124,58,237,0.08)'; } }}
                      onMouseLeave={e => { if (!showEmojiPicker) { e.currentTarget.style.borderColor = 'var(--color-border)'; e.currentTarget.style.background = 'var(--color-surface-2)'; } }}>
                      😊
                    </button>

                    {/* Text input */}
                    <input
                      id="chat-input"
                      className="input"
                      placeholder="Message the room…"
                      value={chatInput}
                      maxLength={1000}
                      disabled={chatSending}
                      onChange={e => { setChatInput(e.target.value); if (chatSendError) setChatSendError(null); }}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          sendMessage(chatInput, () => { setChatInput(''); setShowEmojiPicker(false); });
                        }
                        if (e.key === 'Escape') setShowEmojiPicker(false);
                      }}
                      onFocus={() => setShowEmojiPicker(false)}
                      style={{ flex: 1, fontSize: 13, padding: '8px 12px' }}
                    />

                    {/* Send button */}
                    <button
                      id="btn-send-message"
                      disabled={!chatInput.trim() || chatSending}
                      onClick={() => { sendMessage(chatInput, () => { setChatInput(''); setShowEmojiPicker(false); }); }}
                      style={{ width: 34, height: 34, borderRadius: 9, flexShrink: 0, border: 'none', background: chatInput.trim() && !chatSending ? 'linear-gradient(135deg,#9333ea,#6d28d9)' : 'var(--color-surface-3)', cursor: chatInput.trim() && !chatSending ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.15s', opacity: chatSending ? 0.6 : 1, boxShadow: chatInput.trim() && !chatSending ? '0 2px 10px rgba(109,40,217,0.4)' : 'none' }}
                      aria-label="Send message">
                      {chatSending
                        ? <span className="spinner" style={{ width: 12, height: 12, borderWidth: 1.5 }} />
                        : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5"><path d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* ── PEOPLE TAB ── */}
            {sideTab === 'people' && (
              <PeoplePanel
                participants={state.participants}
                currentUserId={state.currentUser?.userId ?? ''}
                hostUserId={state.hostUserId}
                myRole={myRole}
                menuUserId={menuUserId}
                onToggleMenu={uid => setMenuUserId(prev => prev === uid ? null : uid)}
                onCloseMenu={() => setMenuUserId(null)}
                onAssignRole={handleAssignRole}
                onKick={handleKick}
                onTransferHost={handleTransferHost}
              />
            )}

            {/* ── REQUESTS TAB ── */}
            {sideTab === 'requests' && (
              <RequestsPanel requests={state.pendingRequests} myRole={myRole} onResolve={handleResolve} />
            )}
          </div>
        </div>
      </div>

      {/* ══ ROOM FOOTER BAR ══════════════════════════════════════════════
          A slim persistent strip at the very bottom of the room layout.
          Sits inside the 100vh flex column so it never overflows.
      ════════════════════════════════════════════════════════════════════ */}
      <footer style={{
        flexShrink: 0, height: 34,
        display: 'flex', alignItems: 'center',
        padding: '0 18px',
        background: 'rgba(7,7,9,0.98)',
        borderTop: '1px solid rgba(255,255,255,0.04)',
        gap: 0,
        zIndex: 30,
        overflow: 'hidden',
      }}>
        {/* Left — logo + brand */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <Image src="/logo.png" alt="WatchParty" width={16} height={16}
            style={{ borderRadius: 4, objectFit: 'cover', opacity: 0.7 }} />
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '-0.03em', color: 'rgba(255,255,255,0.3)' }}>
            Watch<span style={{ color: 'rgba(167,139,250,0.6)' }}>Party</span>
          </span>
        </div>

        {/* Dot separator */}
        <div style={{ width: 3, height: 3, borderRadius: '50%', background: 'rgba(255,255,255,0.1)', margin: '0 10px', flexShrink: 0 }} />

        {/* Center — status chips */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1 }}>
          {/* Connection */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 5, height: 5, borderRadius: '50%', background: connStatus === 'connected' ? 'var(--color-success)' : 'var(--color-warning)', flexShrink: 0 }} />
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)', fontWeight: 500 }}>
              {connStatus === 'connected' ? 'Connected' : 'Connecting…'}
            </span>
          </div>

          <div style={{ width: 1, height: 10, background: 'rgba(255,255,255,0.07)', flexShrink: 0 }} />

          {/* Room code */}
          <span style={{ fontSize: 10, fontFamily: 'JetBrains Mono,monospace', color: 'rgba(167,139,250,0.45)', fontWeight: 700, letterSpacing: '0.1em' }}>
            {roomCode}
          </span>

          <div style={{ width: 1, height: 10, background: 'rgba(255,255,255,0.07)', flexShrink: 0 }} />

          {/* Viewer count */}
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.2)', fontWeight: 500 }}>
            {onlineCount} {onlineCount === 1 ? 'viewer' : 'viewers'}
          </span>

          {/* Playing indicator */}
          {isPlaying && (
            <>
              <div style={{ width: 1, height: 10, background: 'rgba(255,255,255,0.07)', flexShrink: 0 }} />
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                {/* Mini waveform */}
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1.5, height: 10 }}>
                  {[4, 8, 6, 10, 5].map((h, i) => (
                    <div key={i} style={{ width: 2, height: h, borderRadius: 99, background: 'rgba(52,211,153,0.55)', animation: `wave-${i + 1} ${[0.9, 0.7, 1.1, 0.8, 1.0][i]}s ease-in-out infinite` }} />
                  ))}
                </div>
                <span style={{ fontSize: 10, color: 'rgba(52,211,153,0.55)', fontWeight: 600 }}>Playing</span>
              </div>
            </>
          )}
        </div>

        {/* Right — keyboard shortcut hint + copyright */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <kbd style={{ fontSize: 9, color: 'rgba(255,255,255,0.2)', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 4, padding: '1px 5px', fontFamily: 'inherit' }}>Enter</kbd>
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.15)' }}>to send</span>
          </div>
          <div style={{ width: 1, height: 10, background: 'rgba(255,255,255,0.07)', flexShrink: 0 }} />
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.12)' }}>
            © {new Date().getFullYear()} WatchParty
          </span>
        </div>
      </footer>
      {showReqModal && (
        <div className="modal-portal" role="dialog" aria-modal="true">
          <div className="overlay-bg" onClick={() => setShowReqModal(false)} />
          <div className="modal-panel glass-elevated">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
              <div style={{ width: 38, height: 38, borderRadius: 10, background: 'rgba(124,58,237,0.1)', border: '1px solid rgba(124,58,237,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}>✋</div>
              <div>
                <h2 style={{ fontSize: 16, fontWeight: 800, letterSpacing: '-0.03em' }}>Request Action</h2>
                <p style={{ fontSize: 12, color: 'var(--color-text-3)', marginTop: 1 }}>Ask the host on your behalf</p>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--color-text-2)', display: 'block', marginBottom: 7 }}>Action</label>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                  {(['PLAY', 'PAUSE', 'SEEK', 'CHANGE_VIDEO'] as const).map(a => (
                    <button key={a} id={`btn-req-${a.toLowerCase()}`}
                      className={`btn btn-sm ${reqAction === a ? 'btn-primary' : 'btn-secondary'}`}
                      onClick={() => setReqAction(a)} style={{ justifyContent: 'center' }}>
                      {a === 'PLAY' ? '▶ Play' : a === 'PAUSE' ? '⏸ Pause' : a === 'SEEK' ? '⏭ Seek' : '🎬 Video'}
                    </button>
                  ))}
                </div>
              </div>
              {reqAction === 'CHANGE_VIDEO' && (
                <div>
                  <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--color-text-2)', display: 'block', marginBottom: 7 }}>YouTube URL <span style={{ color: 'var(--color-error)' }}>*</span></label>
                  <input id="input-request-video-url" className="input" placeholder="https://youtube.com/…" value={reqVideoUrl} onChange={e => setReqVideoUrl(e.target.value)} maxLength={512} autoFocus />
                </div>
              )}
              <div>
                <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--color-text-2)', display: 'block', marginBottom: 7 }}>Note <span style={{ fontWeight: 400, textTransform: 'none', color: 'var(--color-text-3)' }}>(optional)</span></label>
                <input id="input-request-note" className="input" placeholder="e.g. Can we rewind a bit?" value={reqNote} onChange={e => setReqNote(e.target.value)} maxLength={200} />
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button id="btn-submit-request" className="btn btn-primary" style={{ flex: 1, justifyContent: 'center' }} onClick={handleSubmitRequest}>Submit Request</button>
                <button className="btn btn-ghost btn-sm" onClick={() => { setShowReqModal(false); setReqVideoUrl(''); }}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ══ INVITE MODAL — premium redesign ═════════════════════════════ */}
      {showInvite && (
        <div className="modal-portal" role="dialog" aria-modal="true" aria-label="Share room">
          <div className="overlay-bg" onClick={() => setShowInvite(false)} />
          <div className="modal-panel glass-elevated" style={{ maxWidth: 460 }} onClick={e => e.stopPropagation()}>

            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <div style={{ width: 48, height: 48, borderRadius: 14, background: 'linear-gradient(135deg,rgba(124,58,237,0.2),rgba(109,40,217,0.15))', border: '1px solid rgba(124,58,237,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" strokeWidth="2"><circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="M8.59 13.51l6.83 3.98M15.41 6.51l-6.82 3.98" /></svg>
                </div>
                <div>
                  <h2 style={{ fontSize: 18, fontWeight: 800, letterSpacing: '-0.03em', margin: 0 }}>Invite to Room</h2>
                  <p style={{ fontSize: 13, color: 'var(--color-text-3)', marginTop: 3 }}>Share the link or code with friends</p>
                </div>
              </div>
              <button onClick={() => setShowInvite(false)}
                style={{ width: 30, height: 30, borderRadius: 8, background: 'var(--color-surface-3)', border: '1px solid var(--color-border)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-3)', flexShrink: 0, marginTop: 2 }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" /></svg>
              </button>
            </div>

            {/* Invite link */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--color-text-3)', display: 'block', marginBottom: 8 }}>
                Invite Link
              </label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '3px 3px 3px 14px', background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', borderRadius: 12 }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-3)" strokeWidth="2" style={{ flexShrink: 0 }}><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" /></svg>
                <span id="invite-link-text" style={{ flex: 1, fontSize: 12, fontFamily: 'JetBrains Mono,monospace', color: 'var(--color-text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', userSelect: 'all' }}>
                  {inviteUrl}
                </span>
                <button id="btn-copy-invite-link"
                  onClick={() => { navigator.clipboard.writeText(inviteUrl); addToast('Link copied!', 'success'); }}
                  style={{ padding: '8px 16px', background: 'linear-gradient(135deg,#9333ea,#6d28d9)', border: 'none', borderRadius: 9, color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer', flexShrink: 0, transition: 'all 0.15s', boxShadow: '0 2px 10px rgba(109,40,217,0.4)' }}
                  onMouseEnter={e => e.currentTarget.style.boxShadow = '0 2px 18px rgba(109,40,217,0.6)'}
                  onMouseLeave={e => e.currentTarget.style.boxShadow = '0 2px 10px rgba(109,40,217,0.4)'}>
                  Copy
                </button>
              </div>
            </div>

            {/* Divider */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
              <div style={{ flex: 1, height: 1, background: 'var(--color-border)' }} />
              <span style={{ fontSize: 11, color: 'var(--color-text-4)', fontWeight: 500 }}>or share the code</span>
              <div style={{ flex: 1, height: 1, background: 'var(--color-border)' }} />
            </div>

            {/* Room code — large + copy */}
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '16px 20px', background: 'rgba(124,58,237,0.07)', border: '1px solid rgba(124,58,237,0.18)', borderRadius: 14, marginBottom: 20 }}>
              <div style={{ flex: 1 }}>
                <p style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-3)', letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 4 }}>Room Code</p>
                <div style={{ fontSize: 28, fontWeight: 900, letterSpacing: '0.25em', color: 'var(--color-brand-light)', fontFamily: 'JetBrains Mono,monospace', lineHeight: 1 }}>
                  {roomCode}
                </div>
              </div>
              <button id="btn-copy-room-code"
                onClick={() => { navigator.clipboard.writeText(roomCode); addToast('Code copied!', 'success'); }}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 16px', background: 'rgba(124,58,237,0.12)', border: '1px solid rgba(124,58,237,0.25)', borderRadius: 10, color: '#c4b5fd', fontSize: 12, fontWeight: 700, cursor: 'pointer', flexShrink: 0, transition: 'all 0.15s' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(124,58,237,0.22)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(124,58,237,0.12)'; }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
                Copy Code
              </button>
            </div>

            {/* Tip */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 14px', background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.15)', borderRadius: 10 }}>
              <span style={{ fontSize: 14, flexShrink: 0 }}>💡</span>
              <p style={{ fontSize: 12, color: 'var(--color-text-3)', lineHeight: 1.5, margin: 0 }}>
                Anyone with the link or code can join instantly — no account needed.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ══ TOASTS ══════════════════════════════════════════════════════ */}
      <div style={{ position: 'fixed', bottom: 20, right: 20, zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 7, pointerEvents: 'none', maxWidth: 360 }}>
        {toasts.map(t => (
          <div key={t.id} className="toast glass"
            style={{ pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: 9, borderLeft: `3px solid ${t.type === 'success' ? 'var(--color-success)' : t.type === 'error' ? 'var(--color-error)' : t.type === 'warning' ? 'var(--color-warning)' : 'var(--color-brand)'}`, boxShadow: 'var(--shadow-lg)' }}>
            <span style={{ fontSize: 14, flexShrink: 0 }}>{t.type === 'success' ? '✓' : t.type === 'error' ? '✕' : t.type === 'warning' ? '⚠' : 'ℹ'}</span>
            <span style={{ fontSize: 13, lineHeight: 1.4 }}>{t.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   PEOPLE PANEL — inline context menu on click, no separate modal
═══════════════════════════════════════════════════════════════════════════ */
function PeoplePanel({
  participants, currentUserId, myRole,
  menuUserId, onToggleMenu, onCloseMenu,
  onAssignRole, onKick, onTransferHost,
}: {
  participants: Array<{ userId: string; displayName: string; role: Role; isOnline: boolean }>;
  currentUserId: string; hostUserId: string; myRole?: Role;
  menuUserId: string | null;
  onToggleMenu: (uid: string) => void;
  onCloseMenu: () => void;
  onAssignRole: (uid: string, r: 'MODERATOR' | 'PARTICIPANT') => void;
  onKick: (uid: string, ban: boolean) => void;
  onTransferHost: (uid: string) => void;
}) {
  const sorted = [...participants].sort((a, b) => {
    const o: Record<Role, number> = { HOST: 0, MODERATOR: 1, PARTICIPANT: 2 };
    return o[a.role] - o[b.role];
  });
  const onlineCount = sorted.filter(p => p.isOnline).length;

  if (!sorted.length) return (
    <p style={{ fontSize: 12, color: 'var(--color-text-3)', textAlign: 'center', padding: '24px 0' }}>No participants yet</p>
  );

  return (
    <div>
      <p style={{ fontSize: 11, color: 'var(--color-text-3)', fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', marginBottom: 10, padding: '0 2px' }}>
        {onlineCount} of {sorted.length} online
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {sorted.map(p => {
          const isMe = p.userId === currentUserId;
          const canManage = myRole === 'HOST' && !isMe && p.role !== 'HOST';
          const menuOpen = menuUserId === p.userId;

          return (
            <div key={p.userId} style={{ position: 'relative' }}>
              {/* Row */}
              <div
                id={`participant-${p.userId}`}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 10, border: `1px solid ${menuOpen ? 'var(--color-brand)' : 'transparent'}`, background: menuOpen ? 'rgba(124,58,237,0.06)' : 'transparent', cursor: canManage ? 'pointer' : 'default', opacity: p.isOnline ? 1 : 0.45, transition: 'all 0.14s' }}
                onMouseEnter={e => { if (canManage && !menuOpen) { e.currentTarget.style.background = 'var(--color-surface-3)'; e.currentTarget.style.borderColor = 'var(--color-border)'; } }}
                onMouseLeave={e => { if (!menuOpen) { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.borderColor = 'transparent'; } }}
                onClick={() => canManage && onToggleMenu(p.userId)}>

                {/* Avatar */}
                <div style={{ width: 32, height: 32, borderRadius: '50%', background: avatarBg(p.displayName), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 800, color: '#fff', flexShrink: 0, boxShadow: `0 2px 8px ${avatarBg(p.displayName)}44` }}>
                  {p.displayName[0]?.toUpperCase()}
                </div>

                {/* Name + role */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: isMe ? 700 : 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: isMe ? 'var(--color-brand-light)' : 'var(--color-text)', display: 'flex', alignItems: 'center', gap: 5 }}>
                    {p.displayName}
                    {isMe && <span style={{ fontSize: 10, color: 'var(--color-text-3)', fontWeight: 400 }}>you</span>}
                  </div>
                  <span className={`badge ${p.role === 'HOST' ? 'badge-host' : p.role === 'MODERATOR' ? 'badge-moderator' : 'badge-participant'}`} style={{ fontSize: 8, marginTop: 2 }}>
                    {p.role === 'HOST' ? 'Host' : p.role === 'MODERATOR' ? 'Mod' : 'Guest'}
                  </span>
                </div>

                {/* Online dot */}
                <div style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: p.isOnline ? 'var(--color-success)' : 'var(--color-surface-4)', animation: p.isOnline ? 'pulse-ring 2s infinite' : 'none' }} />

                {/* Manage chevron */}
                {canManage && (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-4)" strokeWidth="2" style={{ flexShrink: 0, transform: menuOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>
                    <path d="M9 18l6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </div>

              {/* ── INLINE CONTEXT MENU — appears directly under the row ── */}
              {menuOpen && canManage && (
                <div className="animate-slide-down"
                  style={{ margin: '2px 8px 6px', background: 'var(--color-surface-3)', border: '1px solid var(--color-border)', borderRadius: 12, overflow: 'hidden', boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }}>

                  {/* User header in menu */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 12px', borderBottom: '1px solid var(--color-border)' }}>
                    <div style={{ width: 28, height: 28, borderRadius: '50%', background: avatarBg(p.displayName), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 800, color: '#fff' }}>{p.displayName[0]?.toUpperCase()}</div>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text)' }}>{p.displayName}</div>
                      <div style={{ fontSize: 10, color: 'var(--color-text-3)' }}>{p.role === 'MODERATOR' ? 'Moderator' : 'Guest'}</div>
                    </div>
                    <button onClick={e => { e.stopPropagation(); onCloseMenu(); }}
                      style={{ marginLeft: 'auto', width: 22, height: 22, borderRadius: 6, background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-4)' }}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" /></svg>
                    </button>
                  </div>

                  {/* Actions */}
                  <div style={{ padding: '6px' }}>
                    {/* Role toggle */}
                    {p.role === 'PARTICIPANT' && (
                      <MenuAction
                        icon={<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                        label="Make Moderator"
                        sub="Can control playback"
                        onClick={() => onAssignRole(p.userId, 'MODERATOR')}
                      />
                    )}
                    {p.role === 'MODERATOR' && (
                      <MenuAction
                        icon={<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="8" r="4" /><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" strokeLinecap="round" /></svg>}
                        label="Remove Moderator"
                        sub="Reverts to viewer"
                        onClick={() => onAssignRole(p.userId, 'PARTICIPANT')}
                      />
                    )}
                    <MenuAction
                      icon={<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>}
                      label="Transfer Host"
                      sub="Give full control"
                      onClick={() => onTransferHost(p.userId)}
                    />
                    <div style={{ height: 1, background: 'var(--color-border)', margin: '4px 0' }} />
                    <MenuAction
                      icon={<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                      label="Remove from room"
                      sub="Can rejoin with invite"
                      danger
                      onClick={() => onKick(p.userId, false)}
                    />
                    <MenuAction
                      icon={<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><path d="M4.93 4.93l14.14 14.14" strokeLinecap="round" /></svg>}
                      label="Block"
                      sub="Session revoked permanently"
                      danger
                      onClick={() => onKick(p.userId, true)}
                    />
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* Small reusable menu row */
function MenuAction({ icon, label, sub, danger = false, onClick }: {
  icon: React.ReactNode; label: string; sub: string; danger?: boolean; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: 'transparent', border: 'none', borderRadius: 8, cursor: 'pointer', transition: 'background 0.12s', textAlign: 'left' }}
      onMouseEnter={e => e.currentTarget.style.background = danger ? 'rgba(248,113,113,0.1)' : 'var(--color-surface-4)'}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
      <span style={{ width: 28, height: 28, borderRadius: 8, background: danger ? 'rgba(248,113,113,0.1)' : 'var(--color-surface-4)', border: `1px solid ${danger ? 'rgba(248,113,113,0.2)' : 'var(--color-border)'}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, color: danger ? 'var(--color-error)' : 'var(--color-text-2)' }}>
        {icon}
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: danger ? 'var(--color-error)' : 'var(--color-text)' }}>{label}</div>
        <div style={{ fontSize: 11, color: 'var(--color-text-3)', fontWeight: 400 }}>{sub}</div>
      </div>
    </button>
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   REQUESTS PANEL
═══════════════════════════════════════════════════════════════════════════ */
function RequestsPanel({ requests, myRole, onResolve }: {
  requests: PlaybackRequestDTO[]; myRole?: Role;
  onResolve: (id: string, d: 'APPROVED' | 'REJECTED') => void;
}) {
  if (!requests.length) return (
    <div style={{ textAlign: 'center', padding: '28px 0' }}>
      <div style={{ fontSize: 24, marginBottom: 8, opacity: 0.35 }}>🔔</div>
      <p style={{ fontSize: 12, color: 'var(--color-text-3)' }}>No pending requests</p>
    </div>
  );
  const aLabel = (a: string, payload: PlaybackRequestDTO['payload']) => {
    if (a === 'SEEK') return `Seek to ${payload.targetPositionSeconds != null ? Math.floor(payload.targetPositionSeconds) + 's' : '?'}`;
    if (a === 'CHANGE_VIDEO') return `Change video${payload.videoId ? `: ${payload.videoId}` : ''}`;
    return a === 'PLAY' ? 'Play' : 'Pause';
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {requests.map(r => (
        <div key={r.id} id={`request-${r.id}`} style={{ background: 'var(--color-surface-2)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '10px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 7 }}>
            <div style={{ width: 22, height: 22, borderRadius: '50%', background: avatarBg(r.requesterDisplayName), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, color: '#fff', flexShrink: 0 }}>
              {r.requesterDisplayName[0]?.toUpperCase()}
            </div>
            <span style={{ fontSize: 12, fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.requesterDisplayName}</span>
            <span className="badge badge-pending" style={{ fontSize: 8 }}>Pending</span>
          </div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-brand-light)', marginBottom: r.note ? 5 : 8 }}>{aLabel(r.action, r.payload)}</div>
          {r.note && <div style={{ fontSize: 11, color: 'var(--color-text-2)', fontStyle: 'italic', marginBottom: 8, padding: '4px 8px', background: 'rgba(255,255,255,0.03)', borderRadius: 5 }}>&ldquo;{r.note}&rdquo;</div>}
          {canControl(myRole) && (
            <div style={{ display: 'flex', gap: 6 }}>
              <button id={`btn-approve-${r.id}`} className="btn btn-success btn-sm" style={{ flex: 1, justifyContent: 'center', gap: 4 }} onClick={() => onResolve(r.id, 'APPROVED')}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                Approve
              </button>
              <button id={`btn-reject-${r.id}`} className="btn btn-danger btn-sm" style={{ flex: 1, justifyContent: 'center', gap: 4 }} onClick={() => onResolve(r.id, 'REJECTED')}>
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" /></svg>
                Reject
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
