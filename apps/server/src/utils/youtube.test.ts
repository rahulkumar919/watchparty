/**
 * Unit tests: YouTube URL parser
 * Run: npm run test --workspace=apps/server
 */

import { describe, it, expect } from 'vitest';
import { extractVideoId, isValidVideoId } from '../utils/youtube';

describe('isValidVideoId', () => {
  it('accepts a valid 11-char video ID', () => {
    expect(isValidVideoId('dQw4w9WgXcQ')).toBe(true);
  });

  it('accepts IDs with hyphens and underscores', () => {
    expect(isValidVideoId('dQw4w9-gXcQ')).toBe(true);
    expect(isValidVideoId('dQw4w9_gXcQ')).toBe(true);
  });

  it('rejects IDs shorter than 11 chars', () => {
    expect(isValidVideoId('dQw4w9W')).toBe(false);
  });

  it('rejects IDs longer than 11 chars', () => {
    expect(isValidVideoId('dQw4w9WgXcQX')).toBe(false);
  });

  it('rejects IDs with invalid characters', () => {
    expect(isValidVideoId('dQw4w9WgX!Q')).toBe(false);
    expect(isValidVideoId('dQw4w9WgX Q')).toBe(false);
  });
});

describe('extractVideoId', () => {
  const VALID_ID = 'dQw4w9WgXcQ';

  describe('standard YouTube URLs', () => {
    it('extracts from watch URL', () => {
      expect(extractVideoId(`https://www.youtube.com/watch?v=${VALID_ID}`)).toBe(VALID_ID);
    });

    it('extracts from watch URL with extra params', () => {
      expect(extractVideoId(`https://www.youtube.com/watch?v=${VALID_ID}&t=120&list=PLxxx`)).toBe(VALID_ID);
    });

    it('extracts from mobile URL (m.youtube.com)', () => {
      expect(extractVideoId(`https://m.youtube.com/watch?v=${VALID_ID}`)).toBe(VALID_ID);
    });
  });

  describe('short URLs', () => {
    it('extracts from youtu.be', () => {
      expect(extractVideoId(`https://youtu.be/${VALID_ID}`)).toBe(VALID_ID);
    });

    it('extracts from youtu.be with timestamp', () => {
      expect(extractVideoId(`https://youtu.be/${VALID_ID}?t=42`)).toBe(VALID_ID);
    });
  });

  describe('embed and shorts URLs', () => {
    it('extracts from embed URL', () => {
      expect(extractVideoId(`https://www.youtube.com/embed/${VALID_ID}`)).toBe(VALID_ID);
    });

    it('extracts from shorts URL', () => {
      expect(extractVideoId(`https://www.youtube.com/shorts/${VALID_ID}`)).toBe(VALID_ID);
    });
  });

  describe('bare video IDs', () => {
    it('returns a bare valid ID directly', () => {
      expect(extractVideoId(VALID_ID)).toBe(VALID_ID);
    });
  });

  describe('invalid inputs', () => {
    it('returns null for a random string', () => {
      expect(extractVideoId('not-a-url')).toBeNull();
    });

    it('returns null for a URL with no video ID', () => {
      expect(extractVideoId('https://www.youtube.com/watch')).toBeNull();
    });

    it('returns null for a non-YouTube URL', () => {
      expect(extractVideoId('https://vimeo.com/123456789')).toBeNull();
    });

    it('returns null for an empty string', () => {
      expect(extractVideoId('')).toBeNull();
    });

    it('returns null for a URL with an invalid video ID parameter', () => {
      expect(extractVideoId('https://www.youtube.com/watch?v=tooshort')).toBeNull();
    });
  });
});
