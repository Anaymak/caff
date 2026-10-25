import { Suspense } from 'react'
import SessionDetailPage from './client'

// Session id travels as ?id= so the static export needs no extra CloudFront route.
export default function Page() {
  return <Suspense fallback={<div className="card empty-state"><div className="spinner" aria-label="Loading session" /></div>}><SessionDetailPage /></Suspense>
}
