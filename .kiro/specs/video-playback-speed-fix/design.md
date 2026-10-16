# Video Playback Speed Bugfix Design

## Overview

This design addresses a critical video playback bug where videos play significantly faster than normal speed (1x) due to excessive `seekTo` calls. The root cause is a timing coordination issue between the initial play synchronization effect (line 148 in room page) and the drift correction hook. When a `playback_updated` event arrives, the effect calls `controls.play(t)` which internally performs `seekTo(t)` + `playVideo()`. Meanwhile, the drift correction hook runs every 1.5s and calls `seekTo` if drift exceeds the threshold. These overlapping seek operations create a fast-forward illusion where the player continuously jumps ahead instead of playing smoothly.

The fix strategy focuses on:
1. Adding a grace period after remote playback updates to suppress drift correction
2. Preventing redundant seeks during initial play synchronization
3. Maintaining accurate drift correction for legitimate use cases
4. Preserving all existing synchronization behaviors

## Glossary

- **Bug_Condition (C)**: The condition that triggers the bug - when the video plays faster than normal speed due to excessive seekTo calls
- **Property (P)**: The desired behavior - videos play at normal 1x speed with smooth playback
- **Preservation**: Existing synchronization behaviors (drift correction, join sync, manual controls) that must remain unchanged
- **controls.play(t)**: Method in `useYouTubePlayer` that seeks to position `t` and starts playback (sets `isApplyingRemoteUpdate` flag)
- **useDriftCorrection**: Hook that runs every 1.5s to check for drift and calls `seekTo` if `|delta| > 1.5s`
- **isApplyingRemoteUpdate**: Loop-breaker flag in `useYouTubePlayer` that prevents self-echo of programmatic state changes
- **anchorTimestampMs**: Server timestamp when the anchor position was set, used to compute current position
- **anchorPositionSeconds**: Video position at the anchor timestamp
- **SNAP_THRESHOLD_S**: 1.5 second threshold for drift correction triggering
- **SEEK_DEBOUNCE_MS**: 1 second cooldown after each drift correction seek

## Bug Details

### Bug Condition

The bug manifests when a user plays a video in a watch party room and observes the video playing at faster-than-normal speed with apparent skipping. The root cause is rapid, overlapping `seekTo` calls from two sources:
1. The playback synchronization effect at line 148 which calls `controls.play(t)` (which internally does `seekTo + playVideo`)
2. The drift correction interval running every 1.5s checking for drift and calling `seekTo` if threshold exceeded

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input of type PlaybackUpdateEvent
  OUTPUT: boolean
  
  RETURN input.status == 'PLAYING'
         AND controls.play(computedPosition) is called
         AND within 1.5s, useDriftCorrection also calls controls.seekTo()
         AND these overlapping seeks cause apparent fast-forward playback
