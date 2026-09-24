'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '@/components/auth-provider'
import { getSupabaseBrowserClient } from '@/lib/supabase/client'

type Notification = {
  id: number
  event: string
  match_id: string | null
  title: string
  created_at: string
  read_at: string | null
}
type Preferences = {
  match_created: boolean
  reminders: boolean
  teams_generated: boolean
  voting: boolean
  results: boolean
}
const defaults: Preferences = {
  match_created: true, reminders: true, teams_generated: true, voting: true, results: true,
}
const preferenceLabels: Record<keyof Preferences, string> = {
  match_created: 'New matches', reminders: 'Availability reminders',
  teams_generated: 'Teams ready', voting: 'Voting opens and reminders', results: 'Results released',
}
const eventLabels: Record<string, string> = {
  MATCH_CREATED: 'New match added', AVAILABILITY_REMINDER: 'Availability reminder',
  TEAMS_GENERATED: 'Teams are ready', MATCH_CANCELLED: 'Match cancelled',
  VOTING_OPENED: 'Ratings and MOTM voting are open',
  VOTING_REMINDER: 'Voting closes soon', MATCH_FINALISED: 'Results released',
}

export default function NotificationsPage() {
  const { profile } = useAuth()
  const memberId = profile?.id
  const supabase = useMemo(() => getSupabaseBrowserClient(), [])
  const [items, setItems] = useState<Notification[]>([])
  const [preferences, setPreferences] = useState<Preferences>(defaults)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const load = useCallback(async () => {
    if (!memberId) return
    const [alerts, saved] = await Promise.all([
      supabase.from('in_app_notifications').select('id,event,match_id,title,created_at,read_at')
        .eq('recipient_id', memberId).order('created_at', { ascending: false }).limit(50),
      supabase.from('notification_preferences').select('match_created,reminders,teams_generated,voting,results')
        .eq('player_id', memberId).maybeSingle(),
    ])
    setItems((alerts.data ?? []) as Notification[])
    if (saved.data) setPreferences(saved.data as Preferences)
    if (alerts.error) setNotice('Could not load alerts. Please try again.')
    setLoading(false)
  }, [memberId, supabase])
  // Initial remote synchronization is intentionally performed after login.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])

  async function markRead(id?: number) {
    if (!profile) return
    setBusy(true)
    let query = supabase.from('in_app_notifications').update({ read_at: new Date().toISOString() })
      .eq('recipient_id', profile.id).is('read_at', null)
    if (id !== undefined) query = query.eq('id', id)
    const { error } = await query
    setBusy(false)
    if (error) return setNotice('Could not mark alerts as read.')
    window.dispatchEvent(new Event('caff-notifications-updated'))
    await load()
  }

  async function savePreferences() {
    if (!profile) return
    setBusy(true)
    const { error } = await supabase.from('notification_preferences')
      .upsert({ player_id: profile.id, ...preferences }, { onConflict: 'player_id' })
    setBusy(false)
    setNotice(error ? 'Could not save alert preferences.' : 'Alert preferences saved.')
  }

  const unread = items.filter((item) => !item.read_at).length
  return <>
    <header className="page-header"><div><p className="eyebrow">CLUB UPDATES</p><h1>Alerts</h1><p className="muted">Match news and things worth checking.</p></div></header>
    {notice && <p className="form-message" role="status">{notice}</p>}
    <section className="card"><div className="section-title"><h2>Recent alerts</h2>{unread > 0 && <button className="secondary-button" disabled={busy} onClick={() => void markRead()}>Mark all read</button>}</div>
      {loading ? <div className="spinner" aria-label="Loading alerts" /> : items.length === 0 ? <p className="muted">No alerts yet. New match updates will appear here.</p> : items.map((item) => <div className={`notification-row ${item.read_at ? '' : 'unread'}`} key={item.id}>
        <div className="player-copy"><strong>{eventLabels[item.event] ?? 'Club update'} · {item.title}</strong><small>{new Date(item.created_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</small></div>
        <div className="button-row">{item.match_id && <Link className="secondary-button" href={`/dashboard/matches/${item.match_id}`}>Open match</Link>}{!item.read_at && <button className="text-button" disabled={busy} onClick={() => void markRead(item.id)}>Mark read</button>}</div>
      </div>)}
    </section>
    <section className="card section"><h2>Alert preferences</h2><p className="muted">Choose which optional updates appear in CAFF. Match cancellations always appear.</p>
      {(Object.keys(preferenceLabels) as Array<keyof Preferences>).map((key) => <label className="inline-check" key={key}><input type="checkbox" checked={preferences[key]} onChange={(event) => setPreferences((current) => ({ ...current, [key]: event.target.checked }))} />{preferenceLabels[key]}</label>)}
      <button className="primary-button" disabled={busy} onClick={savePreferences}>Save preferences</button>
    </section>
  </>
}
