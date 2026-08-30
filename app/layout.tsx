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
  description: 'Audit a CRM contact export privately in your browser, then execute governed repairs and return auditable receipts.',
  openGraph: {
    title: 'GTM Control Tower',
    description: 'Audit a CRM export privately in your browser and turn messy records into governed action.',
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
    description: 'Audit a CRM export privately in your browser and turn messy records into governed action.',
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
