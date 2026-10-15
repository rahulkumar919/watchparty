import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'WatchParty — Watch YouTube Together',
    template: '%s | WatchParty',
  },
  description:
    'Watch YouTube videos in perfect sync with friends. Create a room, share the link, and enjoy real-time synchronized playback.',
  keywords: ['watch party', 'youtube', 'sync', 'real-time', 'watch together'],
  openGraph: {
    title: 'WatchParty — Watch YouTube Together',
    description: 'Watch YouTube videos in perfect sync with friends.',
    type: 'website',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
      </head>
      <body>{children}</body>
    </html>
  );
}
