import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '@/styles/globals.css';

export const metadata: Metadata = {
  title: 'Regelradar',
  description: 'Een rustig overzicht van wat aandacht vraagt.',
  icons: { icon: '/favicon.svg' },
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="nl">
      <body>{children}</body>
    </html>
  );
}
