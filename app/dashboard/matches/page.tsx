'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { StatusPill } from '@/components/status-pill'
import { getSupabaseBrowserClient } from '@/lib/supabase/client'
import type { Match } from '@/lib/types'

export default function MatchesPage() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), [])
  const [matches, setMatches] = useState<Match[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => { supabase.from('matches').select('*, venue:venues(*)').not('status','eq','DRAFT').order('starts_at',{ascending:false}).then(({data}) => { setMatches((data ?? []) as Match[]); setLoading(false) }) }, [supabase])
  return <><header className="page-header"><div><p className="eyebrow">FIXTURES & RESULTS</p><h1>Matches</h1></div></header>
    {loading ? <div className="spinner" /> : matches.length === 0 ? <div className="card empty-state"><div className="ball">⚽</div><h2>No fixtures yet</h2><p className="muted">Matches will appear here when an admin creates them.</p></div> : <div className="match-list">{matches.map((match) => { const date=new Date(match.starts_at); return <Link href={`/dashboard/matches/${match.id}`} className="card" key={match.id}><div className="date-tile"><span>{date.toLocaleString('en-GB',{month:'short'})}</span><strong>{date.getDate()}</strong></div><div><strong>{match.title}</strong><p className="muted" style={{margin:'.25rem 0 0'}}>{match.venue?.name ?? 'Venue TBC'} · {date.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}</p></div><StatusPill status={match.status} /></Link>})}</div>}
  </>
}
