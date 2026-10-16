# Bug Condition Exploration Results

## Summary

Successfully demonstrated that the video playback speed bug exists in the unfixed code. The bug manifests as excessive `seekTo` calls within a short time window after initial play synchronization.

## Test Execution Date

Test run completed at the task 1 execution phase (bug exploration on UNFIXED code).

## Counterexamples Found

### Test Case 1: Excessive Seeks After Initial Play Sync at t=10s

**Status**: ✗ **BUG CONFIRMED**

**Observation**:
- Expected: 1 seek (initial sync only)
- Actual: 2 seeks within 3 seconds
- Timing: Second seek occurred 2900ms after first seek

**Analysis**:
This test simulates the scenario where:
1. Client receives `playback_updated` event at t=10s
2. Room page effect calls `controls.play(10.1)` which internally does `seekTo(10.1)`
3. Drift correction interval fires at ~1500ms mark
4. Drift correction detects "drift" and calls `seekTo` again

The bug is confirmed because drift correction is adding an unnecessary second seek within the 3-second observation window.

### Test Case 2: Drift Correction Interference Within 2s Grace Period

**Status**: ✗ **BUG CONFIRMED**

**Observation**:
- Seeks at 500ms: 1 (correct - initial only)
- Seeks at 1500ms: 2 (INCORRECT - should be 1, within grace period)
- Seeks at 2000ms: 2 (INCORRECT - should be 1, grace period just ending)

**Analysis**:
This test specifically checks whether drift correction respects a grace period after initial sync. The results show:
- Drift correction triggered at the 1500ms mark
- This is within the expected 2000ms grace period
- The system currently has NO grace period mechanism

The bug is confirmed because drift correction should NOT trigger within 2 seconds of an initial playback update, but it does.

### Test Case 3: Multiple Rapid Playback Updates

**Status**: ✓ **Expected Behavior**

**Observation**:
- Seeks from playback updates: 3
- Total seeks after drift correction: 3
- No additional seeks from drift correction

**Analysis**:
This test simulates rapid playback updates (e.g., during network recovery). Interestingly, this case passes because:
- The three rapid seeks happen within 900ms (at t=0ms, t=300ms, t=600ms)
- The drift correction interval (1500ms) hasn't fired yet
- By the time drift correction would fire (at t=900ms + 1500ms = 2400ms), the position is correct

This suggests the bug is **timing-dependent** and specifically affects the window between initial sync and the first drift correction interval (0-1500ms after sync).

## Root Cause Analysis Confirmation

The test results confirm the hypothesized root cause from the design document:

1. **No Grace Period After Remote Updates**: The drift correction hook does not have any mechanism to suppress its execution after `controls.play()` is called from the room page effect.

2. **Timing Race**: When a `playback_updated` event arrives and triggers `controls.play(t)` at the room page (line 148), the drift correction interval may fire 100-1500ms later and detect artificial "drift" caused by:
   - YouTube player still processing the seek
   - Slight position discrepancies during the seek operation
   - Clock offset calculation timing

3. **Missing Coordination**: There is no communication between the room page effect (which applies remote updates) and the drift correction hook (which monitors for drift). They operate independently, leading to interference.

## Expected Fix Behavior

When the fix is implemented (as described in design.md Task 3.1), these test cases should:

1. **Test Case 1**: Should PASS - total seeks <= 1 (only initial sync)
2. **Test Case 2**: Should PASS - seeks at 1500ms and 2000ms <= 1 (grace period respected)
3. **Test Case 3**: Should continue to PASS (no regression)

## Validation Criteria

The fix will be considered successful when:
- All 3 test cases in `useDriftCorrection.test.ts` pass
- Seek count within 3 seconds of initial sync is <= 1
- Drift correction does not trigger within 2 seconds of a remote playback update
- Legitimate drift correction continues to work after the grace period expires

## Next Steps

1. Implement the fix as described in `design.md` Task 3.1:
   - Add `lastRemoteUpdateRef` to track remote update timestamp
   - Add `REMOTE_UPDATE_GRACE_MS = 2000` constant
   - Add grace period check in drift correction interval
   - Expose `notifyRemoteUpdate()` method from the hook
   - Call `notifyRemoteUpdate()` from room page effect after `controls.play()`

2. Re-run the same tests on the FIXED code to verify all tests pass

3. Write preservation tests (Task 2) to ensure no regressions in existing functionality
