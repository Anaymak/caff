'use client'

import Image from 'next/image'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import { formatPence, payStatus } from '@/lib/domain/payments'
import { paymentsApi } from '@/lib/payments-api'
import { StatusPill } from '@/components/status-pill'

interface Summary {
  id: string; status: string; amount_pence: number; due_at: string | null; payable: boolean; player: string; title: string
  starts_at: string; duration_minutes: number; venue: string | null; pitch: string | null; session_status: string; superseded_by: string | null; mode: 'test' | 'live'
}

const closedText: Record<string, string> = {
  PAID: 'This share has been paid. Thank you!', MANUALLY_PAID: 'This share has been marked as paid by a CAFF admin. Thank you!',
  REFUNDED: 'This payment was refunded.', CANCELLED: 'This payment request was cancelled. Nothing is owed on this link.',
  SUPERSEDED: 'The amount for this session changed, so this link was replaced.',
}

export default function PayClient() {
  const params = useSearchParams()
  const id = params.get('r') ?? ''
  const result = params.get('result')
  const [summary, setSummary] = useState<Summary | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [checks, setChecks] = useState(0)

  useEffect(() => {
    let active = true
    if (!id) return
    paymentsApi<Summary>(`/pay/request?id=${encodeURIComponent(id)}`)
      .then((data) => { if (active) setSummary(data) })
      .catch((reason: Error) => { if (active) setError(reason.message) })
    return () => { active = false }
  }, [id, checks])

  // After Stripe redirects back, the page waits for the verified webhook rather than trusting the redirect.
  useEffect(() => {
    if (result !== 'success' || !summary || summary.status === 'PAID' || checks >= 8) return
    const timer = setTimeout(() => setChecks((n) => n + 1), 2500)
    return () => clearTimeout(timer)
  }, [result, summary, checks])

  async function pay() {
    setBusy(true); setError('')
    try {
      const { url } = await paymentsApi<{ url: string }>('/pay/checkout', { method: 'POST', body: { id } })
      window.location.assign(url)
    } catch (reason) {
      const err = reason as Error & { reason?: string }
      setError(err.reason === 'needs_review' ? 'This amount is being updated by a CAFF admin. Please wait for a new link.' : err.reason ? 'This link can no longer be paid. Refresh the page for details.' : err.message)
      setBusy(false)
    }
  }

  const linkError = id ? error : 'This payment link is incomplete. Ask a CAFF admin for a new one.'
  const start = summary ? new Date(summary.starts_at) : null
  const waiting = result === 'success' && summary?.payable
  const payState = summary ? payStatus(summary, Boolean(waiting)) : null
  return <main className="pay-page">
    <div className="pay-card card">
      <div className="pay-brand"><Image src="/brand/caff-logo-128.png" alt="CAFF League" width={56} height={56} priority /><span><strong>CAFF</strong><small>Pitch payment</small></span></div>
      {summary?.mode === 'test' && <p className="notice notice-warn">Test mode: no real money is taken. Use card 4242 4242 4242 4242.</p>}
      {!summary && !linkError && <div className="pay-loading"><div className="spinner" aria-label="Loading payment" /><p className="muted">Loading your payment…</p></div>}
      {linkError && !summary && <><h1>Payment link problem</h1><p className="muted">{linkError}</p></>}
      {summary && start && <>
        <p className="eyebrow">HI {summary.player.toUpperCase()}</p>
        <h1>{summary.title}</h1>
        <p className="match-meta"><span>{start.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</span><span>{start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} · {summary.duration_minutes} min</span>{summary.venue && <span>{summary.venue}{summary.pitch ? ` · ${summary.pitch}` : ''}</span>}</p>
        <div className="pay-amount"><span>Your share of the pitch</span><strong>{formatPence(summary.amount_pence)}</strong>{payState && <StatusPill status={payState} className="pay-status" />}{summary.due_at && (payState === 'DUE' || payState === 'FAILED') && <small>Please pay by {new Date(summary.due_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</small>}</div>
        {summary.session_status === 'CANCELLED' ? <p className="notice notice-warn">This session was cancelled. Nothing is owed on this link.</p>
          : !summary.payable ? <p className={`notice ${['PAID', 'MANUALLY_PAID'].includes(summary.status) ? 'notice-ok' : 'notice-warn'}`}>{closedText[summary.status] ?? 'This link can no longer be paid.'}{summary.superseded_by && <> <Link href={`/pay/?r=${summary.superseded_by}`}>Open the new link</Link>.</>}</p>
          : waiting ? <div className="notice notice-ok" role="status">{checks < 8 ? <><div className="spinner spinner-sm" /> Payment received by Stripe. Confirming…</> : <>Stripe is still confirming your payment. Do not pay again: you will not be charged twice, and it will show as paid once confirmed. <button type="button" className="text-button" onClick={() => setChecks(0)}>Check again</button></>}</div>
          : <>
            {result === 'cancelled' && <p className="notice notice-warn">Payment not completed. You have not been charged.</p>}
            {summary.status === 'FAILED' && <p className="notice notice-warn">Your last payment attempt did not go through. You can try again.</p>}
            <button className="primary-button" onClick={() => void pay()} disabled={busy}>{busy ? 'Opening secure checkout…' : `Pay ${formatPence(summary.amount_pence)} by card`}</button>
            <p className="field-help">You will pay on Stripe’s secure checkout page. CAFF never sees or stores your card details. Paying by bank transfer or cash instead? Tell a CAFF admin and they will record it.</p>
          </>}
        {error && <p className="notice notice-error" role="alert">{error}</p>}
        {(!summary.payable || waiting) && <div className="pay-actions"><Link className="secondary-button" href="/dashboard">Go to your CAFF dashboard</Link></div>}
      </>}
    </div>
    <p className="auth-privacy"><Link href="/privacy">Privacy notice</Link></p>
  </main>
}
