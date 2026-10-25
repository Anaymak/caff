import type { Metadata } from 'next'
import { Suspense } from 'react'
import PayClient from './client'

export const metadata: Metadata = { title: 'Pay your share', robots: { index: false, follow: false } }

export default function PayPage() {
  return <Suspense fallback={<main className="pay-page"><div className="spinner" /></main>}><PayClient /></Suspense>
}
