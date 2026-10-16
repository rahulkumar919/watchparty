'use client';

/**
 * YouTube IFrame Player hook
 *
 * Manages the YouTube IFrame Player API lifecycle:
 * - Dynamically loads the IFrame API script
 * - Initializes the player when ready (with polling fallback)
 * - Provides imperative controls (play, pause, seekTo)
 * - Bridges YouTube state-change events to callbacks
 * - Implements the loop-breaker pattern to prevent self-echo
 *
 * Loop-breaker:
 * When the server broadcasts a playback_updated event, we programmatically
 * call player.seekTo() or player.pauseVideo(). YouTube fires onStateChange
 * in response. We set isApplyingRemoteUpdate=true BEFORE the programmatic
 * call, then reset it in the onStateChange handler. Any state change that
 * occurs while isApplyingRemoteUpdate=true is suppressed from being re-emitted
 * to the server — preventing an infinite emit loop.
 */

import { useEffect, useRef, useCallback, useState } from 'react';

declare global {
  interface Window {
    YT: typeof YT;
    onYouTubeIframeAPIReady: () => void;
  }
}

export interface PlayerControls {
  play: (positionSeconds?: number) => void;
  pause: () => void;
  seekTo: (positionSeconds: number) => void;
  getCurrentTime: () => number;
  loadVideo: (videoId: string) => void;
  mute: () => void;
  unMute: () => void;
  isMuted: () => boolean;
}

export interface PlayerCallbacks {
  onPlay: (positionSeconds: number) => void;
  onPause: (positionSeconds: number) => void;
  onSeek: (targetPositionSeconds: number) => void;
  onReady: () => void;
  onError: (errorCode: number) => void;
}

export type PlayerState = 'unstarted' | 'ended' | 'playing' | 'paused' | 'buffering' | 'cued';

// ── Module-level: load the YT API script once ──────────────────────────────
let ytApiLoading = false;
const ytApiReadyCallbacks: (() => void)[] = [];

function ensureYTApiLoaded(onReady: () => void) {
  // Already loaded
  if (typeof window !== 'undefined' && window.YT?.Player) {
    onReady();
    return;
  }

  ytApiReadyCallbacks.push(onReady);

  if (!ytApiLoading) {
    ytApiLoading = true;

    // Set the global callback BEFORE loading the script
    const existingCallback = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      existingCallback?.();
      console.log('[YouTubePlayer] YT API ready, notifying', ytApiReadyCallbacks.length, 'listeners');
      // Drain all pending callbacks
      while (ytApiReadyCallbacks.length > 0) {
        const cb = ytApiReadyCallbacks.shift();
        cb?.();
      }
    };

    // Load the script
    const existingScript = document.querySelector('script[src="https://www.youtube.com/iframe_api"]');
    if (!existingScript) {
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      script.onerror = () => {
        console.error('[YouTubePlayer] Failed to load YouTube IFrame API');
        ytApiLoading = false;
      };
      document.body.appendChild(script);
    }
  }
}

