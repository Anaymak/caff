'use client'

import { useParams } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { Avatar } from '@/components/avatar'
import { getSupabaseBrowserClient } from '@/lib/supabase/client'
import type { PlayerStats, Profile } from '@/lib/types'

export default function PlayerPage(){
  const {id}=useParams<{id:string}>(); const supabase=useMemo(()=>getSupabaseBrowserClient(),[]); const [player,setPlayer]=useState<Profile|null>(null); const [stats,setStats]=useState<PlayerStats|null>(null)
  useEffect(()=>{Promise.all([supabase.from('profiles').select('*').eq('id',id).single(),supabase.from('player_stats').select('*').eq('player_id',id).maybeSingle()]).then(([p,s])=>{setPlayer(p.data as Profile);setStats(s.data as PlayerStats|null)})},[id,supabase])
  if(!player)return <div className="spinner"/>
  const winPercentage=stats?.matches_played?Math.round((stats.matches_won/stats.matches_played)*100):0
  return <><section className="card hero-card"><Avatar profile={player} size="lg"/><p className="eyebrow" style={{color:'#c9f247',marginTop:'1rem'}}>{player.preferred_position?.replace('_',' ')??'CAFF PLAYER'}</p><h2>{player.nickname||player.full_name}</h2>{player.nickname&&<p className="muted">{player.full_name}</p>}<p>{player.bio||'No bio added yet.'}</p></section><section className="grid three section"><div className="card"><p className="eyebrow">OVERALL</p><h2>{stats?.overall_rating?Number(stats.overall_rating).toFixed(1):'—'}</h2><p className="muted">Career rating</p></div><div className="card"><p className="eyebrow">CURRENT FORM</p><h2>{stats?.recent_form?Number(stats.recent_form).toFixed(1):'—'}</h2><p className="muted">Last 5 eligible matches</p></div><div className="card"><p className="eyebrow">MOTM</p><h2>{stats?.motm_awards??0}</h2><p className="muted">Awards</p></div></section><section className="card section"><div className="section-title"><h2>Player record</h2></div><div className="stat-row"><div className="stat"><strong>{stats?.matches_played??0}</strong><span>Played</span></div><div className="stat"><strong>{stats?.matches_won??0}</strong><span>Won</span></div><div className="stat"><strong>{stats?.goals??0}</strong><span>Goals</span></div><div className="stat"><strong>{winPercentage}%</strong><span>Win rate</span></div></div></section></>
}
