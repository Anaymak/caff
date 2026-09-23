import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AuthProvider } from '@/components/auth-provider'

export const metadata: Metadata = {
  title: { default: 'CAFF', template: '%s · CAFF' },
  description: 'Casual football, organised.',
  applicationName: 'CAFF',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '64x64' },
      { url: '/icons/icon-192.png', type: 'image/png', sizes: '192x192' },
    ],
    apple: [{ url: '/icons/icon-192.png', type: 'image/png', sizes: '192x192' }],
  },
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'CAFF' },
};

export const viewport: Viewport = { themeColor: '#101d17' }

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body><AuthProvider>{children}</AuthProvider></body>
    </html>
  );
}
