/**
 * Bug Condition Exploration Test - Video Playback Speed Fix
 * 
 * **Property 1: Bug Condition** - Excessive Seeks After Play Sync
 * 
 * CRITICAL: This test MUST FAIL on unfixed code - failure confirms the bug exists
 * 
 * DO NOT attempt to fix the test or the code when it fails
 * 
 * GOAL: Surface counterexamples that demonstrate the bug exists (multiple rapid seeks 
 * after initial play sync)
 * 
 * This test verifies that after receiving a playback_updated event with status=PLAYING
 * and applying controls.play(t), the system produces at most 1 seek operation within 
 * the first 3 seconds.
 * 
 * **Validates: Requirements 2.1, 2.2, 2.3**
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDriftCorrection } from './useDriftCorrection';
import type { RoomPlaybackState } from './useRoomState';
import type { PlayerControls } from './useYouTubePlayer';
import type { Socket } from 'socket.io-client';

describe('Bug Condition Exploration: Excessive Seeks After Play Sync', () => {
  let mockSocket: Partial<Socket>;
  let mockControls: PlayerControls;
  let seekCallCount: number;
  let seekCallTimestamps: number[];
  let mockCurrentTime: number;

  beforeEach(() => {
    vi.useFakeTimers();
    seekCallCount = 0;
    seekCallTimestamps = [];
    mockCurrentTime = 0;

    // Mock socket with sync_ping callback support
    mockSocket = {
      connected: true,
      emit: vi.fn((event: string, ...args: any[]) => {
        if (event === 'sync_ping') {
          const clientSendTime = args[0];
          const callback = args[1];
          // Simulate server response with minimal clock offset
          const serverReceivedTime = clientSendTime + 5; // 5ms server offset
          callback(serverReceivedTime);
        }
      }),
      on: vi.fn(),
      off: vi.fn(),
    } as Partial<Socket>;

    // Mock controls that track seek calls
    mockControls = {
      play: vi.fn(),
      pause: vi.fn(),
      seekTo: vi.fn((positionSeconds: number) => {
        seekCallCount++;
        seekCallTimestamps.push(Date.now());
        // Simulate seek delay - YouTube takes time to process seeks
        mockCurrentTime = positionSeconds;
      }),
      getCurrentTime: vi.fn(() => mockCurrentTime),
      loadVideo: vi.fn(),
      mute: vi.fn(),
      unMute: vi.fn(),
      isMuted: vi.fn(() => false),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  /**
   * Test Case 1: Initial Play Sync at t=10s
   * 
   * Simulates the scenario from the design document Example 3:
   * - Client receives playback_updated event at t=10s
   * - Effect calls controls.play(10.1) which internally does seekTo(10.1)
   * - Drift correction interval fires 100-500ms later
   * - On UNFIXED code: drift correction reads stale position and calls seekTo again
   * - Expected on UNFIXED: 2+ seeks within 3 seconds
   * - Expected on FIXED: 1 seek (only the initial sync)
   */
  it('should demonstrate excessive seeks after initial play sync at t=10s', () => {
    const playback: RoomPlaybackState = {
      status: 'PLAYING',
      videoId: 'test-video-123',
      anchorPositionSeconds: 10.0,
      anchorTimestampMs: Date.now(),
      serverTimeMs: Date.now(),
      stateVersion: 1,
    };

    // Initial time: set current time to a stale value (simulating pre-sync state)
    mockCurrentTime = 5.0;

    const { result } = renderHook(() =>
      useDriftCorrection(mockSocket as Socket, playback, mockControls)
    );

    const driftControl = result.current;

    // Wait for initial clock sync to complete
    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(mockSocket.emit).toHaveBeenCalledWith(
      'sync_ping',
      expect.any(Number),
      expect.any(Function)
    );

    // Reset counters after clock sync
    seekCallCount = 0;
    seekCallTimestamps = [];

    // Simulate initial play sync from the room page effect (line 148)
    // This is what happens when playback_updated arrives
    act(() => {
      // Simulate controls.play(10.1) which internally calls seekTo
      mockControls.seekTo(10.1);
      mockCurrentTime = 10.1; // Player eventually updates position
      // IMPORTANT: Notify drift correction that a remote update occurred
      driftControl.notifyRemoteUpdate();
    });

    expect(seekCallCount).toBe(1);
    const initialSeekTime = Date.now();

    // Advance time by 100ms - drift correction interval fires (SYNC_INTERVAL_MS = 1500ms)
    // Player position should advance naturally
    act(() => {
      vi.advanceTimersByTime(100);
      mockCurrentTime += 0.1; // Player advances
    });

    // Advance to 1500ms mark - first drift correction interval
    act(() => {
      vi.advanceTimersByTime(1400); // Total: 1500ms
      mockCurrentTime += 1.4; // Player advances naturally
    });

    // Check seek count within first 1.5 seconds
    const seeksAfterInitial = seekCallCount - 1;

    // Advance another 1500ms for second drift correction interval
    act(() => {
      vi.advanceTimersByTime(1500); // Total: 3000ms
      mockCurrentTime += 1.5; // Player continues advancing naturally
    });

    const totalSeeksIn3Seconds = seekCallCount;

    // Document counterexamples
    console.log('\n=== Bug Condition Exploration Results ===');
    console.log(`Initial seek at: ${initialSeekTime}ms`);
    console.log(`Total seeks within 3 seconds: ${totalSeeksIn3Seconds}`);
    console.log(`Seek timestamps:`, seekCallTimestamps);
    console.log(`Seeks after initial sync: ${seeksAfterInitial}`);

    if (totalSeeksIn3Seconds > 1) {
      console.log('✗ BUG CONFIRMED: Excessive seeks detected');
      console.log(`  Expected: 1 seek (initial sync only)`);
      console.log(`  Actual: ${totalSeeksIn3Seconds} seeks`);

      // Calculate timing between seeks
      if (seekCallTimestamps.length > 1) {
        for (let i = 1; i < seekCallTimestamps.length; i++) {
          const timeBetweenSeeks = seekCallTimestamps[i] - seekCallTimestamps[i - 1];
          console.log(`  Seek ${i} occurred ${timeBetweenSeeks}ms after seek ${i - 1}`);
        }
      }
    } else {
      console.log('✓ Expected behavior: Only 1 seek (initial sync)');
    }
    console.log('========================================\n');

    // ASSERTION: This SHOULD FAIL on unfixed code
    // On unfixed code: expect totalSeeksIn3Seconds > 1 (bug exists)
    // On fixed code: expect totalSeeksIn3Seconds <= 1 (bug is fixed)
    expect(totalSeeksIn3Seconds).toBeLessThanOrEqual(1);
  });

  /**
   * Test Case 2: Drift Correction Interference Within Grace Period
   * 
   * This test specifically checks if drift correction triggers within 2 seconds
   * of initial play sync, which violates the grace period requirement.
   */
  it('should demonstrate drift correction interference within 2s grace period', () => {
    const playback: RoomPlaybackState = {
      status: 'PLAYING',
      videoId: 'test-video-456',
      anchorPositionSeconds: 20.0,
      anchorTimestampMs: Date.now(),
      serverTimeMs: Date.now(),
      stateVersion: 1,
    };

    // Stale position simulating YouTube player before sync
    mockCurrentTime = 15.0;

    const { result } = renderHook(() =>
      useDriftCorrection(mockSocket as Socket, playback, mockControls)
    );

    const driftControl = result.current;

    // Wait for clock sync
    act(() => {
      vi.advanceTimersByTime(100);
    });

    // Reset counters
    seekCallCount = 0;
    seekCallTimestamps = [];

    // Simulate initial play sync
    act(() => {
      mockControls.seekTo(20.0);
      // Simulate YouTube processing delay - position doesn't update immediately
      setTimeout(() => {
        mockCurrentTime = 20.0;
      }, 200);
      // IMPORTANT: Notify drift correction
      driftControl.notifyRemoteUpdate();
    });

    expect(seekCallCount).toBe(1);

    // Advance 500ms - within grace period
    act(() => {
      vi.advanceTimersByTime(500);
    });

    const seeksAt500ms = seekCallCount;

    // Advance to 1500ms - drift correction interval
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    const seeksAt1500ms = seekCallCount;

    // Advance to 2000ms - grace period boundary
    act(() => {
      vi.advanceTimersByTime(500);
    });

    const seeksAt2000ms = seekCallCount;

    console.log('\n=== Grace Period Violation Check ===');
    console.log(`Seeks at 500ms: ${seeksAt500ms} (should be 1 - initial only)`);
    console.log(`Seeks at 1500ms: ${seeksAt1500ms} (should be 1 - within grace period)`);
    console.log(`Seeks at 2000ms: ${seeksAt2000ms} (should be 1 - grace period just ending)`);

    if (seeksAt1500ms > 1) {
      console.log('✗ BUG CONFIRMED: Drift correction interfered within grace period');
      console.log(`  Drift correction should NOT trigger within 2s of initial sync`);
    } else {
      console.log('✓ Expected: No drift correction interference within grace period');
    }
    console.log('====================================\n');

    // ASSERTION: Should not have additional seeks within 2 seconds
    expect(seeksAt2000ms).toBeLessThanOrEqual(1);
  });

  /**
   * Test Case 3: Multiple Rapid Playback Updates
   * 
   * Simulates the edge case from the design where multiple playback_updated
   * events arrive in quick succession (e.g., during network recovery).
   */
  it('should demonstrate excessive seeks with multiple rapid playback updates', () => {
    let playback: RoomPlaybackState = {
      status: 'PLAYING',
      videoId: 'test-video-789',
      anchorPositionSeconds: 30.0,
      anchorTimestampMs: Date.now(),
      serverTimeMs: Date.now(),
      stateVersion: 1,
    };

    mockCurrentTime = 25.0;

    const { rerender } = renderHook(
      ({ pb }) => useDriftCorrection(mockSocket as Socket, pb, mockControls),
      { initialProps: { pb: playback } }
    );

    // Wait for clock sync
    act(() => {
      vi.advanceTimersByTime(100);
    });

    // Reset counters
    seekCallCount = 0;
    seekCallTimestamps = [];

    // Simulate first playback update at t=30s
    act(() => {
      mockControls.seekTo(30.0);
      mockCurrentTime = 30.0;
    });

    // Simulate second playback update 300ms later at t=30.5s
    act(() => {
      vi.advanceTimersByTime(300);
      playback = {
        ...playback,
        anchorPositionSeconds: 30.5,
        anchorTimestampMs: Date.now(),
        serverTimeMs: Date.now(),
        stateVersion: 2,
      };
      rerender({ pb: playback });
      mockControls.seekTo(30.5);
      mockCurrentTime = 30.5;
    });

    // Simulate third playback update 300ms later at t=31.0s
    act(() => {
      vi.advanceTimersByTime(300);
      playback = {
        ...playback,
        anchorPositionSeconds: 31.0,
        anchorTimestampMs: Date.now(),
        serverTimeMs: Date.now(),
        stateVersion: 3,
      };
      rerender({ pb: playback });
      mockControls.seekTo(31.0);
      mockCurrentTime = 31.0;
    });

    const seeksFromUpdates = seekCallCount;

    // Now let drift correction run
    act(() => {
      vi.advanceTimersByTime(900); // Total: 1500ms from start
    });

    const totalSeeks = seekCallCount;

    console.log('\n=== Multiple Rapid Updates Test ===');
    console.log(`Seeks from playback updates: ${seeksFromUpdates}`);
    console.log(`Total seeks after drift correction: ${totalSeeks}`);
    console.log(`Seek timestamps:`, seekCallTimestamps);

    if (totalSeeks > seeksFromUpdates) {
      console.log('✗ BUG CONFIRMED: Drift correction added unnecessary seeks');
      console.log(`  Drift correction should not interfere during rapid updates`);
    } else {
      console.log('✓ Expected: No additional seeks from drift correction');
    }
    console.log('===================================\n');

    // ASSERTION: Drift correction should not add seeks on top of the updates
    // We expect 3 seeks from the updates, but no additional seeks from drift correction
    // within the grace period
    expect(totalSeeks).toBe(seeksFromUpdates);
  });
});