END FUNCTION
```

### Examples

- **Example 1**: Host plays video at t=10s. Server broadcasts `playback_updated`. Client receives event, computes position as t=10.1s, calls `controls.play(10.1)` which does `seekTo(10.1) + playVideo()`. 300ms later, drift correction interval fires, detects drift of 0.3s (below threshold), does nothing. 1200ms later (1.5s total), drift correction fires again, computes target=11.6s, local=11.5s, delta=0.1s (below threshold), does nothing. **Expected: smooth playback**.

- **Example 2**: Host plays video at t=10s. Server broadcasts `playback_updated`. Client receives event 500ms late due to network, computes position as t=10.5s, calls `controls.play(10.5)`. 200ms later, drift correction interval fires (bad timing), computes target=10.7s, local=10.2s (still seeking), delta=0.5s (below threshold), does nothing. But if the timing is worse and drift correction fires immediately after the play() seek completes, it may detect artificial drift caused by the initial sync. **Expected: smooth playback after initial sync**.

- **Example 3**: Host plays video at t=10s. Client receives `playback_updated` event, computes position t=10.1s, calls `controls.play(10.1)`. Drift correction runs 100ms later while YouTube is still processing the seek, reads stale position (e.g., t=5s from previous state), computes delta=5.1s (exceeds threshold), calls `seekTo(10.1)` again. This creates a double-seek that causes jitter. **Current: appears as fast-forward/skipping**.

- **Edge Case**: Multiple rapid `playback_updated` events arrive in quick succession (e.g., during network recovery or host rapidly seeking). Each triggers `controls.play(t)` with slightly different positions. Combined with drift correction running every 1.5s, this creates excessive seeks. **Expected: only the latest position should be synced smoothly**.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Drift correction must continue to work for legitimate drift scenarios (network latency, buffer issues)
- Participants joining a room with an already-playing video must be synchronized to the correct position
- The loop-breaker pattern (`isApplyingRemoteUpdate` flag) must continue to prevent self-echo
- Anchor-based position calculation must continue to provide accurate synchronized positions
- Manual playback controls (play, pause, seek) must continue to synchronize across all participants

**Scope:**
All inputs that do NOT involve the specific timing race between initial play synchronization and drift correction should be completely unaffected by this fix. This includes:
- Normal drift correction after video has been playing for several seconds
- Synchronization when joining a room
- Manual user interactions with playback controls
- Pause/resume operations
- Video changes

## Hypothesized Root Cause

Based on the bug description and code analysis, the most likely issues are:

1. **Timing Race Between Initial Sync and Drift Correction**: When `playback_updated` arrives, the effect at line 148 calls `controls.play(t)` which sets `isApplyingRemoteUpdate=true` and calls `seekTo(t) + playVideo()`. However, the drift correction hook's interval may fire shortly after (within 100-500ms) while the YouTube player is still processing the seek. The drift correction reads the local position (still at the old value), compares it to the target (new anchor), detects large "drift", and calls `seekTo` again. This creates redundant seeks.

2. **No Grace Period After Remote Updates**: The drift correction hook has a 1-second cooldown after each seek it performs (`SEEK_DEBOUNCE_MS`), but this cooldown is NOT triggered when `controls.play()` calls `seekTo` from the initial sync effect. Therefore, drift correction can fire immediately after the initial sync without any backoff.

3. **Accumulated Seek Queue**: YouTube's IFrame API may queue multiple `seekTo` calls if they arrive in rapid succession. Instead of canceling the previous seek, it may execute them sequentially, causing the player to "jump" through multiple positions rapidly, creating the fast-forward illusion.

4. **Clock Offset Calculation Timing**: The NTP-lite clock sync in `useDriftCorrection` updates `clockOffsetRef` asynchronously. If a `playback_updated` event arrives during or immediately after clock sync, the computed position in the effect and the target position in drift correction may use different clock offsets, causing artificial drift detection.

## Correctness Properties

Property 1: Bug Condition - Normal Speed Playback After Sync

_For any_ playback update event where the video status is PLAYING and an initial synchronization occurs (via `controls.play(t)`), the fixed code SHALL play the video at normal 1x speed without rapid seeking or fast-forward behavior within the first 3 seconds after the sync.

**Validates: Requirements 2.1, 2.2, 2.3**

Property 2: Preservation - Legitimate Drift Correction

_For any_ playback scenario where legitimate drift occurs (local position diverges from server target by more than 1.5s due to network latency or buffer issues) AND no recent playback update has been received in the last 2 seconds, the drift correction SHALL continue to detect and correct the drift by seeking to the target position.

**Validates: Requirements 3.1, 3.2**

Property 3: Preservation - Join Synchronization

_For any_ participant joining a room with an already-playing video, the synchronization logic SHALL continue to position the participant's playback at the correct computed position based on the anchor timestamp and position.

**Validates: Requirements 3.1**

Property 4: Preservation - Manual Control Synchronization

_For any_ manual playback control action (play, pause, seek) initiated by a user with appropriate permissions, the system SHALL continue to synchronize this action across all participants via the server state and `playback_updated` events.

**Validates: Requirements 3.3**

Property 5: Preservation - Loop-Breaker Functionality

_For any_ programmatic playback control call (`controls.play()`, `controls.pause()`, `controls.seekTo()`), the loop-breaker pattern SHALL continue to set `isApplyingRemoteUpdate=true` and suppress the resulting `onStateChange` event from being re-emitted to the server.

**Validates: Requirements 3.4**

## Fix Implementation

### Changes Required

Assuming our root cause analysis is correct:

**File**: `c:\Desktop\watch_party_system\apps\web\src\hooks\useDriftCorrection.ts`

**Hook**: `useDriftCorrection`

**Specific Changes**:

1. **Add Grace Period Tracking**: Introduce a ref `lastRemoteUpdateRef` to track when the most recent remote playback update was applied (from outside the drift correction hook). This will be set by the caller (room page effect) when it applies a remote update.

2. **Extend Cooldown Logic**: Modify the drift correction interval to check not only the internal `lastSeekAtRef` cooldown but also check if a grace period has elapsed since the last remote update. The grace period should be ~2000ms (longer than the normal 1000ms cooldown) to allow the initial sync to fully settle.

3. **Add Grace Period Constant**: Define `REMOTE_UPDATE_GRACE_MS = 2000` as the minimum time to wait after a remote playback update before drift correction resumes.

4. **Expose Grace Period Setter**: Export a method or return an object from the hook that allows the room page effect to signal when a remote update has been applied.

**Alternative Approach** (if exposing grace period is complex):

**File**: `c:\Desktop\watch_party_system\apps\web\src\app\room\[code]\page.tsx`

**Effect**: Line 148 playback synchronization effect

**Specific Changes**:

1. **Signal to Drift Correction**: After calling `controls.play(t)` or `controls.seekTo()`, signal to the drift correction hook that a remote update was applied. This could be done by:
   - Passing a callback prop to `useDriftCorrection` that allows setting the grace period timestamp
   - Using a shared ref that both the effect and hook can access
   - Implementing a custom event or state signal

2. **Prevent Redundant Seeks**: Before calling `controls.play(t)`, check if the computed position `t` is close enough to the current player position (within a small epsilon like 0.5s). If so, just call `playVideo()` without seeking. This reduces unnecessary seeks during minor anchor updates.

**Recommended Implementation** (combines both approaches):

1. **Modify `useDriftCorrection` hook**:
   - Add `lastRemoteUpdateRef` ref initialized to `useRef(0)`
   - Add `REMOTE_UPDATE_GRACE_MS = 2000` constant
   - In the interval callback, add condition: `if (Date.now() - lastRemoteUpdateRef.current < REMOTE_UPDATE_GRACE_MS) return;`
   - Return an object with a method: `{ notifyRemoteUpdate: () => { lastRemoteUpdateRef.current = Date.now(); } }`

2. **Modify room page effect** (line 148):
   - Destructure the returned object from `useDriftCorrection`: `const driftControl = useDriftCorrection(...)`
   - After calling `controls.play(t)` or `controls.seekTo()`, call `driftControl.notifyRemoteUpdate()`

3. **Add Position Tolerance Check** (optimization):
   - In the room page effect, before calling `controls.play(t)`, check: `const currentPos = controls.getCurrentTime(); if (Math.abs(currentPos - t) < 0.5) { controls.play(); /* no seek */ return; }`
   - This prevents redundant seeks when the position is already close enough

## Testing Strategy

### Validation Approach

The testing strategy follows a two-phase approach: first, surface counterexamples that demonstrate the bug on unfixed code by observing rapid seeks and fast-forward playback, then verify the fix eliminates excessive seeks while preserving drift correction for legitimate scenarios.

### Exploratory Bug Condition Checking

**Goal**: Surface counterexamples that demonstrate the bug BEFORE implementing the fix. Confirm or refute the root cause analysis that the timing race between initial sync and drift correction causes excessive seeks.

**Test Plan**: Write tests that simulate receiving a `playback_updated` event, applying it via `controls.play(t)`, and then monitoring the behavior of drift correction in the immediate aftermath (0-3 seconds). Use mocks/spies to track `seekTo` call count and timing. Run these tests on the UNFIXED code to observe multiple rapid `seekTo` calls.

**Test Cases**:

1. **Rapid Seeks After Play Test**: Simulate receiving `playback_updated` with status=PLAYING at t=10s. Apply sync via `controls.play(10)`. Mock drift correction to fire 100ms later. Assert that on UNFIXED code, drift correction calls `seekTo` again within 500ms, causing double-seek. (will fail on unfixed code)

2. **Fast-Forward Observation Test**: Set up a real YouTube player with a test video. Simulate initial play sync at t=10s. Let drift correction run with 1.5s interval. Observe player behavior for 5 seconds. On UNFIXED code, player should exhibit fast-forward/jittery behavior. On FIXED code, playback should be smooth. (manual observation test, will fail on unfixed code)

3. **Seek Count Test**: Simulate a play event followed by normal playback for 10 seconds with no legitimate drift. Count the number of `seekTo` calls made by drift correction. On UNFIXED code, expect 2-3+ seeks. On FIXED code, expect 0-1 seek. (will fail on unfixed code)

4. **Grace Period Violation Test**: Simulate `controls.play(t)` at time T. Mock drift correction to fire at T+200ms (within grace period). Assert that on UNFIXED code, drift correction proceeds and may call seek. On FIXED code, drift correction returns early due to grace period. (will fail on unfixed code)

**Expected Counterexamples**:
- Multiple `seekTo` calls within 2 seconds of initial play sync
- Drift correction triggering during or immediately after initial sync when no legitimate drift exists
- Possible causes: missing grace period, lack of coordination between sync effect and drift correction, YouTube seek queue accumulation

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds (initial play sync + drift correction timing race), the fixed code produces smooth playback without excessive seeks.

**Pseudocode:**
```
FOR ALL playbackUpdate WHERE playbackUpdate.status == 'PLAYING' DO
  applyInitialSync(playbackUpdate)
  observePlaybackFor(3000ms) // 3 seconds
  seekCount := countSeeksInInterval(0, 3000ms)
  ASSERT seekCount <= 1 // At most the initial sync seek
  ASSERT playbackSpeed == 1.0 // Normal speed
