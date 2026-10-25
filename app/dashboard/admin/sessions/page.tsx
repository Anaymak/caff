'use client'

import Link from 'next/link'
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '@/components/auth-provider'
import { StatusPill } from '@/components/status-pill'
import { DEFAULT_FEES, type FeeMode, formatPence, parsePounds, previewSplit } from '@/lib/domain/payments'
import { downloadCsv } from '@/lib/csv'
import { friendlyError } from '@/lib/payments-api'
import { getSupabaseBrowserClient } from '@/lib/supabase/client'
import type { FinancePermission, SessionListItem, Venue } from '@/lib/types'

const scopes = [
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'outstanding', label: 'Money outstanding' },
  { id: 'past', label: 'Past, not completed' },
  { id: 'completed', label: 'Completed' },
  { id: 'cancelled', label: 'Cancelled' },
  { id: 'all', label: 'All' },
  { id: 'test', label: 'Test sessions' },
] as const

export default function SessionsPage() {
  const { profile } = useAuth()
  const supabase = useMemo(() => getSupabaseBrowserClient(), [])
  const [permissions, setPermissions] = useState<FinancePermission[] | null>(null)
  const [scope, setScope] = useState<(typeof scopes)[number]['id']>('upcoming')
  const [sessions, setSessions] = useState<SessionListItem[] | null>(null)
  const [venues, setVenues] = useState<Venue[]>([])
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [cost, setCost] = useState('60.00')
  const [players, setPlayers] = useState('10')
  const [feeMode, setFeeMode] = useState<FeeMode>('ABSORB')

  const load = useCallback(async () => {
    const [perms, list, venueList] = await Promise.all([
      supabase.rpc('my_finance_permissions'),
      supabase.rpc('get_pitch_sessions', { p_scope: scope }),
      supabase.from('venues').select('*').eq('active', true).order('name'),
    ])
    setPermissions((perms.data ?? []) as FinancePermission[])
    setVenues((venueList.data ?? []) as Venue[])
    if (list.error) { setSessions([]); if (!list.error.message.startsWith('PERMISSION_DENIED')) setMessage({ tone: 'error', text: 'Could not load sessions. Refresh to try again.' }) }
    else setSessions((list.data ?? []) as SessionListItem[])
  }, [scope, supabase])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (profile?.role === 'ADMIN') void load()
  }, [load, profile?.role])

  if (profile?.role !== 'ADMIN') return <div className="card empty-state"><h2>Admin access only</h2><p className="muted">This area is restricted.</p></div>
  const can = (permission: FinancePermission) => Boolean(permissions?.includes(permission))
  const canView = can('sessions.manage') || can('attendance.manage') || can('finance.view')
  const finance = can('finance.view')
  const previewCost = parsePounds(cost)
  const preview = previewCost !== null && Number(players) > 0 ? previewSplit(previewCost, Number(players), feeMode, DEFAULT_FEES) : null

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const pence = parsePounds(String(form.get('cost')))
    if (pence === null) return setMessage({ tone: 'error', text: 'Enter the pitch cost in pounds, for example 60 or 72.50.' })
    const start = String(form.get('starts_at'))
    const deadline = String(form.get('deadline') || '')
    setBusy(true)
    const { data, error } = await supabase.rpc('create_pitch_session', {
      p_title: String(form.get('title')), p_starts_at: new Date(start).toISOString(), p_duration_minutes: Number(form.get('duration')),
      p_venue_id: String(form.get('venue_id')) || null, p_venue_name: String(form.get('venue_name') || ''),
      p_pitch_name: String(form.get('pitch_name') || ''), p_pitch_type: String(form.get('pitch_type') || ''),
      p_pitch_cost_pence: pence, p_fee_mode: feeMode, p_notes: String(form.get('notes') || ''),
      p_payment_deadline: deadline ? new Date(deadline).toISOString() : null, p_status: String(form.get('status')), p_match_id: null,
    })
    setBusy(false)
    if (error) return setMessage({ tone: 'error', text: friendlyError(error.message) })
    window.location.assign(`/dashboard/admin/sessions/view/?id=${data}`)
  }

  function exportCsv() {
    if (!sessions) return
    downloadCsv(`caff-sessions-${scope}.csv`, [
      ['Date', 'Kick-off', 'Session', 'Venue', 'Pitch', 'Status', 'Pitch cost', 'Chargeable players', 'Per person', 'Paid', 'Unpaid',
        'Gross received', 'Refunded', 'Stripe fees (actual)', 'Stripe fees (estimated, unconfirmed)', 'Net received', 'Outstanding', 'Covered'],
      ...sessions.map((s) => {
        const t = s.totals; const d = new Date(s.starts_at)
        return [d.toLocaleDateString('en-GB'), d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }), s.title,
          s.venue?.name ?? s.venue_name ?? '', s.pitch_name ?? '', s.status, pence(s.pitch_cost_pence), t.chargeable_count, pence(t.base_share_pence),
          t.paid_count ?? '', t.unpaid_count ?? '', pence(t.gross_received_pence), pence(t.refunded_pence), pence(t.fees_actual_pence),
          pence(t.fees_estimated_unconfirmed_pence), pence(t.net_received_pence), pence(t.outstanding_pence), t.covered ? 'Yes' : 'No']
      }),
    ])
  }

  return <>
    <header className="page-header">
      <div><p className="eyebrow">PITCH BOOKINGS</p><h1>Sessions & payments</h1><p className="muted">Pitch costs, attendance, player shares and collections.</p></div>
      <div className="button-row">
        <Link className="secondary-button" href="/dashboard/admin">Back to Admin</Link>
        {(can('settings.manage') || can('owner')) && <Link className="secondary-button" href="/dashboard/admin/payment-settings">Payment settings</Link>}
      </div>
    </header>
    {message && <p className={`notice notice-${message.tone}`} role={message.tone === 'error' ? 'alert' : 'status'}>{message.text}</p>}
    {permissions === null ? <div className="card empty-state"><div className="spinner" aria-label="Loading" /></div> : !canView ? (
      <div className="card empty-state"><h2>No session permissions yet</h2><p className="muted">Ask the CAFF Owner to give you session or finance access in Payment settings.</p></div>
    ) : <>
      <nav className="filter-tabs" aria-label="Session filter">
        {scopes.map((item) => <button key={item.id} type="button" aria-pressed={scope === item.id} className={scope === item.id ? 'active' : ''} onClick={() => setScope(item.id)}>{item.label}</button>)}
        {sessions && sessions.length > 0 && <button type="button" className="text-button" onClick={exportCsv}>Export CSV</button>}
      </nav>
      <section className="section">
        {sessions === null ? <div className="card empty-state"><div className="spinner" aria-label="Loading sessions" /></div>
          : sessions.length === 0 ? <div className="card empty-state"><div className="ball" aria-hidden>⚽</div><h2>No sessions here</h2><p className="muted">{scope === 'upcoming' ? 'Create a session below to start collecting attendance and payments.' : 'Nothing matches this filter.'}</p></div>
          : <div className="session-list">{sessions.map((s) => <SessionCard key={s.id} session={s} finance={finance} />)}</div>}
      </section>
      {can('sessions.manage') && <section className="grid two section">
        <form className="card" onSubmit={create}>
          <p className="eyebrow">NEW SESSION</p><h2>Book a pitch</h2>
          <label>Session name<input name="title" required maxLength={120} defaultValue="Thursday Football" /></label>
          <div className="form-grid">
            <label>Date and kick-off<input name="starts_at" type="datetime-local" required /></label>
            <label>Duration<select name="duration" defaultValue="60">{[45, 60, 75, 90, 120].map((m) => <option key={m} value={m}>{m} minutes</option>)}</select></label>
          </div>
          <div className="form-grid">
            <label>Venue<select name="venue_id"><option value="">Other / not listed</option>{venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
            <label>Venue name if not listed<input name="venue_name" maxLength={120} placeholder="e.g. Powerleague Shoreditch" /></label>
          </div>
          <div className="form-grid">
            <label>Pitch<input name="pitch_name" maxLength={120} placeholder="e.g. Pitch 3" /></label>
            <label>Pitch type<input name="pitch_type" maxLength={60} placeholder="e.g. 5-a-side 3G" /></label>
          </div>
          <div className="form-grid">
            <label>Pitch hire cost (£)<input name="cost" inputMode="decimal" required value={cost} onChange={(e) => setCost(e.target.value)} aria-describedby="cost-help" /></label>
            <label>Status<select name="status" defaultValue="OPEN"><option value="PLANNING">Planning</option><option value="OPEN">Open</option><option value="CONFIRMED">Confirmed</option></select></label>
          </div>
          <p className="field-help" id="cost-help">Set per booking: different venues and pitches cost different amounts.</p>
          <fieldset className="choice-group">
            <legend>Card processing fees</legend>
            <label className="inline-check"><input type="radio" name="fee_mode" checked={feeMode === 'ABSORB'} onChange={() => setFeeMode('ABSORB')} />CAFF absorbs fees (players split the pitch cost)</label>
            <label className="inline-check"><input type="radio" name="fee_mode" checked={feeMode === 'COVER_IN_PRICE'} onChange={() => setFeeMode('COVER_IN_PRICE')} />Set the price to cover estimated fees (same price for everyone)</label>
          </fieldset>
          <label>Payment deadline (optional)<input name="deadline" type="datetime-local" /></label>
          <label>Booking notes (optional)<textarea name="notes" maxLength={2000} placeholder="Booking reference, what to bring, parking…" /></label>
          <button className="primary-button" disabled={busy}>{busy ? 'Creating…' : 'Create session'}</button>
        </form>
        <aside className="card">
          <p className="eyebrow">QUICK ESTIMATE</p><h2>What will each player pay?</h2>
          <label>Confirmed players<input type="number" min={1} max={60} value={players} onChange={(e) => setPlayers(e.target.value)} /></label>
          {preview ? <dl className="figure-list">
            <div><dt>Pitch cost</dt><dd>{formatPence(previewCost)}</dd></div>
            <div><dt>Each player pays</dt><dd>{formatPence(preview.base)}{preview.remainder > 0 && <small> ({preview.remainder} pay {formatPence(preview.base + 1)})</small>}</dd></div>
            {feeMode === 'COVER_IN_PRICE' && <div><dt>Added to cover fees</dt><dd>{formatPence(preview.feeCover)}</dd></div>}
            <div><dt>Estimated Stripe fees if all pay by card</dt><dd>{formatPence(preview.estimatedFees)}</dd></div>
            <div><dt>Expected after fees</dt><dd>{formatPence(preview.expectedNet)}</dd></div>
          </dl> : <p className="muted">Enter a cost and number of players.</p>}
          <p className="field-help">Estimate only, using the standard UK card rate of 1.5% + 20p per payment. Actual fees depend on the card and your Stripe pricing; the session page shows real fees once Stripe reports them.</p>
        </aside>
      </section>}
    </>}
  </>
}

