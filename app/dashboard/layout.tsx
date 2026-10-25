import type { Metadata } from 'next'
import { AppShell } from '@/components/app-shell'

// Members-only pages: keep them out of search results.
export const metadata: Metadata = { robots: { index: false, follow: false } }

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>
}
