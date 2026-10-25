'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '@/components/auth-provider'
import { StatusPill } from '@/components/status-pill'
import { downloadCsv } from '@/lib/csv'
import { estimateFee, explainSplit, formatPence, parsePounds } from '@/lib/domain/payments'
import { friendlyError, payLink, paymentsApi, rpcWithConfirm } from '@/lib/payments-api'
import { getSupabaseBrowserClient } from '@/lib/supabase/client'
import type { Payment, Profile, SessionAttendee, SessionDetail, SessionStatus } from '@/lib/types'

type Panel = { kind: 'manual'; attendee: SessionAttendee } | { kind: 'refund'; payment: Payment } | { kind: 'void'; payment: Payment } | null
type Notice = { tone: 'ok' | 'error' | 'warn'; text: string } | null

const methodLabel: Record<Payment['method'], string> = { STRIPE: 'Card (Stripe)', BANK_TRANSFER: 'Bank transfer', CASH: 'Cash', OTHER: 'Other' }
const nextStatuses: Record<SessionStatus, SessionStatus[]> = {
  PLANNING: ['OPEN', 'CONFIRMED'], OPEN: ['PLANNING', 'CONFIRMED', 'COMPLETED'], CONFIRMED: ['OPEN', 'COMPLETED'], COMPLETED: ['CONFIRMED'], CANCELLED: [],
}
const statusAction: Record<SessionStatus, string> = { PLANNING: 'Back to planning', OPEN: 'Open', CONFIRMED: 'Mark booked & confirmed', COMPLETED: 'Mark completed', CANCELLED: 'Cancel session' }
const toLocalInput = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date(iso).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '')
const minus = (pence: number | undefined) => (pence ? `−${formatPence(pence)}` : formatPence(0))
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })

