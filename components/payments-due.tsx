'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { StatusPill } from '@/components/status-pill'
import { formatPence } from '@/lib/domain/payments'
import { PITCH_SESSIONS_ENABLED } from '@/lib/features'
import { getSupabaseBrowserClient } from '@/lib/supabase/client'

interface MySession {
  session_id: string; title: string; starts_at: string; status: string; venue: string | null; pitch: string | null; attendance: string
  share_pence: number; paid_pence: number; outstanding_pence: number
  request: { id: string; amount_pence: number; status: string; due_at: string | null } | null
}

/** The signed-in player's pitch sessions: their share, what they have paid and anything to pay. Hidden when there are none. */
export function PaymentsDue() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), [])
  const [rows, setRows] = useState<MySession[]>([])
  useEffect(() => {
    if (!PITCH_SESSIONS_ENABLED) return
    let active = true
    supabase.rpc('my_pitch_payments').then(({ data, error }) => { if (active && !error) setRows((data ?? []) as MySession[]) })
    return () => { active = false }
  }, [supabase])
  if (rows.length === 0) return null
  const due = rows.filter((row) => row.request && ['PENDING', 'FAILED'].includes(row.request.status))
  return <section className="card section">
    <p className="eyebrow">PITCH PAYMENTS</p>
    <h2>{due.length ? (due.length === 1 ? 'You have a share to pay' : `You have ${due.length} shares to pay`) : 'Your pitch sessions'}</h2>
    {rows.map((row) => {
      const payable = row.request && ['PENDING', 'FAILED'].includes(row.request.status)
      const paid = row.share_pence > 0 && row.outstanding_pence <= 0
      return <div className="player-row" key={row.session_id}>
        <div className="player-copy">
          <strong>{row.title}</strong>
          <small>{new Date(row.starts_at).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}{row.venue ? ` · ${row.venue}` : ''}{row.pitch ? ` · ${row.pitch}` : ''}</small>
          <small>{row.attendance === 'CONFIRMED' ? `Your share ${formatPence(row.share_pence)}` : row.attendance === 'CANCELLED' ? 'You are marked as not playing' : 'Attendance not confirmed yet'}{row.paid_pence > 0 ? ` · paid ${formatPence(row.paid_pence)}` : ''}{row.request?.due_at && payable ? ` · pay by ${new Date(row.request.due_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}</small>
        </div>
        {payable ? <Link className="primary-button" href={`/pay/?r=${row.request!.id}`}>Pay {formatPence(row.request!.amount_pence)}</Link>
          : paid ? <StatusPill status="PAID" />
          : row.outstanding_pence < 0 ? <span className="muted">Credit {formatPence(-row.outstanding_pence)}</span>
          : row.share_pence > 0 ? <span className="muted">Payment link coming</span> : null}
      </div>
    })}
  </section>
}
