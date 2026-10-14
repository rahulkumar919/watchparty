/**
 * YouTube Video ID Utilities
 *
 * Validates and extracts YouTube video IDs from various URL formats.
 * Tests in: src/utils/youtube.test.ts
 *
 * Supported formats:
 *   - Standard:   https://www.youtube.com/watch?v=dQw4w9WgXcQ
 *   - Short URL:  https://youtu.be/dQw4w9WgXcQ
 *   - Embed:      https://www.youtube.com/embed/dQw4w9WgXcQ
 *   - Shorts:     https://www.youtube.com/shorts/dQw4w9WgXcQ
 *   - With params: https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=120&list=...
 *   - Bare ID:    dQw4w9WgXcQ
 */

const VIDEO_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;

/**
 * Returns true if the string is a valid YouTube video ID.
 * A video ID is exactly 11 alphanumeric characters (plus hyphens and underscores).
 */
export function isValidVideoId(id: string): boolean {
  return VIDEO_ID_REGEX.test(id);
}

/**
 * Extracts a YouTube video ID from a URL or bare ID string.
 * Returns the extracted video ID string, or null if extraction fails.
 *
 * Security note: We parse with the URL constructor rather than regexing the raw
 * string, which prevents bypass via unusual URL encoding or fragment manipulation.
 */
export function extractVideoId(input: string): string | null {
  const trimmed = input.trim();

  // If it's already a bare video ID, return it directly
  if (isValidVideoId(trimmed)) {
    return trimmed;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null; // Not a valid URL and not a bare ID
  }

  const hostname = url.hostname.replace(/^www\./, '');

  if (hostname === 'youtube.com' || hostname === 'm.youtube.com') {
    // /watch?v=VIDEO_ID
    if (url.pathname === '/watch') {
      const v = url.searchParams.get('v');
      if (v && isValidVideoId(v)) return v;
    }

    // /embed/VIDEO_ID
    if (url.pathname.startsWith('/embed/')) {
      const id = url.pathname.split('/embed/')[1]?.split('?')[0];
      if (id && isValidVideoId(id)) return id;
    }

    // /shorts/VIDEO_ID
    if (url.pathname.startsWith('/shorts/')) {
      const id = url.pathname.split('/shorts/')[1]?.split('?')[0];
      if (id && isValidVideoId(id)) return id;
    }

    // /v/VIDEO_ID (legacy)
    if (url.pathname.startsWith('/v/')) {
      const id = url.pathname.split('/v/')[1]?.split('?')[0];
      if (id && isValidVideoId(id)) return id;
    }
  }

  if (hostname === 'youtu.be') {
    // youtu.be/VIDEO_ID
    const id = url.pathname.slice(1).split('?')[0];
    if (id && isValidVideoId(id)) return id;
  }

  return null;
}
