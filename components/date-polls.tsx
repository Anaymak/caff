'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '@/components/auth-provider'
import { getSupabaseBrowserClient } from '@/lib/supabase/client'
import type { GameDatePoll, GameDatePollCount } from '@/lib/types'

export function DatePolls() {
  const { profile } = useAuth()
  const supabase = useMemo(() => getSupabaseBrowserClient(), [])
  const [polls, setPolls] = useState<GameDatePoll[]>([])
  const [counts, setCounts] = useState<GameDatePollCount[]>([])
  const [selections, setSelections] = useState<Record<string, string[]>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [message, setMessage] = useState('')

  const load = useCallback(async () => {
    if (!profile) return
    const pollsResponse = await supabase.from('game_date_polls').select('*, venue:venues(*), options:game_date_options(*)').order('created_at', { ascending: false })
    const nextPolls = (pollsResponse.data ?? []) as GameDatePoll[]
    setPolls(nextPolls)
    if (!nextPolls.length) return
    const ids = nextPolls.map((poll) => poll.id)
    const [countResponse, voteResponse] = await Promise.all([
      supabase.from('game_date_poll_counts').select('*').in('poll_id', ids),
      supabase.from('game_date_votes').select('poll_id,option_id').eq('player_id', profile.id).in('poll_id', ids),
    ])
    setCounts((countResponse.data ?? []) as GameDatePollCount[])
    const mine: Record<string, string[]> = {}
    for (const vote of voteResponse.data ?? []) mine[vote.poll_id] = [...(mine[vote.poll_id] ?? []), vote.option_id]
    setSelections(mine)
  }, [profile, supabase])

  // Initial poll and vote synchronization.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load() }, [load])

  function toggle(pollId: string, optionId: string) {
    setSelections((current) => {
      const selected = current[pollId] ?? []
      return { ...current, [pollId]: selected.includes(optionId) ? selected.filter((id) => id !== optionId) : [...selected, optionId] }
    })
  }

  async function save(poll: GameDatePoll) {
    if (!profile) return
    setSaving(poll.id)
    setMessage('')
    const remove = await supabase.from('game_date_votes').delete().eq('poll_id', poll.id).eq('player_id', profile.id)
    const selected = selections[poll.id] ?? []
    const add = remove.error || !selected.length ? null : await supabase.from('game_date_votes').insert(selected.map((optionId) => ({ poll_id: poll.id, option_id: optionId, player_id: profile.id })))
    const error = remove.error ?? add?.error
    setMessage(error ? 'Could not save your choices. Please try again.' : 'Your date choices have been saved.')
    if (!error) await load()
    setSaving(null)
  }

  if (!polls.length) return null

  return <section className="section date-polls"><div className="section-title"><div><p className="eyebrow">HELP PICK THE DATE</p><h2>Future game polls</h2></div></div>
    {message && <p className="form-message" role="status">{message}</p>}
    <div className="grid two">{polls.map((poll) => {
      const closed = poll.status === 'CLOSED' || Boolean(poll.closes_at && new Date(poll.closes_at) < new Date())
      const options = [...(poll.options ?? [])].sort((a, b) => a.starts_at.localeCompare(b.starts_at))
      const maxVotes = Math.max(1, ...options.map((option) => counts.find((count) => count.option_id === option.id)?.vote_count ?? 0))
      return <article className="card poll-card" key={poll.id}>
        <div className="section-title"><div><h3>{poll.title}</h3><p className="muted">{poll.venue?.name ?? 'Venue TBC'}{poll.closes_at ? ` · Vote by ${new Date(poll.closes_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}` : ''}</p></div><span className={`status-pill ${closed ? '' : 'status-availability_open'}`}>{closed ? 'Closed' : 'Open'}</span></div>
        {poll.notes && <p>{poll.notes}</p>}
        <div className="poll-options">{options.map((option) => {
          const votes = counts.find((count) => count.option_id === option.id)?.vote_count ?? 0
          const checked = (selections[poll.id] ?? []).includes(option.id)
          return <label className={`poll-option ${checked ? 'selected' : ''}`} key={option.id}>
            <input type="checkbox" checked={checked} disabled={closed} onChange={() => toggle(poll.id, option.id)} />
            <span className="poll-date"><strong>{new Date(option.starts_at).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}</strong><small>{new Date(option.starts_at).toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit' })}</small></span>
            <span className="poll-total">{votes} {votes === 1 ? 'vote' : 'votes'}</span>
            <span className="poll-bar"><i style={{ width: `${(votes / maxVotes) * 100}%` }} /></span>
          </label>
        })}</div>
        {!closed && <button className="primary-button" disabled={saving === poll.id} onClick={() => save(poll)}>{saving === poll.id ? 'Saving…' : 'Save my choices'}</button>}
      </article>
    })}</div>
  </section>
}
