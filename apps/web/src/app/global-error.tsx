'use client';

// Prevent Next.js from prerendering the global error boundary.
// Without this, the /_global-error route crashes during static generation
// because useContext returns null in the Node.js build environment.
export const dynamic = 'force-dynamic';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#0e0e10', color: '#f4f4f6', fontFamily: 'system-ui,sans-serif', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <div style={{ textAlign: 'center', padding: '0 24px' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
          <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Something went wrong</h2>
          <p style={{ color: 'rgba(255,255,255,0.45)', marginBottom: 24, fontSize: 14 }}>
            {error?.message ?? 'An unexpected error occurred.'}
          </p>
          <button
            onClick={reset}
            style={{ padding: '10px 24px', background: '#7c3aed', border: 'none', borderRadius: 10, color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