const pence = (value: number | null | undefined) => (value === null || value === undefined ? '' : (value / 100).toFixed(2))

function SessionCard({ session: s, finance }: { session: SessionListItem; finance: boolean }) {
  const t = s.totals
  const date = new Date(s.starts_at)
  return <Link className="card session-card" href={`/dashboard/admin/sessions/view/?id=${s.id}`}>
    <div className="date-tile" aria-hidden><span>{date.toLocaleString('en-GB', { month: 'short' })}</span><strong>{date.getDate()}</strong></div>
    <div className="session-card-main">
      <div className="session-card-title"><strong>{s.title}</strong><StatusPill status={s.status} />{s.is_test && <span className="status-pill status-test">Test</span>}</div>
      <p className="muted">{date.toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })} · {s.venue?.name ?? s.venue_name ?? 'Venue TBC'}{s.pitch_name ? ` · ${s.pitch_name}` : ''}</p>
      <dl className="session-figures">
        <div><dt>Pitch</dt><dd>{formatPence(s.pitch_cost_pence)}</dd></div>
        <div><dt>Players</dt><dd>{t.chargeable_count}</dd></div>
        <div><dt>Each</dt><dd>{t.chargeable_count ? formatPence(t.base_share_pence) : '—'}</dd></div>
        {finance && <>
          <div><dt>Paid</dt><dd>{t.paid_count}/{t.chargeable_count}</dd></div>
          <div><dt>Net in</dt><dd>{formatPence(t.net_received_pence)}{t.fees_include_estimates ? '*' : ''}</dd></div>
          <div><dt>Outstanding</dt><dd className={t.outstanding_pence ? 'text-warn' : ''}>{formatPence(t.outstanding_pence)}</dd></div>
        </>}
      </dl>
    </div>
    {finance && <span className={`coverage ${t.covered ? 'coverage-ok' : 'coverage-short'}`}>{t.covered ? 'Covered' : `${formatPence(t.shortfall_pence)} short`}</span>}
  </Link>
}
