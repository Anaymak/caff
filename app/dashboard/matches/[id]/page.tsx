'use client'

import { useParams } from 'next/navigation'
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { Avatar } from '@/components/avatar'
import { StatusPill } from '@/components/status-pill'
import { useAuth } from '@/components/auth-provider'
import { getSupabaseBrowserClient } from '@/lib/supabase/client'
import type { Availability, AvailabilityStatus, Match, Profile, TeamAssignment } from '@/lib/types'

const availabilityOptions: Array<{status:AvailabilityStatus;label:string}> = [
  {status:'PLAYING',label:'⚽ Playing'},{status:'WATCHING',label:'👀 Watching'},
  {status:'MAYBE',label:'◌ Maybe'},{status:'NOT_ATTENDING',label:"✕ Can't make it"},
]

interface PublicRating { player_id:string; average_rating:number|null; rating_count:number }
interface CommentRow { id:string; body:string; anonymous:boolean; created_at:string; author:Pick<Profile,'id'|'full_name'|'avatar_url'>|null }

export default function MatchHubPage() {
  const { id } = useParams<{id:string}>()
  const { profile } = useAuth()
  const supabase = useMemo(() => getSupabaseBrowserClient(), [])
  const [match,setMatch]=useState<Match|null>(null)
  const [players,setPlayers]=useState<Profile[]>([])
  const [availability,setAvailability]=useState<Availability[]>([])
  const [assignments,setAssignments]=useState<TeamAssignment[]>([])
  const [ratings,setRatings]=useState<PublicRating[]>([])
  const [comments,setComments]=useState<CommentRow[]>([])
  const [busy,setBusy]=useState(false)
  const [notice,setNotice]=useState('')

  const load = useCallback(async () => {
    const [matchResult,profileResult,availabilityResult,teamResult,ratingResult,commentResult] = await Promise.all([
      supabase.from('matches').select('*, venue:venues(*)').eq('id',id).single(),
      supabase.from('profiles').select('*').eq('status','APPROVED').order('full_name'),
      supabase.from('match_availability').select('*').eq('match_id',id),
      supabase.from('team_assignments').select('*').eq('match_id',id),
      supabase.from('public_match_ratings').select('*').eq('match_id',id),
      supabase.from('public_comments').select('*').eq('match_id',id).is('target_player_id',null).order('created_at',{ascending:false}),
    ])
    setMatch(matchResult.data as Match)
    setPlayers((profileResult.data ?? []) as Profile[])
    setAvailability((availabilityResult.data ?? []) as Availability[])
    setAssignments((teamResult.data ?? []) as TeamAssignment[])
    setRatings((ratingResult.data ?? []) as PublicRating[])
    setComments((commentResult.data ?? []) as CommentRow[])
  },[id,supabase])
  // Initial remote synchronization is intentionally performed once per match.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(()=>{load()},[load])

  const mine=availability.find((item)=>item.player_id===profile?.id)
  const profileFor=(playerId:string)=>players.find((player)=>player.id===playerId)
  const canRespond=match && !match.availability_locked && match.status==='AVAILABILITY_OPEN' && (!match.availability_deadline || new Date(match.availability_deadline)>new Date())
  const eligible=mine?.status==='PLAYING'||mine?.status==='WATCHING'||profile?.role==='ADMIN'
  const votingOpen=match?.status==='VOTING_OPEN' && (!match.voting_closes_at || new Date(match.voting_closes_at)>new Date())

  async function respond(status:AvailabilityStatus) { if(!profile||!canRespond)return; setBusy(true); const {error}=await supabase.from('match_availability').upsert({match_id:id,player_id:profile.id,status},{onConflict:'match_id,player_id'}); setBusy(false); setNotice(error?'Could not save your response.':'Availability updated.'); if(!error)load() }
  async function submitComment(event:FormEvent<HTMLFormElement>) { event.preventDefault(); if(!profile||!eligible)return; const formElement=event.currentTarget; const form=new FormData(formElement); const body=String(form.get('body')??'').trim(); if(!body)return; setBusy(true); const {error}=await supabase.from('comments').insert({match_id:id,author_id:profile.id,body,anonymous:form.get('anonymous')==='on'}); setBusy(false); if(!error){formElement.reset();load()} else setNotice('Could not post that comment.') }

  if(!match)return <div className="center-screen"><div className="spinner"/><p>Opening match hub…</p></div>
  const activePlayers=availability.filter((item)=>item.status==='PLAYING').map((item)=>profileFor(item.player_id)).filter((item):item is Profile=>Boolean(item))
  return <>
    <header className="page-header"><div><p className="eyebrow">MATCH HUB</p><h1>{match.title}</h1><div className="match-meta"><span>{new Date(match.starts_at).toLocaleString('en-GB',{weekday:'long',day:'numeric',month:'long',hour:'2-digit',minute:'2-digit'})}</span><span>{match.venue?.name??'Venue TBC'}</span></div></div><StatusPill status={match.status}/></header>
    {match.status==='CANCELLED'&&<div className="card"><h2>This match was cancelled</h2><p className="muted">It remains in the history but does not count toward attendance or statistics.</p></div>}
    {notice&&<p className="form-message" role="status">{notice}</p>}
    {match.status!=='CANCELLED'&&<>
      <section className="card"><div className="section-title"><h2>Your availability</h2>{mine&&<StatusPill status={mine.status}/>}</div><div className="availability-grid">{availabilityOptions.map((option)=><button disabled={!canRespond||busy} className={mine?.status===option.status?'selected':''} key={option.status} onClick={()=>respond(option.status)}>{option.label}</button>)}</div>{!canRespond&&<p className="muted" style={{margin:'1rem 0 0'}}>Availability is locked for this match.</p>}</section>
      <section className="section"><div className="section-title"><h2>Who’s in?</h2><span className="muted">{activePlayers.length} playing</span></div><div className="grid two">{availabilityOptions.map(({status,label})=><div className="card" key={status}><div className="section-title"><h3>{label}</h3><strong>{availability.filter((item)=>item.status===status).length}</strong></div>{availability.filter((item)=>item.status===status).map((item)=>{const player=profileFor(item.player_id);return player&&<div className="player-row" key={item.player_id}><Avatar profile={player} size="sm"/><strong>{player.nickname||player.full_name}</strong></div>})}</div>)}</div></section>
      {assignments.length>0&&<section className="section"><div className="section-title"><h2>Teams</h2></div><div className="grid two">{(['BIBS','NON_BIBS'] as const).map((side)=><div className={`card team-card team-${side.toLowerCase()}`} key={side}><h3>{side==='BIBS'?'Bibs':'Non-Bibs'}</h3>{assignments.filter((item)=>item.side===side).map((item)=>{const player=profileFor(item.player_id);return player&&<div className="player-row" key={item.player_id}><Avatar profile={player}/><strong>{player.nickname||player.full_name}</strong></div>})}</div>)}</div></section>}
      {match.bibs_score!==null&&match.non_bibs_score!==null&&<section className="card section hero-card"><p className="eyebrow" style={{color:'#c9f247'}}>FULL TIME</p><h2>Bibs {match.bibs_score} — {match.non_bibs_score} Non-Bibs</h2></section>}
      {(votingOpen||ratings.length>0)&&<section className="section"><div className="section-title"><h2>Player ratings</h2><StatusPill status={match.status}/></div><div className="card">{activePlayers.map((player)=>{const result=ratings.find((item)=>item.player_id===player.id);return <div className="player-row" key={player.id}><Avatar profile={player}/><div className="player-copy"><strong>{player.nickname||player.full_name}</strong><small>{result?.rating_count&&result.rating_count>=3&&result.average_rating?`${Number(result.average_rating).toFixed(1)} from ${result.rating_count} ratings`:'Not enough ratings yet'}</small></div>{votingOpen&&eligible&&player.id!==profile?.id&&<RatingControl matchId={id} playerId={player.id}/>}</div>})}</div></section>}
      {votingOpen&&eligible&&<MotmControl matchId={id} players={activePlayers.filter((player)=>player.id!==profile?.id)}/>} 
      <section className="section"><div className="section-title"><h2>Match comments</h2></div>{eligible&&<form className="card" onSubmit={submitComment}><label>Join the conversation<textarea name="body" required maxLength={1000} placeholder="Good game…"/></label><label style={{display:'flex',gridTemplateColumns:'auto 1fr',alignItems:'center'}}><input name="anonymous" type="checkbox" style={{width:20,minHeight:20}}/>Post anonymously</label><button className="primary-button" disabled={busy}>Post comment</button></form>}<div className="card section">{comments.length===0?<p className="muted">No comments yet.</p>:comments.map((comment)=><div className="player-row" key={comment.id}>{comment.author&&!comment.anonymous?<Avatar profile={{full_name:comment.author.full_name,avatar_url:comment.author.avatar_url}}/>:<span className="avatar avatar-md avatar-fallback">?</span>}<div><strong>{comment.anonymous?'Anonymous':comment.author?.full_name??'Player'}</strong><p style={{margin:'.25rem 0'}}>{comment.body}</p></div></div>)}</div></section>
    </>}
  </>
}

