import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Join Watch Party | WatchParty',
  description: 'Join a Watch Party room and watch YouTube videos in sync with friends.',
  robots: { index: false },
};

export default function JoinLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
