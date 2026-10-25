'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { formatPence } from '@/lib/domain/payments'
import { getSupabaseBrowserClient } from '@/lib/supabase/client'

interface Due { id: string; amount_pence: number; status: string; due_at: string | null; title: string; starts_at: string }

/** The signed-in player's unpaid pitch shares. Renders nothing when there are none. */
export function PaymentsDue() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), [])
  const [due, setDue] = useState<Due[]>([])
  useEffect(() => {
    let active = true
    // Fails quietly before the payments migration is applied.
    supabase.rpc('my_payment_requests').then(({ data, error }) => { if (active && !error) setDue((data ?? []) as Due[]) })
    return () => { active = false }
  }, [supabase])
  if (due.length === 0) return null
  return <section className="card section">
    <p className="eyebrow">PITCH PAYMENTS</p>
    <h2>{due.length === 1 ? 'You have a share to pay' : `You have ${due.length} shares to pay`}</h2>
    {due.map((item) => <div className="player-row" key={item.id}>
      <div className="player-copy"><strong>{item.title}</strong><small>{new Date(item.starts_at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}{item.due_at ? ` · pay by ${new Date(item.due_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}</small></div>
      <Link className="primary-button" href={`/pay/?r=${item.id}`}>Pay {formatPence(item.amount_pence)}</Link>
    </div>)}
  </section>
}
