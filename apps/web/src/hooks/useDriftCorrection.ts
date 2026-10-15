'use client';

/**
 * Drift correction hook
 *
 * Implements the Conservative Two-Zone Threshold Algorithm:
 * - Every 1.5s, compare local player position with server-computed target
 * - Zone 1 (|delta| <= 1.5s): Do nothing — normal audio/network jitter
 * - Zone 2 (|delta| > 1.5s): Snap-seek to target position
 * - Debounce guard: 1s cooldown after each seek to let YouTube buffer
 *
 * Also handles clock skew via NTP-lite sync_ping:
 * clockOffset = serverTime - (clientTime + RTT/2)
 * targetPosition = anchorPositionSeconds + ((clientTime + clockOffset) - anchorTimestampMs) / 1000
 */

import { useEffect, useRef, useCallback } from 'react';
import { Socket } from 'socket.io-client';
import { RoomPlaybackState } from './useRoomState';
import { PlayerControls } from './useYouTubePlayer';

const SYNC_INTERVAL_MS = 1500;
const SNAP_THRESHOLD_S = 1.5;
const SEEK_DEBOUNCE_MS = 1000;

export function useDriftCorrection(
  socket: Socket | null,
  playback: RoomPlaybackState | null,
  controls: PlayerControls | null,
) {
  const clockOffsetRef = useRef(0);
  const lastSeekAtRef = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // NTP-lite clock sync — runs once on mount and every 30s
  const syncClock = useCallback(() => {
    if (!socket?.connected) return;
    const clientSendTime = Date.now();
    socket.emit('sync_ping', clientSendTime, (serverReceivedTime: number) => {
      const rtt = Date.now() - clientSendTime;
      clockOffsetRef.current = serverReceivedTime - (clientSendTime + rtt / 2);
    });
  }, [socket]);

  useEffect(() => {
    syncClock();
    const clockInterval = setInterval(syncClock, 30_000);
    return () => clearInterval(clockInterval);
  }, [syncClock]);

  // Drift correction loop
  useEffect(() => {
    if (!playback || !controls) return;

    if (intervalRef.current) clearInterval(intervalRef.current);

    intervalRef.current = setInterval(() => {
      if (playback.status !== 'PLAYING') return;

      const nowClient = Date.now();
      const adjustedNow = nowClient + clockOffsetRef.current;
      const targetPosition =
        playback.anchorPositionSeconds + (adjustedNow - playback.anchorTimestampMs) / 1000;

      const localPosition = controls.getCurrentTime();
      const delta = Math.abs(localPosition - targetPosition);

      const cooldownActive = Date.now() - lastSeekAtRef.current < SEEK_DEBOUNCE_MS;
      if (cooldownActive) return;

      if (delta > SNAP_THRESHOLD_S) {
        // Zone 2: Snap to target
        controls.seekTo(targetPosition);
        lastSeekAtRef.current = Date.now();
      }
      // Zone 1: Within threshold — no action
    }, SYNC_INTERVAL_MS);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [playback, controls]);
}
