'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { Avatar } from '@/components/avatar'
import { getSupabaseBrowserClient } from '@/lib/supabase/client'
import type { PlayerStats, PublicPlayer } from '@/lib/types'

export default function PlayersPage(){
  const supabase=useMemo(()=>getSupabaseBrowserClient(),[]); const [players,setPlayers]=useState<PublicPlayer[]>([]); const [stats,setStats]=useState<PlayerStats[]>([]); const [ranking,setRanking]=useState<keyof Pick<PlayerStats,'recent_form'|'overall_rating'|'goals'|'motm_awards'|'matches_played'|'attendance_percentage'>>('recent_form')
  useEffect(()=>{Promise.all([supabase.from('public_player_profiles').select('*').order('full_name'),supabase.from('player_stats').select('*')]).then(([p,s])=>{setPlayers((p.data??[]) as PublicPlayer[]);setStats((s.data??[]) as PlayerStats[])})},[supabase])
  const sorted=[...players].sort((a,b)=>{const aa=stats.find((item)=>item.player_id===a.id)?.[ranking];const bb=stats.find((item)=>item.player_id===b.id)?.[ranking];return Number(bb??-1)-Number(aa??-1)||a.full_name.localeCompare(b.full_name)})
  const valueFor=(summary:PlayerStats|undefined)=>{const value=summary?.[ranking];if(value==null)return '—';return ['recent_form','overall_rating','attendance_percentage'].includes(ranking)?`${Number(value).toFixed(1)}${ranking==='attendance_percentage'?'%':''}`:String(value)}
  return <><header className="page-header"><div><p className="eyebrow">THE SQUAD</p><h1>Players</h1><p className="muted">Form, goals and appearances.</p></div></header><div className="card"><label className="ranking-select">Leaderboard<select value={ranking} onChange={(event)=>setRanking(event.target.value as typeof ranking)}><option value="recent_form">Current form</option><option value="overall_rating">Overall rating</option><option value="goals">Goals</option><option value="motm_awards">MOTM awards</option><option value="matches_played">Appearances</option><option value="attendance_percentage">Attendance</option></select></label>{sorted.length===0?<p className="muted">No approved players yet.</p>:sorted.map((player,index)=>{const summary=stats.find((item)=>item.player_id===player.id);return <Link className="player-row" href={`/dashboard/player/${player.id}`} key={player.id}><span className="ranking-position">{index+1}</span><Avatar profile={player}/><div className="player-copy"><strong>{player.nickname||player.full_name}</strong><small>{player.preferred_position?.toLowerCase()??'Position not set'} · {summary?.matches_played??0} appearances</small></div><div style={{textAlign:'right'}}><strong>{valueFor(summary)}</strong><small>{ranking.replaceAll('_',' ')}</small></div></Link>})}</div></>
}
