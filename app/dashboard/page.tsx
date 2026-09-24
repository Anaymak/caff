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
  const [votingAction, setVotingAction] = useState<{matchId:string; title:string; needsRatings:boolean; needsMotm:boolean}|null>(null)
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
      if (profile?.id) {
        const {data:openVotes} = await supabase.from('matches').select('id,title,voting_closes_at')
          .eq('status','VOTING_OPEN').order('starts_at',{ascending:false}).limit(4)
        const activeVotes=(openVotes??[]).filter((vote)=>!vote.voting_closes_at||new Date(vote.voting_closes_at)>new Date())
        if(activeVotes.length){
          const voteIds=activeVotes.map((vote)=>vote.id)
          const [attendees,ratings,motm]=await Promise.all([
            supabase.from('match_availability').select('match_id,player_id,status').in('match_id',voteIds),
            supabase.from('ratings').select('match_id,target_player_id').eq('voter_id',profile.id).in('match_id',voteIds),
            supabase.from('motm_votes').select('match_id').eq('voter_id',profile.id).in('match_id',voteIds),
          ])
          const nextAction=activeVotes.map((vote)=>{
            const responses=(attendees.data??[]).filter((entry)=>entry.match_id===vote.id)
            const eligible=responses.some((entry)=>entry.player_id===profile.id&&['PLAYING','WATCHING'].includes(entry.status))
            const targets=responses.filter((entry)=>entry.status==='PLAYING'&&entry.player_id!==profile.id)
            return {matchId:vote.id,title:vote.title,needsRatings:eligible&&targets.some((entry)=>!(ratings.data??[]).some((rating)=>rating.match_id===vote.id&&rating.target_player_id===entry.player_id)),needsMotm:eligible&&targets.length>0&&!(motm.data??[]).some((ballot)=>ballot.match_id===vote.id)}
          }).find((action)=>action.needsRatings||action.needsMotm)
          setVotingAction(nextAction??null)
        } else setVotingAction(null)
      }
      setLoading(false)
    }
    load()
  }, [supabase,profile?.id])

  const mine = availability.find((item) => item.player_id === profile?.id)
  const waiting = waitlist.some((item) => item.player_id === profile?.id)
  const counts = (status: Availability['status']) => availability.filter((item) => item.status === status).length
  const canRespond=match?.status==='AVAILABILITY_OPEN'&&!match.availability_locked&&(!match.availability_deadline||new Date(match.availability_deadline)>new Date())
  const needsResponse=canRespond&&!mine&&!waiting

  return <>
    <header className="page-header"><div><p className="eyebrow">THE CLUBHOUSE</p><h1>Hi, {profile?.nickname || profile?.full_name.split(' ')[0]}.</h1><p className="muted">Here’s what’s happening next.</p></div></header>
    {!loading&&(needsResponse||votingAction)&&<section className="card"><p className="eyebrow">YOUR NEXT ACTION</p>{needsResponse&&<p><Link href={`/dashboard/matches/${match!.id}`}>Confirm your availability for {match!.title} →</Link></p>}{votingAction&&<p><Link href={`/dashboard/matches/${votingAction.matchId}`}>{votingAction.needsRatings&&votingAction.needsMotm?'Rate players and vote for MOTM':votingAction.needsRatings?'Rate the players':'Vote for MOTM'} · {votingAction.title} →</Link></p>}</section>}
    {loading ? <div className="card empty-state"><div className="spinner" /><p>Finding the next fixture…</p></div> : !match ? (
      <div className="card empty-state"><div className="ball">⚽</div><h2>No match on the board</h2><p className="muted">There isn’t an upcoming match yet. Check back when an admin adds one.</p></div>
    ) : <section className="card hero-card">
      <StatusPill status={match.status} />
      <h2>{match.title}</h2>
      <div className="match-meta"><span>{new Intl.DateTimeFormat('en-GB',{weekday:'long',day:'numeric',month:'long'}).format(new Date(match.starts_at))}</span><span>{new Intl.DateTimeFormat('en-GB',{hour:'2-digit',minute:'2-digit'}).format(new Date(match.starts_at))}</span><span>{match.venue?.name ?? 'Venue TBC'}</span></div>
      <div className="section"><p className="eyebrow" style={{color:'#c9f247'}}>YOUR STATUS</p><div className="button-row"><StatusPill status={waiting?'WAITING':mine?.status ?? 'No response'} /><Link className="secondary-button" href={`/dashboard/matches/${match.id}`}>{canRespond?(mine||waiting?'Change availability':'Respond now'):'View match'} →</Link></div></div>
      <div className="stat-row section"><div className="stat"><strong>{counts('PLAYING')}</strong><span>Playing</span></div><div className="stat"><strong>{counts('WATCHING')}</strong><span>Watching</span></div><div className="stat"><strong>{waitlist.length}</strong><span>Waiting</span></div><div className="stat"><strong>{match.max_players ? Math.max(0,match.max_players-counts('PLAYING')) : '—'}</strong><span>Spaces</span></div></div>
      <Link className="primary-button section" style={{background:'#c9f247',color:'#101d17'}} href={`/dashboard/matches/${match.id}`}>Open match hub</Link>
    </section>}
    <DatePolls />
    <section className="grid two section"><Link className="card" href="/dashboard/matches"><p className="eyebrow">FIXTURES</p><h2>Matches</h2><p className="muted">Upcoming games and match history →</p></Link><Link className="card" href="/dashboard/players"><p className="eyebrow">SQUAD</p><h2>Players</h2><p className="muted">Form, ratings and player records →</p></Link></section>
  </>
}