export default function SessionDetailPage() {
  const id = useSearchParams().get('id') ?? ''
  const { profile } = useAuth()
  const supabase = useMemo(() => getSupabaseBrowserClient(), [])
  const [detail, setDetail] = useState<SessionDetail | null | undefined>(undefined)
  const [members, setMembers] = useState<Profile[]>([])
  const [matches, setMatches] = useState<Array<{ id: string; title: string; starts_at: string }>>([])
  const [notice, setNotice] = useState<Notice>(null)
  const [busy, setBusy] = useState(false)
  const [panel, setPanel] = useState<Panel>(null)

  const load = useCallback(async () => {
    const [d, m, games] = await Promise.all([
      supabase.rpc('get_pitch_session', { p_session: id }),
      supabase.from('profiles').select('id,full_name,nickname,status').eq('status', 'APPROVED').order('full_name'),
      supabase.from('matches').select('id,title,starts_at').order('starts_at', { ascending: false }).limit(8),
    ])
    if (d.error) { setNotice({ tone: 'error', text: friendlyError(d.error.message) || 'Could not load this session.' }); setDetail(null); return }
    setDetail((d.data ?? null) as SessionDetail | null)
    setMembers((m.data ?? []) as Profile[])
    setMatches(games.data ?? [])
  }, [id, supabase])

  useEffect(() => {
    if (profile?.role === 'ADMIN' && id) void load()
  }, [id, load, profile?.role])

  // Runs a change, shows the outcome and reloads. Returns false when it failed or was cancelled.
  async function run(label: string, action: () => PromiseLike<{ error: { message: string } | null; cancelled?: boolean }>) {
    setBusy(true); setNotice(null)
    try {
      const result = await action()
      if (result.cancelled) return false
      if (result.error) { setNotice({ tone: 'error', text: friendlyError(result.error.message) }); return false }
      setNotice({ tone: 'ok', text: label })
      await load()
      return true
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : 'That did not work. Try again.' })
      return false
    } finally { setBusy(false) }
  }

  if (profile?.role !== 'ADMIN') return <div className="card empty-state"><h2>Admin access only</h2></div>
  if (detail === undefined) return <div className="card empty-state"><div className="spinner" aria-label="Loading session" /><p className="muted">Loading session…</p></div>
  if (!detail) return <div className="card empty-state"><h2>Session not available</h2>{notice && <p className="muted">{notice.text}</p>}<Link className="secondary-button" href="/dashboard/admin/sessions">All sessions</Link></div>

  const { session: s, totals: t, attendees, can } = detail
  const requests = detail.requests ?? []
  const payments = detail.payments ?? []
  const cancelled = s.status === 'CANCELLED'
  const date = new Date(s.starts_at)
  const fees = { percentBps: t.fee_percent_bps, fixedPence: t.fee_fixed_pence }
  const counted = attendees.filter((a) => a.share_pence > 0)
  const nameOf = (attendeeId: string) => attendees.find((a) => a.id === attendeeId)?.display_name ?? 'Unknown'
  const activeRequests = requests.filter((r) => r.status === 'PENDING' || r.status === 'FAILED')
  const toIssue = counted.filter((a) => (a.outstanding_pence ?? 0) >= 30 && a.active_request_pence !== a.outstanding_pence).length
  const deadlinePassed = s.payment_deadline && new Date(s.payment_deadline) < new Date()

  const setStatus = (status: SessionStatus) => {
    let reason: string | null = null
    if (status === 'CANCELLED') {
      reason = window.prompt('Reason for cancelling (shown in the audit history). Unpaid payment links will stop working; money already received stays recorded for refund.')
      if (!reason?.trim()) return
    }
    void run(`Session marked ${status.toLowerCase()}.`, async () => {
      const result = await supabase.rpc('set_pitch_session_status', { p_session: s.id, p_status: status, p_reason: reason })
      if (!result.error && status === 'CANCELLED' && can.request) await paymentsApi('/admin/expire-checkouts', { method: 'POST', admin: true, body: { sessionId: s.id } }).catch(() => undefined)
      return result
    })
  }

  async function saveSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const pence = parsePounds(String(form.get('cost')))
    if (pence === null) return setNotice({ tone: 'error', text: 'Enter the pitch cost in pounds, for example 60 or 72.50.' })
    const deadline = String(form.get('deadline') || '')
    if (pence !== s.pitch_cost_pence && !window.confirm(`Change the pitch cost from ${formatPence(s.pitch_cost_pence)} to ${formatPence(pence)}?`)) return
    await run('Session saved.', () => rpcWithConfirm((confirm) => supabase.rpc('update_pitch_session', {
      p_session: s.id, p_title: String(form.get('title')), p_starts_at: new Date(String(form.get('starts_at'))).toISOString(),
      p_duration_minutes: Number(form.get('duration')), p_venue_id: String(form.get('venue_id') || '') || s.venue_id,
      p_venue_name: String(form.get('venue_name') || ''), p_pitch_name: String(form.get('pitch_name') || ''), p_pitch_type: String(form.get('pitch_type') || ''),
      p_pitch_cost_pence: pence, p_fee_mode: String(form.get('fee_mode')), p_notes: String(form.get('notes') || ''),
      p_payment_deadline: deadline ? new Date(deadline).toISOString() : null, p_match_id: s.match_id, p_confirm_payment_impact: confirm,
    })))
  }

  async function addAttendee(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const member = String(form.get('member') || '')
    const guest = String(form.get('guest') || '').trim()
    if (!member && !guest) return setNotice({ tone: 'error', text: 'Choose a member or type a guest name.' })
    const ok = await run('Player added.', () => rpcWithConfirm((confirm) => supabase.rpc('add_session_attendee', {
      p_session: s.id, p_profile: member || null, p_guest_name: member ? null : guest, p_attendance: String(form.get('attendance')), p_confirm_payment_impact: confirm,
    })))
    if (ok) formElement.reset()
  }

  const updateAttendee = (a: SessionAttendee, attendance: SessionAttendee['attendance'], chargeable: boolean) =>
    run(`${a.display_name} updated.`, () => rpcWithConfirm((confirm) => supabase.rpc('update_session_attendee', {
      p_attendee: a.id, p_attendance: attendance, p_chargeable: chargeable, p_note: a.note ?? '', p_confirm_payment_impact: confirm,
    })))

  async function importMatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const match = String(new FormData(event.currentTarget).get('match') || '')
    if (!match) return
    await run('Playing list imported.', () => supabase.rpc('import_match_attendees', { p_session: s.id, p_match: match }))
  }

  function issueRequests() {
    const summary = `Issue payment requests for ${s.title}?\n\n${explainSplit(t.allocation_total_pence, t.chargeable_count)}\n\n${toIssue} player(s) will get a new or updated payment link. Players who have already paid are not charged again.`
    if (!window.confirm(summary)) return
    void run('Payment requests ready. Copy each link below and send it to the player.', async () => {
      const result = await rpcWithConfirm((confirm) => supabase.rpc('issue_payment_requests', { p_session: s.id, p_expected_version: s.calc_version, p_confirm_changes: confirm }))
      const counts = result.data as { replaced?: number; closed?: number } | null
      if (!result.error && counts && ((counts.replaced ?? 0) + (counts.closed ?? 0)) > 0) {
        await paymentsApi('/admin/expire-checkouts', { method: 'POST', admin: true, body: { sessionId: s.id } }).catch(() => undefined)
      }
      return result
    })
  }

  async function copy(text: string, label: string) {
    try { await navigator.clipboard.writeText(text); setNotice({ tone: 'ok', text: `${label} copied.` }) }
    catch { window.prompt('Copy this:', text) }
  }

  const copyAllLinks = () => copy(activeRequests.map((r) => `${nameOf(r.attendee_id)} – ${formatPence(r.amount_pence)}: ${payLink(r.id)}`).join('\n'), 'All payment links')

  const reconcile = () => run('Stripe fees checked.', async () => {
    const result = await paymentsApi<{ updated: number; checked: number }>('/admin/reconcile-fees', { method: 'POST', admin: true, body: { sessionId: s.id } })
    setNotice({ tone: 'ok', text: `${result.updated} of ${result.checked} payment fee(s) updated from Stripe.` })
    return { error: null }
  })

  function exportCsv() {
    const rows: Array<Array<string | number | null>> = [['Session', s.title], ['Date', when(s.starts_at)], ['Venue', s.venue?.name ?? s.venue_name ?? ''], ['Pitch', [s.pitch_name, s.pitch_type].filter(Boolean).join(' · ')],
      ['Pitch cost', (s.pitch_cost_pence / 100).toFixed(2)], ['Status', s.status], [],
      ['Player', 'Attendance', 'Shares cost', 'Share', 'Paid (net of refunds)', 'Outstanding', 'Request status']]
    for (const a of attendees) {
      const req = requests.find((r) => r.attendee_id === a.id && ['PENDING', 'FAILED'].includes(r.status)) ?? requests.find((r) => r.attendee_id === a.id)
      rows.push([a.display_name, a.attendance, a.chargeable ? 'Yes' : 'No', (a.share_pence / 100).toFixed(2), a.paid_pence === null ? '' : ((a.paid_pence - (a.refunded_pence ?? 0)) / 100).toFixed(2),
        a.outstanding_pence === null ? '' : (a.outstanding_pence / 100).toFixed(2), req?.status ?? ''])
    }
    rows.push([], ['Payment received', 'Player', 'Method', 'Amount', 'Refunded', 'Stripe fee', 'Fee source', 'Status', 'Reference', 'Recorded by', 'Notes'])
    for (const p of payments) rows.push([when(p.received_at), nameOf(p.attendee_id), methodLabel[p.method], (p.amount_pence / 100).toFixed(2), (p.refunded_pence / 100).toFixed(2),
      p.method === 'STRIPE' ? ((p.fee_actual_pence ?? p.fee_estimated_pence) / 100).toFixed(2) : '0.00', p.method !== 'STRIPE' ? 'n/a' : p.fee_actual_pence === null ? 'estimate' : 'Stripe actual',
      p.status, p.reference, p.recorded_by_name, [p.notes, p.void_reason && `Void: ${p.void_reason}`, p.review_note].filter(Boolean).join(' | ')])
    downloadCsv(`caff-${s.starts_at.slice(0, 10)}-${s.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.csv`, rows)
  }

  return <>
    <header className="page-header">
      <div>
        <p className="eyebrow">PITCH SESSION</p>
        <h1>{s.title}</h1>
        <p className="match-meta"><span>{date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</span><span>{date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} · {s.duration_minutes} min</span><span>{s.venue?.name ?? s.venue_name ?? 'Venue TBC'}{s.pitch_name ? ` · ${s.pitch_name}` : ''}{s.pitch_type ? ` (${s.pitch_type})` : ''}</span></p>
      </div>
      <div className="button-row"><StatusPill status={s.status} /><Link className="secondary-button" href="/dashboard/admin/sessions">All sessions</Link></div>
    </header>
    {notice && <p className={`notice notice-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>{notice.text}</p>}
    {s.is_test && <p className="notice notice-warn"><strong>Test session.</strong> Kept for the record but excluded from normal session lists, player views and reporting. Payments here were made in Stripe test mode and are not real money.</p>}
    {cancelled && <p className="notice notice-warn">Cancelled{s.cancelled_reason ? `: ${s.cancelled_reason}` : ''}. Payment links no longer work. {t.gross_received_pence ? `${formatPence((t.gross_received_pence ?? 0) - (t.refunded_pence ?? 0))} received is still held and may need refunding.` : ''}</p>}
    {s.notes && <p className="card booking-notes"><strong>Booking notes</strong><span>{s.notes}</span></p>}

    {can.sessions && !cancelled && <div className="button-row section">
      {nextStatuses[s.status].map((status) => <button key={status} className="secondary-button" disabled={busy} onClick={() => setStatus(status)}>{statusAction[status]}</button>)}
      <button className="danger-button" disabled={busy} onClick={() => setStatus('CANCELLED')}>Cancel session</button>
      {!s.is_test && <button className="text-button" disabled={busy} onClick={() => { if (window.confirm('Mark this as a test session? It stays on record but is hidden from normal lists, player views and reporting.')) void run('Marked as a test session.', () => supabase.rpc('set_pitch_session_test', { p_session: s.id, p_is_test: true })) }}>Mark as test</button>}
    </div>}

    <section className="grid two section">
      <div className="card">
        <p className="eyebrow">COST SPLIT</p>
        <h2>{t.chargeable_count ? `${formatPence(t.base_share_pence)}${t.extra_penny_count ? ` or ${formatPence(t.base_share_pence + 1)}` : ''} each` : 'No one to split between yet'}</h2>
        <dl className="figure-list">
          <div><dt>Pitch hire</dt><dd>{formatPence(t.pitch_cost_pence)}</dd></div>
          {t.fee_mode === 'COVER_IN_PRICE' && <div><dt>Added so fees are covered</dt><dd>{formatPence(t.fee_cover_pence)}</dd></div>}
          <div><dt>Amount shared out</dt><dd>{formatPence(t.allocation_total_pence)}</dd></div>
          <div><dt>Confirmed players sharing</dt><dd>{t.chargeable_count}</dd></div>
          <div><dt>Estimated Stripe fee per card payment</dt><dd>{formatPence(estimateFee(t.base_share_pence, fees))}</dd></div>
          <div><dt>Estimated fees if everyone pays by card</dt><dd>{formatPence(t.estimated_fees_all_stripe_pence)}</dd></div>
          <div><dt>Expected after estimated fees</dt><dd>{formatPence(t.expected_net_all_stripe_pence)}</dd></div>
        </dl>
        <p className="field-help">{explainSplit(t.allocation_total_pence, t.chargeable_count)}</p>
        <p className="field-help">{t.fee_mode === 'ABSORB'
          ? `CAFF absorbs card fees: card payments arrive about ${formatPence(t.estimated_fees_all_stripe_pence)} short of the pitch cost in total.`
          : 'The price includes an allowance for estimated card fees. Everyone pays the same, however they pay: it is not a card surcharge.'} Fees are estimated at {(t.fee_percent_bps / 100).toFixed(2)}% + {formatPence(t.fee_fixed_pence)} per payment; actual Stripe fees replace the estimate once known.</p>
      </div>
      {can.finance ? <div className="card">
        <div className="section-title"><div><p className="eyebrow">COLLECTIONS</p><h2>{t.covered ? 'Pitch covered' : `${formatPence(t.shortfall_pence)} still needed`}</h2></div><span className={`coverage ${t.covered ? 'coverage-ok' : 'coverage-short'}`}>{t.covered ? 'Covered' : 'Not covered'}</span></div>
        <dl className="figure-list">
          <div><dt>Paid / unpaid players</dt><dd>{t.paid_count} / {t.unpaid_count}</dd></div>
          <div><dt>Gross received</dt><dd>{formatPence(t.gross_received_pence)}</dd></div>
          {(t.refunded_pence ?? 0) > 0 && <div><dt>Refunded</dt><dd>{minus(t.refunded_pence)}</dd></div>}
          <div><dt>Stripe fees (actual)</dt><dd>{minus(t.fees_actual_pence)}</dd></div>
          {(t.fees_estimated_unconfirmed_pence ?? 0) > 0 && <div><dt>Stripe fees (estimated, awaiting Stripe)</dt><dd>{minus(t.fees_estimated_unconfirmed_pence)}</dd></div>}
          <div className="figure-total"><dt>Net received{t.fees_include_estimates ? ' (includes estimates)' : ''}</dt><dd>{formatPence(t.net_received_pence)}</dd></div>
          <div><dt>Outstanding from players</dt><dd className={t.outstanding_pence ? 'text-warn' : ''}>{formatPence(t.outstanding_pence)}</dd></div>
          {(t.credit_pence ?? 0) > 0 && <div><dt>Overpaid / owed back to players</dt><dd>{formatPence(t.credit_pence)}</dd></div>}
          <div><dt>Projected net if all outstanding is paid by card</dt><dd>{formatPence(t.projected_net_pence)}</dd></div>
        </dl>
        {(t.needs_review_count ?? 0) > 0 && <p className="notice notice-warn">{t.needs_review_count} payment(s) need review (see the payments list).</p>}
        {(t.stripe_payment_count ?? 0) > 0 && <button className="text-button" disabled={busy} onClick={() => void reconcile()}>Refresh actual fees from Stripe</button>}
      </div> : <div className="card"><p className="eyebrow">COLLECTIONS</p><p className="muted">You need finance access to see payments.</p></div>}
    </section>

    <section className="card section">
      <div className="section-title">
        <div><h2>Attendance & balances</h2><p className="muted">{attendees.filter((a) => a.attendance === 'CONFIRMED').length} confirmed · {attendees.filter((a) => a.attendance === 'UNCONFIRMED').length} not confirmed · {attendees.filter((a) => a.attendance === 'CANCELLED').length} cancelled</p></div>
        <button className="text-button" onClick={exportCsv}>Export CSV</button>
      </div>
      {t.stale_request_count > 0 && <p className="notice notice-warn">{t.stale_request_count} issued request(s) no longer match the current split. Their amounts have not changed. Review and reissue below; links that would now overcharge are paused until you do.</p>}
      {attendees.length === 0 ? <p className="muted">No players yet. Add them below.</p> : <div className="table-wrap"><table className="data-table">
        <thead><tr><th scope="col">Player</th><th scope="col">Attendance</th><th scope="col">Shares cost</th><th scope="col" className="num">Share</th>{can.finance && <><th scope="col" className="num">Paid</th><th scope="col" className="num">Owes</th><th scope="col">Request</th><th scope="col"><span className="sr-only">Actions</span></th></>}</tr></thead>
        <tbody>{attendees.map((a) => {
          const req = requests.find((r) => r.id === a.active_request_id)
          const last = req ?? requests.find((r) => r.attendee_id === a.id)
          const stale = req && req.amount_pence !== a.outstanding_pence
          return <tr key={a.id} className={a.attendance === 'CANCELLED' ? 'row-muted' : ''}>
            <th scope="row">{a.display_name}{!a.profile_id && <small className="muted"> guest</small>}</th>
            <td>{can.attendance && !cancelled ? <select aria-label={`Attendance for ${a.display_name}`} value={a.attendance} disabled={busy} onChange={(e) => void updateAttendee(a, e.target.value as SessionAttendee['attendance'], a.chargeable)}>
              <option value="CONFIRMED">Confirmed</option><option value="UNCONFIRMED">Not confirmed</option><option value="CANCELLED">Cancelled</option></select> : <StatusPill status={a.attendance} />}</td>
            <td><input type="checkbox" className="table-check" aria-label={`${a.display_name} shares the cost`} checked={a.chargeable} disabled={busy || !can.attendance || cancelled} onChange={(e) => void updateAttendee(a, a.attendance, e.target.checked)} /></td>
            <td className="num">{a.share_pence ? <>{formatPence(a.share_pence)}{a.extra_penny && <abbr title="Includes one of the leftover pennies so the shares add up exactly"> +1p</abbr>}</> : '—'}</td>
            {can.finance && <>
              <td className="num">{formatPence((a.paid_pence ?? 0) - (a.refunded_pence ?? 0))}</td>
              <td className={`num ${(a.outstanding_pence ?? 0) > 0 ? 'text-warn' : ''}`}>{(a.outstanding_pence ?? 0) < 0 ? `Credit ${formatPence(-(a.outstanding_pence ?? 0))}` : formatPence(a.outstanding_pence)}</td>
              <td>{last ? <><StatusPill status={last.status} />{req && <small className="muted"> {formatPence(req.amount_pence)}</small>}{stale && <small className="text-warn"> needs reissue</small>}{req?.last_error && <small className="text-warn" title={req.last_error}> last attempt failed</small>}</> : <span className="muted">—</span>}</td>
              <td className="row-actions">
                {req && <button className="text-button" onClick={() => void copy(payLink(req.id), `${a.display_name}'s payment link`)}>Copy link</button>}
                {can.manual && !cancelled && (a.outstanding_pence ?? 0) > 0 && <button className="text-button" onClick={() => setPanel({ kind: 'manual', attendee: a })}>Record payment</button>}
              </td>
            </>}
          </tr>
        })}</tbody>
      </table></div>}
      {can.attendance && !cancelled && s.status !== 'COMPLETED' && <div className="grid two section">
        <form onSubmit={addAttendee} className="subform">
          <h3>Add player</h3>
          <label>CAFF member<select name="member" defaultValue=""><option value="">Guest (type a name below)</option>{members.filter((m) => !attendees.some((a) => a.profile_id === m.id)).map((m) => <option key={m.id} value={m.id}>{m.nickname || m.full_name}</option>)}</select></label>
          <label>Guest name<input name="guest" maxLength={80} placeholder="Only for non-members" /></label>
          <label>Attendance<select name="attendance" defaultValue="CONFIRMED"><option value="CONFIRMED">Confirmed</option><option value="UNCONFIRMED">Not confirmed yet</option></select></label>
          <button className="primary-button" disabled={busy}>Add player</button>
        </form>
        {matches.length > 0 && requests.length === 0 && <form onSubmit={importMatch} className="subform">
          <h3>Import from a match</h3>
          <p className="field-help">Adds everyone marked Playing on a CAFF match as confirmed.</p>
          <label>Match<select name="match" defaultValue={s.match_id ?? ''}><option value="">Choose a match</option>{matches.map((m) => <option key={m.id} value={m.id}>{m.title} · {new Date(m.starts_at).toLocaleDateString('en-GB')}</option>)}</select></label>
          <button className="secondary-button" disabled={busy}>Import Playing list</button>
        </form>}
      </div>}
    </section>

    {panel && <PanelForm panel={panel} close={() => setPanel(null)} busy={busy} run={run} sessionTitle={s.title} />}

    {can.finance && <section className="card section">
      <div className="section-title">
        <div><h2>Payment requests</h2><p className="muted">{s.payment_deadline ? `Deadline ${when(s.payment_deadline)}${deadlinePassed ? ' (passed: links still work so late payers can settle up)' : ''}` : 'No payment deadline set.'}</p></div>
        <div className="button-row">
          {activeRequests.length > 0 && <button className="secondary-button" onClick={() => void copyAllLinks()}>Copy all links</button>}
          {can.request && !cancelled && <button className="primary-button" disabled={busy || toIssue === 0 || s.status === 'PLANNING'} onClick={issueRequests}>{toIssue ? `Review & issue ${toIssue} request${toIssue === 1 ? '' : 's'}` : 'Requests up to date'}</button>}
        </div>
      </div>
      {s.status === 'PLANNING' && <p className="field-help">Open or confirm the session before requesting payment.</p>}
      {requests.length === 0 ? <p className="muted">No payment requests yet. Confirm attendance, check the split, then issue requests. Each player gets their own Stripe-hosted payment link.</p> : <div className="table-wrap"><table className="data-table">
        <thead><tr><th scope="col">Player</th><th scope="col" className="num">Amount</th><th scope="col">Status</th><th scope="col">Issued</th><th scope="col">Calculation at issue</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{requests.map((r) => <tr key={r.id} className={['SUPERSEDED', 'CANCELLED'].includes(r.status) ? 'row-muted' : ''}>
          <th scope="row">{nameOf(r.attendee_id)}</th>
          <td className="num">{formatPence(r.amount_pence)}</td>
          <td><StatusPill status={r.status} />{r.closed_reason && <small className="muted"> {r.closed_reason}</small>}</td>
          <td>{when(r.issued_at)}{r.paid_at && <small className="muted"> · paid {when(r.paid_at)}</small>}</td>
          <td><small>{formatPence(r.calculation.allocation_total_pence)} ÷ {r.calculation.chargeable_count} → {formatPence(r.calculation.share_pence)}{r.calculation.already_paid_pence ? `, less ${formatPence(r.calculation.already_paid_pence)} paid` : ''}</small></td>
          <td className="row-actions">{['PENDING', 'FAILED'].includes(r.status) && <>
            <button className="text-button" onClick={() => void copy(payLink(r.id), 'Payment link')}>Copy link</button>
            {can.request && <button className="text-button" onClick={() => { const reason = window.prompt('Why cancel this request? The link will stop working.'); if (reason?.trim()) void run('Request cancelled.', () => supabase.rpc('cancel_payment_request', { p_request: r.id, p_reason: reason })) }}>Cancel</button>}
          </>}</td>
        </tr>)}</tbody>
      </table></div>}
    </section>}

    {can.finance && <section className="card section">
      <div className="section-title"><h2>Payments received</h2><span className="muted">{payments.filter((p) => p.status === 'SUCCEEDED').length}</span></div>
      {payments.length === 0 ? <p className="muted">Nothing received yet. Card payments appear here automatically once Stripe confirms them; record bank transfers and cash with “Record payment”.</p> : <div className="table-wrap"><table className="data-table">
        <thead><tr><th scope="col">Received</th><th scope="col">Player</th><th scope="col">Method</th><th scope="col" className="num">Amount</th><th scope="col" className="num">Fee</th><th scope="col">Details</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>{payments.map((p) => <tr key={p.id} className={p.status === 'VOID' ? 'row-muted' : ''}>
          <td>{p.method === 'STRIPE' ? when(p.received_at) : new Date(p.received_at).toLocaleDateString('en-GB', { dateStyle: 'medium' })}</td>
          <th scope="row">{nameOf(p.attendee_id)}</th>
          <td>{methodLabel[p.method]}{p.method === 'STRIPE' && p.livemode === false && <small className="muted"> test</small>}</td>
          <td className="num">{p.status === 'VOID' ? <s>{formatPence(p.amount_pence)}</s> : formatPence(p.amount_pence)}{p.refunded_pence > 0 && <small className="muted"> −{formatPence(p.refunded_pence)} refunded</small>}</td>
          <td className="num">{p.method !== 'STRIPE' ? '—' : p.fee_actual_pence !== null ? formatPence(p.fee_actual_pence) : <span title="Estimate until Stripe reports the actual fee">~{formatPence(p.fee_estimated_pence)}</span>}</td>
          <td><small>
            {p.status === 'VOID' && <span className="text-warn">Void: {p.void_reason}. </span>}
            {p.needs_review && <span className="text-warn">Review: {p.review_note}. </span>}
            {[p.reference, p.notes, p.recorded_by_name && `recorded by ${p.recorded_by_name}`].filter(Boolean).join(' · ')}
            {p.refunds.map((rf) => <span key={rf.id} className="block">Refund {formatPence(rf.amount_pence)} ({rf.method === 'STRIPE' ? 'to card' : 'manual'}): {rf.status.toLowerCase()} · {rf.reason}{rf.error ? ` · ${rf.error}` : ''}</span>)}
          </small></td>
          <td className="row-actions">{p.status === 'SUCCEEDED' && <>
            {can.refund && p.amount_pence > p.refunded_pence && <button className="text-button" onClick={() => setPanel({ kind: 'refund', payment: p })}>Refund</button>}
            {can.manual && p.method !== 'STRIPE' && p.refunded_pence === 0 && <button className="text-button" onClick={() => setPanel({ kind: 'void', payment: p })}>Correct</button>}
          </>}</td>
        </tr>)}</tbody>
      </table></div>}
    </section>}

    {can.sessions && !cancelled && <details className="card section">
      <summary><h2>Edit session details & price</h2></summary>
      {(requests.some((r) => !['CANCELLED', 'SUPERSEDED'].includes(r.status)) || payments.length > 0) && <p className="notice notice-warn">Payments have started. Changing the price or fee option will not alter amounts already requested or paid; you will review and reissue any differences.</p>}
      <form onSubmit={saveSession}>
        <label>Session name<input name="title" required maxLength={120} defaultValue={s.title} /></label>
        <div className="form-grid">
          <label>Date and kick-off<input name="starts_at" type="datetime-local" required defaultValue={toLocalInput(s.starts_at)} /></label>
          <label>Duration (minutes)<input name="duration" type="number" min={15} max={300} required defaultValue={s.duration_minutes} /></label>
        </div>
        <div className="form-grid">
          <label>Venue name (if not a listed venue)<input name="venue_name" maxLength={120} defaultValue={s.venue_name ?? ''} /></label>
          <label>Pitch<input name="pitch_name" maxLength={120} defaultValue={s.pitch_name ?? ''} /></label>
        </div>
        <div className="form-grid">
          <label>Pitch type<input name="pitch_type" maxLength={60} defaultValue={s.pitch_type ?? ''} /></label>
          <label>Pitch hire cost (£)<input name="cost" inputMode="decimal" required defaultValue={(s.pitch_cost_pence / 100).toFixed(2)} /></label>
        </div>
        <div className="form-grid">
          <label>Card fees<select name="fee_mode" defaultValue={s.fee_mode}><option value="ABSORB">CAFF absorbs fees</option><option value="COVER_IN_PRICE">Price covers estimated fees</option></select></label>
          <label>Payment deadline<input name="deadline" type="datetime-local" defaultValue={toLocalInput(s.payment_deadline)} /></label>
        </div>
        <label>Booking notes<textarea name="notes" maxLength={2000} defaultValue={s.notes ?? ''} /></label>
        <button className="primary-button" disabled={busy}>Save changes</button>
      </form>
    </details>}

    {detail.audit && <section className="card section">
      <h2>History</h2>
      {detail.audit.length === 0 ? <p className="muted">No changes recorded yet.</p> : detail.audit.map((entry, index) => <p className="audit-entry" key={index}>
        <strong>{entry.action.replaceAll('_', ' ').toLowerCase()}</strong>
        <span>{describeAudit(entry.details)} · by {entry.actor ?? 'Stripe / system'}</span>
        <time dateTime={entry.created_at}>{when(entry.created_at)}</time>
      </p>)}
    </section>}
  </>
}

