'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '@/components/auth-provider'
import { StatusPill } from '@/components/status-pill'
import { DatePolls } from '@/components/date-polls'
import { getSupabaseBrowserClient } from '@/lib/supabase/client'
import type { Availability, Match } from '@/lib/types'

export default function Dashboard() {
  const { profile } = useAuth()
  const supabase = useMemo(() => getSupabaseBrowserClient(), [])
  const [match, setMatch] = useState<Match | null>(null)
  const [availability, setAvailability] = useState<Availability[]>([])
  const [waitlist, setWaitlist] = useState<Array<{player_id:string}>>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const { data } = await supabase.from('matches').select('*, venue:venues(*)')
        .not('status', 'in', '(DRAFT,CANCELLED,FINALISED)').gte('starts_at', new Date().toISOString())
        .order('starts_at').limit(1).maybeSingle()
      const nextMatch = data as Match | null
      setMatch(nextMatch)
      if (nextMatch) {
        const [response, queue] = await Promise.all([
          supabase.from('match_availability').select('*').eq('match_id', nextMatch.id),
          supabase.from('match_waitlist').select('player_id').eq('match_id', nextMatch.id),
        ])
        setAvailability((response.data ?? []) as Availability[])
        setWaitlist(queue.data ?? [])
      }
      setLoading(false)
    }
    load()
  }, [supabase])

  const mine = availability.find((item) => item.player_id === profile?.id)
  const waiting = waitlist.some((item) => item.player_id === profile?.id)
  const counts = (status: Availability['status']) => availability.filter((item) => item.status === status).length

  return <>
    <header className="page-header"><div><p className="eyebrow">THE CLUBHOUSE</p><h1>Hi, {profile?.nickname || profile?.full_name.split(' ')[0]}.</h1><p className="muted">Here’s what’s happening next.</p></div></header>
    {loading ? <div className="card empty-state"><div className="spinner" /><p>Finding the next fixture…</p></div> : !match ? (
      <div className="card empty-state"><div className="ball">⚽</div><h2>No match on the board</h2><p className="muted">There isn’t an upcoming match yet. Check back when an admin adds one.</p></div>
    ) : <section className="card hero-card">
      <StatusPill status={match.status} />
      <h2>{match.title}</h2>
      <div className="match-meta"><span>{new Intl.DateTimeFormat('en-GB',{weekday:'long',day:'numeric',month:'long'}).format(new Date(match.starts_at))}</span><span>{new Intl.DateTimeFormat('en-GB',{hour:'2-digit',minute:'2-digit'}).format(new Date(match.starts_at))}</span><span>{match.venue?.name ?? 'Venue TBC'}</span></div>
      <div className="section"><p className="eyebrow" style={{color:'#c9f247'}}>YOUR STATUS</p><div className="button-row"><StatusPill status={waiting?'WAITING':mine?.status ?? 'No response'} /><Link className="secondary-button" href={`/dashboard/matches/${match.id}`}>{mine||waiting ? 'Change availability' : 'Respond now'} →</Link></div></div>
      <div className="stat-row section"><div className="stat"><strong>{counts('PLAYING')}</strong><span>Playing</span></div><div className="stat"><strong>{counts('WATCHING')}</strong><span>Watching</span></div><div className="stat"><strong>{waitlist.length}</strong><span>Waiting</span></div><div className="stat"><strong>{match.max_players ? Math.max(0,match.max_players-counts('PLAYING')) : '—'}</strong><span>Spaces</span></div></div>
      <Link className="primary-button section" style={{background:'#c9f247',color:'#101d17'}} href={`/dashboard/matches/${match.id}`}>Open match hub</Link>
    </section>}
    <DatePolls />
    <section className="grid two section"><Link className="card" href="/dashboard/matches"><p className="eyebrow">FIXTURES</p><h2>Matches</h2><p className="muted">Upcoming games and match history →</p></Link><Link className="card" href="/dashboard/players"><p className="eyebrow">SQUAD</p><h2>Players</h2><p className="muted">Form, ratings and player records →</p></Link></section>
  </>
}