function RatingControl({matchId,playerId}:{matchId:string;playerId:string}) {
  const {profile}=useAuth(); const supabase=useMemo(()=>getSupabaseBrowserClient(),[]); const [value,setValue]=useState(6); const [saved,setSaved]=useState(false)
  async function save(){if(!profile)return;const {error}=await supabase.from('ratings').upsert({match_id:matchId,voter_id:profile.id,target_player_id:playerId,score:value},{onConflict:'match_id,voter_id,target_player_id'});if(!error)setSaved(true)}
  if(saved)return <StatusPill status="Saved"/>
  return <div className="rating-control"><input aria-label="Rating" type="range" min="1" max="10" step="0.5" value={value} onChange={(event)=>setValue(Number(event.target.value))}/><span className="rating-value">{value.toFixed(1)}</span><button className="secondary-button" onClick={save}>Save</button></div>
}

function MotmControl({matchId,players}:{matchId:string;players:Profile[]}){
  const {profile}=useAuth();const supabase=useMemo(()=>getSupabaseBrowserClient(),[]);const [choice,setChoice]=useState('');const [saved,setSaved]=useState(false)
  async function vote(){if(!profile||!choice)return;const {error}=await supabase.from('motm_votes').insert({match_id:matchId,voter_id:profile.id,target_player_id:choice});if(!error)setSaved(true)}
  return <section className="card section"><p className="eyebrow">MAN OF THE MATCH</p><h2>Your vote</h2><p className="muted">Choose one player. Votes stay hidden until the match is finalised.</p>{saved?<p className="form-message">Vote submitted.</p>:<div className="button-row"><select aria-label="Man of the Match" value={choice} onChange={(event)=>setChoice(event.target.value)}><option value="">Choose a player</option>{players.map((player)=><option value={player.id} key={player.id}>{player.nickname||player.full_name}</option>)}</select><button className="primary-button" disabled={!choice} onClick={vote}>Submit vote</button></div>}</section>
}
