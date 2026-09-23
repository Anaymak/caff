'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { Avatar } from '@/components/avatar'
import { getSupabaseBrowserClient } from '@/lib/supabase/client'
import type { PlayerStats, Profile } from '@/lib/types'

export default function PlayersPage(){
  const supabase=useMemo(()=>getSupabaseBrowserClient(),[]); const [players,setPlayers]=useState<Profile[]>([]); const [stats,setStats]=useState<PlayerStats[]>([])
  useEffect(()=>{Promise.all([supabase.from('profiles').select('*').eq('status','APPROVED').order('full_name'),supabase.from('player_stats').select('*')]).then(([p,s])=>{setPlayers((p.data??[]) as Profile[]);setStats((s.data??[]) as PlayerStats[])})},[supabase])
  return <><header className="page-header"><div><p className="eyebrow">THE SQUAD</p><h1>Players</h1><p className="muted">Form, goals and appearances.</p></div></header><div className="card">{players.length===0?<p className="muted">No approved players yet.</p>:players.map((player)=>{const summary=stats.find((item)=>item.player_id===player.id);return <Link className="player-row" href={`/dashboard/player/${player.id}`} key={player.id}><Avatar profile={player}/><div className="player-copy"><strong>{player.nickname||player.full_name}</strong><small>{player.preferred_position?.toLowerCase()??'Position not set'} · {summary?.matches_played??0} appearances</small></div><div style={{textAlign:'right'}}><strong>{summary?.recent_form?Number(summary.recent_form).toFixed(1):'—'}</strong><small>form</small></div></Link>})}</div></>
}

