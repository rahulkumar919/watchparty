import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Watch Party Room | WatchParty',
  description: 'Watch YouTube videos in perfect sync with your friends.',
  robots: { index: false },
};

export default function RoomLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
