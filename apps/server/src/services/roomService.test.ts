/**
 * Cold-Start Recovery Unit Tests
 * Tests the computeRecoveryState function from roomService
 */

/**
 * Unit tests: Cold-start room recovery (pure function, no DB)
 */
import { describe, it, expect } from 'vitest';
import { computeRecoveryState } from '../utils/roomRecovery';

describe('computeRecoveryState', () => {
  const NOW = Date.now();

  it('restores PAUSED room as PAUSED at the last known position', () => {
    const lastUpdated = new Date(NOW - 30_000); // 30 seconds ago
    const result = computeRecoveryState('PAUSED', 45.0, lastUpdated, 3);
    expect(result.status).toBe('PAUSED');
    expect(result.anchorPositionSeconds).toBe(45.0);
    expect(result.stateVersion).toBe(3);
  });

  it('restores PLAYING room as PLAYING with elapsed time added (within 60s)', () => {
    const lastUpdated = new Date(NOW - 10_000); // 10 seconds ago
    const result = computeRecoveryState('PLAYING', 100.0, lastUpdated, 5);
    expect(result.status).toBe('PLAYING');
    // Should be around 110 (100 + 10 elapsed seconds)
    expect(result.anchorPositionSeconds).toBeGreaterThan(109);
    expect(result.anchorPositionSeconds).toBeLessThan(111);
  });

  it('restores PLAYING room as PAUSED if elapsed > 60s (extended downtime)', () => {
    const lastUpdated = new Date(NOW - 90_000); // 90 seconds ago
    const result = computeRecoveryState('PLAYING', 200.0, lastUpdated, 7);
    expect(result.status).toBe('PAUSED');
    // Position should be frozen at the last known position, not advanced
    expect(result.anchorPositionSeconds).toBe(200.0);
  });

  it('restores PLAYING room exactly at 59s boundary as PLAYING', () => {
    const lastUpdated = new Date(NOW - 59_000);
    const result = computeRecoveryState('PLAYING', 0, lastUpdated, 1);
    expect(result.status).toBe('PLAYING');
  });

  it('restores PLAYING room exactly at 60s boundary as PAUSED', () => {
    const lastUpdated = new Date(NOW - 60_500); // just past 60s
    const result = computeRecoveryState('PLAYING', 0, lastUpdated, 1);
    expect(result.status).toBe('PAUSED');
  });
});