function describeAudit(details: Record<string, unknown>) {
  const money = (key: string) => (typeof details[key] === 'number' ? formatPence(details[key] as number) : null)
  if (details.before_pence !== undefined) return `pitch cost ${money('before_pence')} → ${money('after_pence')}${details.before_fee_mode !== details.after_fee_mode ? `, fees ${details.before_fee_mode} → ${details.after_fee_mode}` : ''}`
  if (details.created !== undefined) return `${details.created} new, ${details.replaced} replaced, ${details.closed} closed, ${details.unchanged} unchanged`
  if (details.attendee && details.before) return `${details.attendee}: ${String(details.before).toLowerCase()} → ${String(details.after).toLowerCase()}`
  if (details.attendee && details.amount_pence !== undefined) return `${details.attendee}: ${money('amount_pence')} ${String(details.method ?? '').toLowerCase().replace('_', ' ')}${details.reference ? ` (${details.reference})` : ''}`
  if (details.amount_pence !== undefined) return `${money('amount_pence')}${details.reason ? ` · ${details.reason}` : ''}`
  if (details.attendee) return String(details.attendee)
  if (details.before && details.after) return `${String(details.before).toLowerCase()} → ${String(details.after).toLowerCase()}${details.reason ? ` · ${details.reason}` : ''}`
  return String(details.title ?? '')
}