export function useYouTubePlayer(
  containerId: string,
  initialVideoId: string,
  callbacks: PlayerCallbacks,
) {
  const playerRef = useRef<YT.Player | null>(null);
  const isApplyingRemoteUpdate = useRef(false);
  const remoteUpdateTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isReadyRef = useRef(false);
  const [playerState, setPlayerState] = useState<PlayerState>('unstarted');
  const [isMuted, setIsMuted] = useState(true);
  const [isReady, setIsReady] = useState(false);

  // Use refs for callbacks so the player event handlers always call the latest versions
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  // Track the video ID used during player construction to avoid double-loading
  const constructedVideoIdRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryCount = 0;
    const MAX_RETRIES = 50; // 50 x 100ms = 5s max wait

    function createPlayer() {
      if (cancelled || playerRef.current) return;

      const container = document.getElementById(containerId);
      if (!container) {
        // Container not in DOM yet — retry with polling
        retryCount++;
        if (retryCount <= MAX_RETRIES) {
          console.log('[YouTubePlayer] Container not ready, retrying...', retryCount);
          retryTimer = setTimeout(createPlayer, 100);
        } else {
          console.error('[YouTubePlayer] Container', containerId, 'not found after', MAX_RETRIES, 'retries');
        }
        return;
      }

      try {
        console.log('[YouTubePlayer] Creating player in container:', containerId, 'videoId:', initialVideoId || '(none)');
        constructedVideoIdRef.current = initialVideoId || null;

        playerRef.current = new window.YT.Player(containerId, {
          ...(initialVideoId ? { videoId: initialVideoId } : {}),
          height: '100%',
          width: '100%',
          playerVars: {
            autoplay: 0,
            controls: 0,       // Hide native controls — we render our own
            disablekb: 1,      // Disable keyboard shortcuts
            fs: 0,             // No fullscreen button
            iv_load_policy: 3, // No annotations
            modestbranding: 1, // Minimal YouTube branding
            rel: 0,            // No related videos at end
            playsinline: 1,    // iOS inline play
            mute: 1,           // Start muted to satisfy autoplay policy
            enablejsapi: 1,
            origin: window.location.origin,
          },
          events: {
            onReady: () => {
              if (cancelled) return;
              console.log('[YouTubePlayer] Player ready!');
              isReadyRef.current = true;
              setIsReady(true);
              callbacksRef.current.onReady();
            },
            onStateChange: (event) => {
              if (cancelled) return;
              // Loop-breaker: suppress events triggered by our own programmatic calls
              if (isApplyingRemoteUpdate.current) {
                console.log('[YouTubePlayer] Suppressing state change during remote update:', event.data);
                return;
              }

              const stateMap: Record<number, PlayerState> = {
                [-1]: 'unstarted',
                [0]: 'ended',
                [1]: 'playing',
                [2]: 'paused',
                [3]: 'buffering',
                [5]: 'cued',
              };
              const newState = stateMap[event.data] ?? 'unstarted';
              setPlayerState(newState);

              console.log('[YouTubePlayer] State changed to:', newState);

              if (event.data === YT.PlayerState.PLAYING) {
                const pos = playerRef.current?.getCurrentTime() ?? 0;
                callbacksRef.current.onPlay(pos);
              } else if (event.data === YT.PlayerState.PAUSED) {
                const pos = playerRef.current?.getCurrentTime() ?? 0;
                callbacksRef.current.onPause(pos);
              }
            },
            onError: (event) => {
              if (cancelled) return;
              console.error('[YouTubePlayer] Player error:', event.data);
              callbacksRef.current.onError(event.data);
            },
          },
        });

        console.log('[YouTubePlayer] Player instance created successfully');
      } catch (err) {
        console.error('[YouTubePlayer] Failed to initialize player:', err);
      }
    }

    // Load the YT API and create the player when ready
    ensureYTApiLoaded(() => {
      if (!cancelled) createPlayer();
    });

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (remoteUpdateTimeout.current) {
        clearTimeout(remoteUpdateTimeout.current);
      }
      if (playerRef.current) {
        try {
          playerRef.current.destroy();
        } catch (err) {
          console.error('[YouTubePlayer] Error destroying player:', err);
        }
        playerRef.current = null;
        isReadyRef.current = false;
        setIsReady(false);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerId]); // Only init once per container

  // ── Imperative Controls ───────────────────────────────────────────────────────

  const setRemoteUpdateFlag = useCallback((durationMs: number = 500) => {
    isApplyingRemoteUpdate.current = true;
    if (remoteUpdateTimeout.current) clearTimeout(remoteUpdateTimeout.current);
    remoteUpdateTimeout.current = setTimeout(() => {
      isApplyingRemoteUpdate.current = false;
      console.log('[YouTubePlayer] Remote update flag cleared');
    }, durationMs);
  }, []);

  // Handle video ID changes separately without destroying player
  useEffect(() => {
    if (!initialVideoId || !playerRef.current || !isReadyRef.current) return;

    // Skip if this video was already loaded during player construction
    if (initialVideoId === constructedVideoIdRef.current) {
      constructedVideoIdRef.current = null; // Clear so future changes to same ID still work
      return;
    }

    try {
      console.log('[YouTubePlayer] Cueing video ID:', initialVideoId);
      setRemoteUpdateFlag(1000);
      playerRef.current.cueVideoById(initialVideoId);
    } catch (err) {
      console.error('[YouTubePlayer] Error loading video:', err);
    }
  }, [initialVideoId, isReady, setRemoteUpdateFlag]);

  const controls: PlayerControls = {
    play: useCallback((positionSeconds?: number) => {
      if (!playerRef.current || !isReadyRef.current) return;
      console.log('[YouTubePlayer] PLAY command:', positionSeconds);
      setRemoteUpdateFlag();
      if (positionSeconds !== undefined) {
        playerRef.current.seekTo(positionSeconds, true);
      }
      playerRef.current.playVideo();
    }, [setRemoteUpdateFlag]),

    pause: useCallback(() => {
      if (!playerRef.current || !isReadyRef.current) return;
      console.log('[YouTubePlayer] PAUSE command');
      setRemoteUpdateFlag();
      playerRef.current.pauseVideo();
    }, [setRemoteUpdateFlag]),

    seekTo: useCallback((positionSeconds: number) => {
      if (!playerRef.current || !isReadyRef.current) return;
      console.log('[YouTubePlayer] SEEK command to:', positionSeconds);
      setRemoteUpdateFlag();
      playerRef.current.seekTo(positionSeconds, true);
    }, [setRemoteUpdateFlag]),

    getCurrentTime: useCallback(() => {
      return playerRef.current?.getCurrentTime() ?? 0;
    }, []),

    loadVideo: useCallback((videoId: string) => {
      if (!playerRef.current || !isReadyRef.current) return;
      console.log('[YouTubePlayer] LOAD VIDEO command:', videoId);
      setRemoteUpdateFlag(1000);
      playerRef.current.cueVideoById(videoId);
    }, [setRemoteUpdateFlag]),

    mute: useCallback(() => {
      playerRef.current?.mute();
      setIsMuted(true);
    }, []),

    unMute: useCallback(() => {
      playerRef.current?.unMute();
      setIsMuted(false);
    }, []),

    isMuted: useCallback(() => isMuted, [isMuted]),
  };

  return { controls, playerState, isReady, isMuted };
}
