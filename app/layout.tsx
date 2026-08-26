import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL('https://gtm-control-tower.pages.dev'),
  title: 'GTM Control Tower · Bad CRM data in, defensible action out',
  description: 'A self-hosted revenue systems lab that maps messy lead files, executes governed CRM repairs, and returns auditable receipts.',
  openGraph: {
    title: 'GTM Control Tower',
    description: 'Watch 64 deliberately messy leads become a governed, destination-ready batch.',
    type: 'website',
    images: [
      {
        url: '/og.png',
        width: 1731,
        height: 909,
        alt: 'GTM Control Tower turns bad CRM data into defensible action.',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'GTM Control Tower',
    description: 'Watch 64 deliberately messy leads become a governed, destination-ready batch.',
    images: ['/og.png'],
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
