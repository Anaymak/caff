'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Avatar } from '@/components/avatar'
import { useAuth } from '@/components/auth-provider'
import { StatusPill } from '@/components/status-pill'
import { getSupabaseBrowserClient } from '@/lib/supabase/client'
import type { Profile } from '@/lib/types'

type MemberAction = 'APPROVE' | 'REJECT' | 'SUSPEND' | 'REINSTATE' | 'MAKE_ADMIN' | 'REMOVE_ADMIN'
type AuditEntry = { id: number; actor_id: string | null; target_id: string | null; action: string; details: { title?: string }; created_at: string }
type Feedback = { id: string; reporter_id: string; description: string; route: string; created_at: string }
type DeletionRequest = { player_id: string; requested_at: string; resolved_at: string | null }

const descriptions: Record<MemberAction, string> = {
  APPROVE: 'Approve this account and give them player access?',
  REJECT: 'Reject this signup request?',
  SUSPEND: 'Suspend this account? They will lose access until reinstated.',
  REINSTATE: 'Reinstate this account and restore access?',
  MAKE_ADMIN: 'Make this player an Admin? They will be able to manage members, matches and comments.',
  REMOVE_ADMIN: 'Remove Admin access? Their player profile and football history will remain.',
}

export default function PeoplePage() {
  const { profile } = useAuth()
  const supabase = useMemo(() => getSupabaseBrowserClient(), [])
  const [people, setPeople] = useState<Profile[]>([])
  const [audit, setAudit] = useState<AuditEntry[]>([])
  const [feedback, setFeedback] = useState<Feedback[]>([])
  const [deletions, setDeletions] = useState<DeletionRequest[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    const [members, history, reports, requests] = await Promise.all([
      supabase.from('profiles').select('*').order('created_at', { ascending: false }),
      supabase.from('admin_audit_log').select('id,actor_id,target_id,action,details,created_at').order('created_at', { ascending: false }).limit(50),
      supabase.from('feedback_reports').select('*').order('created_at', { ascending: false }).limit(20),
      supabase.from('account_deletion_requests').select('*').is('resolved_at', null),
    ])
    setPeople((members.data ?? []) as Profile[])
    setAudit((history.data ?? []) as AuditEntry[])
    setFeedback((reports.data ?? []) as Feedback[])
    setDeletions((requests.data ?? []) as DeletionRequest[])
    if (members.error) setMessage('Could not load member accounts. Please retry.')
    setLoading(false)
  }, [supabase])

  // Synchronize the owner view when authentication finishes.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (profile?.role === 'ADMIN') void load()
  }, [load, profile?.role])

  async function act(person: Profile, action: MemberAction) {
    if (!window.confirm(`${person.full_name} (${person.email})\n\n${descriptions[action]}`)) return
    setBusy(person.id)
    setMessage('')
    const { error } = await supabase.rpc('manage_member', { p_target: person.id, p_action: action })
    setBusy(null)
    if (error) { setMessage('That change could not be saved. Refresh and try again.'); return }
    setMessage(`${person.full_name}: ${action.toLowerCase().replaceAll('_', ' ')} complete.`)
    await load()
  }

  if (profile?.role !== 'ADMIN') return <div className="card empty-state"><h2>Admin access only</h2></div>
  const nameFor = (id: string | null) => people.find((person) => person.id === id)?.full_name ?? 'Former member'
  const auditTarget = (entry: AuditEntry) => entry.details?.title || (people.some((person) => person.id === entry.target_id) ? nameFor(entry.target_id) : 'Match or former member')
  const pending = people.filter((person) => person.status === 'PENDING')
  const others = people.filter((person) => person.status !== 'PENDING')

  return <>
    <header className="page-header"><div><p className="eyebrow">MEMBER CONTROL</p><h1>People & access</h1><p className="muted">Approve players, manage access and review recent changes.</p></div><Link className="secondary-button" href="/dashboard/admin">Back to Admin</Link></header>
    {message && <p className="form-message" role="status">{message}</p>}
    {loading ? <div className="spinner" aria-label="Loading members" /> : <>
      <section className="card"><div className="section-title"><h2>Waiting for approval</h2><span>{pending.length}</span></div>{pending.length ? pending.map((person) => <MemberRow key={person.id} person={person} busy={busy === person.id} owner={Boolean(profile.is_owner)} act={act} />) : <p className="muted">No one is waiting.</p>}</section>
      <section className="card section"><div className="section-title"><h2>All members</h2><span>{people.length}</span></div>{others.map((person) => <MemberRow key={person.id} person={person} busy={busy === person.id} owner={Boolean(profile.is_owner)} act={act} />)}</section>
      <section className="card section"><h2>Recent admin activity</h2>{audit.length ? audit.map((entry) => <p className="audit-entry" key={entry.id}><strong>{entry.action.replaceAll('_', ' ').toLowerCase()}</strong><span>{auditTarget(entry)} · by {nameFor(entry.actor_id)}</span><time dateTime={entry.created_at}>{new Date(entry.created_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</time></p>) : <p className="muted">No admin changes recorded yet.</p>}</section>
      <section className="card section"><h2>Account deletion requests</h2>{deletions.length ? deletions.map((request) => <p className="audit-entry" key={request.player_id}><strong>{nameFor(request.player_id)}</strong><span>Requested {new Date(request.requested_at).toLocaleDateString('en-GB')}. Contact the member and follow the documented removal procedure.</span></p>) : <p className="muted">No open requests.</p>}</section>
      <section className="card section"><h2>Problem reports</h2>{feedback.length ? feedback.map((report) => <div className="report-entry" key={report.id}><strong>{nameFor(report.reporter_id)}</strong><small>{new Date(report.created_at).toLocaleString('en-GB')} · {report.route}</small><p>{report.description}</p></div>) : <p className="muted">No reports yet.</p>}</section>
    </>}
  </>
}

function MemberRow({ person, owner, busy, act }: { person: Profile; owner: boolean; busy: boolean; act: (person: Profile, action: MemberAction) => void }) {
  return <div className="member-row">
    <div className="member-identity"><Avatar profile={person} /><div className="player-copy"><strong>{person.full_name}{person.is_owner ? ' · Owner' : ''}</strong><small>{person.email}</small><small>Joined {new Date(person.created_at).toLocaleDateString('en-GB')}</small></div></div>
    <div className="member-actions"><StatusPill status={person.status} /><span className="role-tag">{person.is_owner ? 'Owner' : person.role === 'ADMIN' ? 'Admin' : 'Player'}</span>
      {!person.is_owner && <div className="button-row">
        {person.status === 'PENDING' && <><button disabled={busy} className="secondary-button" onClick={() => act(person, 'APPROVE')}>Approve</button><button disabled={busy} className="danger-button" onClick={() => act(person, 'REJECT')}>Reject</button></>}
        {person.status === 'REJECTED' && <button disabled={busy} className="secondary-button" onClick={() => act(person, 'APPROVE')}>Approve</button>}
        {person.status === 'APPROVED' && <button disabled={busy} className="danger-button" onClick={() => act(person, 'SUSPEND')}>Suspend</button>}
        {person.status === 'SUSPENDED' && <button disabled={busy} className="secondary-button" onClick={() => act(person, 'REINSTATE')}>Reinstate</button>}
        {owner && person.status === 'APPROVED' && person.role === 'PLAYER' && <button disabled={busy} className="secondary-button" onClick={() => act(person, 'MAKE_ADMIN')}>Make Admin</button>}
        {owner && person.role === 'ADMIN' && <button disabled={busy} className="secondary-button" onClick={() => act(person, 'REMOVE_ADMIN')}>Remove Admin</button>}
      </div>}
    </div>
  </div>
}