function PanelForm({ panel, close, busy, run, sessionTitle }: { panel: NonNullable<Panel>; close: () => void; busy: boolean; sessionTitle: string
  run: (label: string, action: () => PromiseLike<{ error: { message: string } | null; cancelled?: boolean }>) => Promise<boolean> }) {
  const supabase = getSupabaseBrowserClient()
  // One idempotency token per open form: a double submit records once.
  const [token] = useState(() => crypto.randomUUID())
  const today = new Date().toISOString().slice(0, 10)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const amount = parsePounds(String(form.get('amount') ?? ''))
    const reason = String(form.get('reason') ?? '').trim()
    let ok = false
    if (panel.kind === 'manual') {
      if (amount === null || amount <= 0) return window.alert('Enter the amount received, for example 6 or 6.25.')
      ok = await run(`${formatPence(amount)} recorded for ${panel.attendee.display_name}.`, () => supabase.rpc('record_manual_payment', {
        p_attendee: panel.attendee.id, p_amount_pence: amount, p_method: String(form.get('method')), p_received_on: String(form.get('received_on')),
        p_reference: String(form.get('reference') ?? ''), p_notes: String(form.get('notes') ?? ''), p_client_token: token,
      }))
    } else if (panel.kind === 'void') {
      ok = await run('Payment marked void. The original entry is kept in the history.', () => supabase.rpc('void_manual_payment', { p_payment: panel.payment.id, p_reason: reason }))
    } else {
      const p = panel.payment
      if (amount === null || amount <= 0 || amount > p.amount_pence - p.refunded_pence) return window.alert(`Enter an amount up to ${formatPence(p.amount_pence - p.refunded_pence)}.`)
      if (!window.confirm(`Refund ${formatPence(amount)}${p.method === 'STRIPE' ? ' to the player\'s card through Stripe' : ' (record money you have handed back)'}?`)) return
      ok = await run(p.method === 'STRIPE' ? 'Refund sent to Stripe. It shows as succeeded once Stripe confirms.' : 'Refund recorded.', async () => {
        if (p.method !== 'STRIPE') return supabase.rpc('record_manual_refund', { p_payment: p.id, p_amount_pence: amount, p_reason: reason, p_client_token: token })
        await paymentsApi('/admin/refund', { method: 'POST', admin: true, body: { paymentId: p.id, amountPence: amount, reason, clientToken: token } })
        return { error: null }
      })
    }
    if (ok) close()
  }

  const title = panel.kind === 'manual' ? `Record payment: ${panel.attendee.display_name}` : panel.kind === 'void' ? 'Correct a manual payment' : 'Refund a payment'
  return <section className="card section panel" aria-label={title}>
    <div className="section-title"><h2>{title}</h2><button type="button" className="text-button" onClick={close}>Close</button></div>
    <p className="muted">{sessionTitle}</p>
    <form onSubmit={submit}>
      {panel.kind === 'manual' && <>
        <div className="form-grid">
          <label>Amount received (£)<input name="amount" inputMode="decimal" required autoFocus defaultValue={((panel.attendee.outstanding_pence ?? 0) / 100).toFixed(2)} /></label>
          <label>Method<select name="method" defaultValue="BANK_TRANSFER"><option value="BANK_TRANSFER">Bank transfer</option><option value="CASH">Cash</option><option value="OTHER">Other</option></select></label>
        </div>
        <div className="form-grid">
          <label>Date received<input name="received_on" type="date" required max={today} defaultValue={today} /></label>
          <label>Reference (optional)<input name="reference" maxLength={120} placeholder="Bank reference" /></label>
        </div>
        <label>Notes (optional)<input name="notes" maxLength={500} /></label>
        <p className="field-help">Your name and the time are recorded. Mistakes are corrected by marking the entry void, never by deleting it.</p>
      </>}
      {panel.kind === 'void' && <p>{methodLabel[panel.payment.method]} of {formatPence(panel.payment.amount_pence)} received {when(panel.payment.received_at)}. It will be kept, marked void, and no longer count as paid. Record the correct payment afterwards if needed.</p>}
      {panel.kind === 'refund' && <>
        <p>{methodLabel[panel.payment.method]} payment of {formatPence(panel.payment.amount_pence)}{panel.payment.refunded_pence ? `, ${formatPence(panel.payment.refunded_pence)} already refunded` : ''}. {panel.payment.method === 'STRIPE' ? 'Stripe returns the money to the original card. Stripe does not return its processing fee.' : 'Use this to record money handed back by cash or transfer.'}</p>
        <label>Amount to refund (£)<input name="amount" inputMode="decimal" required defaultValue={((panel.payment.amount_pence - panel.payment.refunded_pence) / 100).toFixed(2)} /></label>
      </>}
      {panel.kind !== 'manual' && <label>Reason<input name="reason" required maxLength={300} autoFocus={panel.kind === 'void'} /></label>}
      <div className="button-row"><button className={panel.kind === 'manual' ? 'primary-button' : 'danger-button'} disabled={busy}>{busy ? 'Saving…' : panel.kind === 'manual' ? 'Record payment' : panel.kind === 'void' ? 'Mark void' : 'Refund'}</button><button type="button" className="secondary-button" onClick={close}>Cancel</button></div>
    </form>
  </section>
}
