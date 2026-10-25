'use client'

import Link from 'next/link'
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '@/components/auth-provider'
import { estimateFee, formatPence } from '@/lib/domain/payments'
import { friendlyError } from '@/lib/payments-api'
import { getSupabaseBrowserClient } from '@/lib/supabase/client'
import type { FinancePermission, Profile } from '@/lib/types'

interface Settings { fee_percent_bps: number; fee_fixed_pence: number; default_fee_mode: 'ABSORB' | 'COVER_IN_PRICE'; stripe_mode: 'test' | 'live'; updated_at: string }

const permissionLabels: Array<[Exclude<FinancePermission, 'owner'>, string, string]> = [
  ['sessions.manage', 'Sessions', 'Create and edit sessions, prices and status'],
  ['attendance.manage', 'Attendance', 'Add, confirm and cancel players'],
  ['payments.request', 'Payment requests', 'Issue, reissue and cancel payment links'],
  ['finance.view', 'View finances', 'See payments, balances, fees and history'],
  ['payments.record_manual', 'Manual payments', 'Record and correct cash and bank transfers'],
  ['payments.refund', 'Refunds', 'Refund card payments and record manual refunds'],
  ['settings.manage', 'Payment settings', 'Change fee assumptions'],
]

export default function PaymentSettingsPage() {
  const { profile } = useAuth()
  const supabase = useMemo(() => getSupabaseBrowserClient(), [])
  const [mine, setMine] = useState<FinancePermission[] | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [admins, setAdmins] = useState<Profile[]>([])
  const [grants, setGrants] = useState<Array<{ profile_id: string; permission: string }>>([])
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const [perms, cfg, people, granted] = await Promise.all([
      supabase.rpc('my_finance_permissions'),
      supabase.from('payment_settings').select('*').maybeSingle(),
      supabase.from('profiles').select('*').eq('role', 'ADMIN').eq('status', 'APPROVED').order('full_name'),
      supabase.from('admin_permissions').select('profile_id,permission'),
    ])
    setMine((perms.data ?? []) as FinancePermission[])
    setSettings(cfg.data as Settings | null)
    setAdmins(((people.data ?? []) as Profile[]).filter((person) => !person.is_owner))
    setGrants(granted.data ?? [])
  }, [supabase])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (profile?.role === 'ADMIN') void load()
  }, [load, profile?.role])

  if (profile?.role !== 'ADMIN') return <div className="card empty-state"><h2>Admin access only</h2></div>
  const owner = Boolean(mine?.includes('owner'))
  const canEdit = Boolean(mine?.includes('settings.manage'))

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const percent = Number(form.get('percent')); const fixed = Number(form.get('fixed'))
    if (!Number.isFinite(percent) || percent < 0 || percent > 10 || !Number.isInteger(fixed) || fixed < 0 || fixed > 500) return setMessage({ tone: 'error', text: 'Use a percentage between 0 and 10 and a fixed fee in whole pence (0–500).' })
    const mode = String(form.get('stripe_mode')) as Settings['stripe_mode']
    if (mode !== settings?.stripe_mode && !window.confirm(mode === 'live'
      ? 'Switch to LIVE Stripe payments? Only do this after the live secret key and live webhook secret are stored in AWS. Players will be charged real money.'
      : 'Switch back to TEST mode? Live payment links will stop working until you switch back.')) return
    setBusy(true)
    const { error } = await supabase.rpc('update_payment_settings', { p_fee_percent_bps: Math.round(percent * 100), p_fee_fixed_pence: fixed, p_default_fee_mode: String(form.get('default_fee_mode')), p_stripe_mode: mode })
    setBusy(false)
    setMessage(error ? { tone: 'error', text: friendlyError(error.message) } : { tone: 'ok', text: 'Payment settings saved.' })
    if (!error) void load()
  }

  async function toggle(person: Profile, permission: string, granted: boolean) {
    setBusy(true)
    const { error } = await supabase.rpc('set_admin_permission', { p_target: person.id, p_permission: permission, p_granted: granted })
    setBusy(false)
    setMessage(error ? { tone: 'error', text: friendlyError(error.message) } : { tone: 'ok', text: `${person.full_name}: ${granted ? 'granted' : 'removed'} ${permission}.` })
    if (!error) void load()
  }

  return <>
    <header className="page-header"><div><p className="eyebrow">FINANCE CONTROLS</p><h1>Payment settings</h1><p className="muted">Fee assumptions, Stripe mode and who can handle money.</p></div><Link className="secondary-button" href="/dashboard/admin/sessions">Back to sessions</Link></header>
    {message && <p className={`notice notice-${message.tone}`} role={message.tone === 'error' ? 'alert' : 'status'}>{message.text}</p>}
    {mine === null ? <div className="card empty-state"><div className="spinner" aria-label="Loading" /></div> : <>
      <section className="grid two">
        {settings ? <form className="card" onSubmit={save}>
          <p className="eyebrow">STRIPE FEES (ESTIMATE)</p><h2>Fee assumptions</h2>
          <p className="field-help">Used for estimates only. Stripe’s standard UK rate for UK cards is 1.5% + 20p per successful payment; EEA, international and premium cards cost more, and your account pricing may differ. Actual fees from Stripe always replace the estimate once available.</p>
          <fieldset disabled={!canEdit || busy}>
            <div className="form-grid">
              <label>Percentage (%)<input name="percent" type="number" step="0.01" min="0" max="10" required defaultValue={(settings.fee_percent_bps / 100).toFixed(2)} /></label>
              <label>Fixed fee per payment (pence)<input name="fixed" type="number" step="1" min="0" max="500" required defaultValue={settings.fee_fixed_pence} /></label>
            </div>
            <p className="field-help">Example: a {formatPence(600)} share costs about {formatPence(estimateFee(600, { percentBps: settings.fee_percent_bps, fixedPence: settings.fee_fixed_pence }))} in fees. The fixed fee applies to every separate player payment.</p>
            <label>Default for new sessions<select name="default_fee_mode" defaultValue={settings.default_fee_mode}><option value="ABSORB">CAFF absorbs card fees</option><option value="COVER_IN_PRICE">Set the price to cover estimated fees</option></select></label>
            <p className="field-help">“Cover in price” raises the shared total slightly so the pitch is still covered after fees. Every player pays the same amount whether they pay by card, transfer or cash, so it is not a card surcharge (surcharges on UK consumer card payments are not allowed).</p>
            <label>Stripe mode<select name="stripe_mode" defaultValue={settings.stripe_mode} disabled={!owner}><option value="test">Test (no real money)</option><option value="live">Live (real payments)</option></select></label>
            {!owner && <input type="hidden" name="stripe_mode" value={settings.stripe_mode} />}
            <p className="field-help">Must match the Stripe keys stored for the payments service. Events from the other mode are ignored. Only the Owner can switch.</p>
            {canEdit && <button className="primary-button">Save settings</button>}
          </fieldset>
          <p className="field-help">Last changed {new Date(settings.updated_at).toLocaleString('en-GB')}.</p>
        </form> : <div className="card"><p className="muted">You need finance or settings access to see payment settings.</p></div>}
        <div className="card">
          <p className="eyebrow">CURRENT MODE</p>
          <h2>{settings?.stripe_mode === 'live' ? 'Live payments' : 'Test mode'}</h2>
          <p className="muted">{settings?.stripe_mode === 'live' ? 'Payment links take real card payments.' : 'Payment links use Stripe test mode. Use Stripe’s test card 4242 4242 4242 4242 with any future date and CVC.'}</p>
          <p className="eyebrow section">YOUR ACCESS</p>
          <ul className="plain-list">{permissionLabels.map(([key, label]) => <li key={key}>{mine.includes(key) ? '✓' : '–'} {label}</li>)}</ul>
        </div>
      </section>
      {owner && <section className="card section">
        <div className="section-title"><div><h2>Admin permissions</h2><p className="muted">You (the Owner) always have every permission. Grant others only what they need.</p></div></div>
        {admins.length === 0 ? <p className="muted">No other admins. Make someone an Admin in People & access first.</p> : <div className="table-wrap"><table className="data-table stack-table">
          <thead><tr><th scope="col">Admin</th>{permissionLabels.map(([key, label, description]) => <th scope="col" key={key} title={description}>{label}</th>)}</tr></thead>
          <tbody>{admins.map((person) => <tr key={person.id}><th scope="row">{person.full_name}</th>{permissionLabels.map(([key, label]) => {
            const has = grants.some((g) => g.profile_id === person.id && g.permission === key)
            return <td key={key} data-label={label}><input type="checkbox" className="table-check" aria-label={`${label} for ${person.full_name}`} checked={has} disabled={busy} onChange={(e) => void toggle(person, key, e.target.checked)} /></td>
          })}</tr>)}</tbody>
        </table></div>}
      </section>}
    </>}
  </>
}