END FOR
```

**Testing Approach**: Use property-based testing to generate various playback scenarios (different positions, timing, network delays) and verify smooth playback after sync. Track seek call count and assert it remains minimal.

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold (legitimate drift scenarios, join sync, manual controls), the fixed code produces the same result as the original code.

**Pseudocode:**
```
FOR ALL scenario WHERE NOT isBugCondition(scenario) DO
  ASSERT fixedBehavior(scenario) == originalBehavior(scenario)
END FOR
```

**Testing Approach**: Property-based testing is recommended for preservation checking because:
- It generates many test cases automatically across the input domain (different drift amounts, timing, positions)
- It catches edge cases that manual unit tests might miss (e.g., drift exactly at threshold, clock offset changes)
- It provides strong guarantees that behavior is unchanged for all non-buggy inputs

**Test Plan**: First, observe the behavior of drift correction on UNFIXED code in legitimate drift scenarios (e.g., manually pause the player to create drift). Capture this behavior. Then write property-based tests that verify this behavior continues after the fix.

**Test Cases**:

1. **Legitimate Drift Correction Preservation**: Observe on unfixed code: pause video for 3 seconds while server continues playing (creates 3s drift). Resume playback. Drift correction should detect >1.5s drift and seek to catch up. Write PBT to verify this continues after fix. Generate random drift amounts (1.5s to 10s) and verify correction happens.

2. **Join Synchronization Preservation**: Observe on unfixed code: second participant joins room while video is playing at t=30s. New participant's player should sync to ~t=30s. Write test to verify this continues after fix. Test with various join times and positions.

3. **Manual Control Preservation**: Observe on unfixed code: host seeks to t=50s. All participants should sync to t=50s within drift threshold. Write test to verify this continues after fix.

4. **No Drift Scenario Preservation**: Observe on unfixed code: video plays normally for 60s with no network issues. Drift correction should not intervene (no seeks after initial sync settles). Write PBT to verify after fix, drift correction remains quiet when no drift exists.

5. **Grace Period Doesn't Block Legitimate Drift**: After initial sync settles (>2s), introduce legitimate drift (e.g., network pause). Verify drift correction activates after grace period expires and corrects the drift.

### Unit Tests

- Test `useDriftCorrection` hook with mocked `controls.seekTo` to verify grace period logic
- Test that `notifyRemoteUpdate()` correctly sets the timestamp and suppresses drift correction for 2 seconds
- Test that drift correction resumes after grace period expires
- Test edge cases: grace period expiring exactly when drift is detected, multiple rapid remote updates
- Test position tolerance optimization: verify redundant seeks are avoided when position delta < 0.5s

### Property-Based Tests

- Generate random sequences of playback events (play, pause, seek) with varying timing and verify smooth playback after each
- Generate random drift amounts and verify correction only happens when drift exceeds threshold AND grace period expired
- Generate random join scenarios (participant joins at various times/positions) and verify correct sync
- Test that seek count remains minimal across many randomly generated playback sessions

### Integration Tests

- End-to-end test: host plays video, multiple participants join at different times, verify all participants play smoothly at 1x speed
- End-to-end test: simulate network latency causing legitimate drift, verify drift correction activates and corrects position
- End-to-end test: host rapidly seeks multiple times, verify participants sync smoothly without excessive seeks
- Visual/manual test: watch a real video for 60 seconds and confirm smooth playback at 1x speed without jitter
