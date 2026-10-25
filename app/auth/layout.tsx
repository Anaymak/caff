import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Sign in', alternates: { canonical: '/auth/' } }

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return children
}
