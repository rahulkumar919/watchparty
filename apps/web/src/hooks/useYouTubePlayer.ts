'use client';

/**
 * YouTube IFrame Player hook
 *
 * Manages the YouTube IFrame Player API lifecycle:
 * - Dynamically loads the IFrame API script
 * - Initializes the player when ready
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

export function useYouTubePlayer(
  containerId: string,
  initialVideoId: string,
  callbacks: PlayerCallbacks,
) {
  const playerRef = useRef<YT.Player | null>(null);
  const isApplyingRemoteUpdate = useRef(false);
  const isReadyRef = useRef(false);
  const [playerState, setPlayerState] = useState<PlayerState>('unstarted');
  const [isMuted, setIsMuted] = useState(true);

  useEffect(() => {
    if (!initialVideoId) return;

    function initPlayer() {
      if (playerRef.current) return; // Already initialized

      playerRef.current = new window.YT.Player(containerId, {
        videoId: initialVideoId,
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
            isReadyRef.current = true;
            callbacks.onReady();
          },
          onStateChange: (event) => {
            // Loop-breaker: suppress events triggered by our own programmatic calls
            if (isApplyingRemoteUpdate.current) {
              isApplyingRemoteUpdate.current = false;
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

            if (event.data === YT.PlayerState.PLAYING) {
              const pos = playerRef.current?.getCurrentTime() ?? 0;
              callbacks.onPlay(pos);
            } else if (event.data === YT.PlayerState.PAUSED) {
              const pos = playerRef.current?.getCurrentTime() ?? 0;
              callbacks.onPause(pos);
            }
          },
          onError: (event) => {
            callbacks.onError(event.data);
          },
        },
      });
    }

    // Load API script if not already loaded
    if (window.YT?.Player) {
      initPlayer();
    } else {
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      document.body.appendChild(script);

      const existingCallback = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        existingCallback?.();
        initPlayer();
      };
    }

    return () => {
      playerRef.current?.destroy();
      playerRef.current = null;
      isReadyRef.current = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerId, initialVideoId]);

  // ── Imperative Controls ───────────────────────────────────────────────────────

  const controls: PlayerControls = {
    play: useCallback((positionSeconds?: number) => {
      if (!playerRef.current || !isReadyRef.current) return;
      isApplyingRemoteUpdate.current = true;
      if (positionSeconds !== undefined) {
        playerRef.current.seekTo(positionSeconds, true);
      }
      playerRef.current.unMute();
      playerRef.current.playVideo();
      setIsMuted(false);
    }, []),

    pause: useCallback(() => {
      if (!playerRef.current || !isReadyRef.current) return;
      isApplyingRemoteUpdate.current = true;
      playerRef.current.pauseVideo();
    }, []),

    seekTo: useCallback((positionSeconds: number) => {
      if (!playerRef.current || !isReadyRef.current) return;
      isApplyingRemoteUpdate.current = true;
      playerRef.current.seekTo(positionSeconds, true);
    }, []),

    getCurrentTime: useCallback(() => {
      return playerRef.current?.getCurrentTime() ?? 0;
    }, []),

    loadVideo: useCallback((videoId: string) => {
      if (!playerRef.current || !isReadyRef.current) return;
      isApplyingRemoteUpdate.current = true;
      playerRef.current.loadVideoById(videoId);
      playerRef.current.pauseVideo();
    }, []),

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

  return { controls, playerState, isReady: isReadyRef.current, isMuted };
}
