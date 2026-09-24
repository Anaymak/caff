'use client'

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { Avatar } from '@/components/avatar'
import { getSupabaseBrowserClient } from '@/lib/supabase/client'
import type { Match, PlayerStats, PublicPlayer, TeamAssignment } from '@/lib/types'

type MatchRating = { match_id: string; average_rating: number }

export default function PlayerPage() {
  const { id } = useParams<{ id: string }>()
  const supabase = useMemo(() => getSupabaseBrowserClient(), [])
  const [player, setPlayer] = useState<PublicPlayer | null>(null)
  const [stats, setStats] = useState<PlayerStats | null>(null)
  const [history, setHistory] = useState<Match[]>([])
  const [assignments, setAssignments] = useState<TeamAssignment[]>([])
  const [ratings, setRatings] = useState<MatchRating[]>([])
  const [error, setError] = useState(false)

  useEffect(() => {
    let active = true
    void Promise.all([
      supabase.from('public_player_profiles').select('*').eq('id', id).single(),
      supabase.from('player_stats').select('*').eq('player_id', id).maybeSingle(),
      supabase.from('matches').select('*').eq('status', 'FINALISED').order('starts_at', { ascending: false }),
      supabase.from('team_assignments').select('*').eq('player_id', id),
      supabase.from('public_match_ratings').select('match_id,average_rating').eq('player_id', id),
    ]).then(([person, summary, matches, teams, scores]) => {
      if (!active) return
      if (person.error || summary.error || matches.error || teams.error || scores.error) { setError(true); return }
      setPlayer(person.data as PublicPlayer)
      setStats(summary.data as PlayerStats | null)
      setHistory((matches.data ?? []) as Match[])
      setAssignments((teams.data ?? []) as TeamAssignment[])
      setRatings((scores.data ?? []) as MatchRating[])
    })
    return () => { active = false }
  }, [id, supabase])

  if (error) return <div className="card empty-state"><h2>Could not load this player</h2><p className="muted">Please refresh and try again.</p></div>
  if (!player) return <div className="spinner" />

  const winPercentage = stats?.matches_played ? Math.round((stats.matches_won / stats.matches_played) * 100) : 0
  const played = history.filter((match) => assignments.some((assignment) => assignment.match_id === match.id))
  const lastFive = played.map((match) => ratings.find((rating) => rating.match_id === match.id)?.average_rating).filter((score): score is number => score != null).slice(0, 5)
  const sideFor = (matchId: string) => assignments.find((assignment) => assignment.match_id === matchId)?.side
  const resultFor = (match: Match) => {
    if (match.bibs_score == null || match.non_bibs_score == null) return '—'
    if (match.bibs_score === match.non_bibs_score) return 'D'
    const won = (sideFor(match.id) === 'BIBS' && match.bibs_score > match.non_bibs_score) ||
      (sideFor(match.id) === 'NON_BIBS' && match.non_bibs_score > match.bibs_score)
    return won ? 'W' : 'L'
  }

  return <>
    <section className="card hero-card"><Avatar profile={player} size="lg" /><p className="eyebrow" style={{ color: '#c9f247', marginTop: '1rem' }}>{player.preferred_position?.replace('_', ' ') ?? 'CAFF PLAYER'}</p><h2>{player.nickname || player.full_name}</h2>{player.nickname && <p className="muted">{player.full_name}</p>}<p>{player.bio || 'No bio added yet.'}</p></section>
    <section className="grid three section"><div className="card"><p className="eyebrow">OVERALL</p><h2>{stats?.overall_rating ? Number(stats.overall_rating).toFixed(1) : '—'}</h2><p className="muted">Career rating</p></div><div className="card"><p className="eyebrow">CURRENT FORM</p><h2>{stats?.recent_form ? Number(stats.recent_form).toFixed(1) : '—'}</h2><p className="muted">Last 5 eligible matches</p></div><div className="card"><p className="eyebrow">MOTM</p><h2>{stats?.motm_awards ?? 0}</h2><p className="muted">Awards</p></div></section>
    <section className="card section"><div className="section-title"><h2>Player record</h2></div><div className="stat-row"><div className="stat"><strong>{stats?.matches_played ?? 0}</strong><span>Played</span></div><div className="stat"><strong>{stats?.matches_won ?? 0}</strong><span>Won</span></div><div className="stat"><strong>{stats?.goals ?? 0}</strong><span>Goals</span></div><div className="stat"><strong>{winPercentage}%</strong><span>Win rate</span></div></div></section>
    <section className="card section"><h2>Last five ratings</h2><p className="muted">Only matches with at least three eligible ratings count.</p><div className="form-strip">{lastFive.length ? lastFive.map((score, index) => <span key={index}>{Number(score).toFixed(1)}</span>) : <span className="muted">No official ratings yet.</span>}</div></section>
    <section className="card section"><h2>Recent matches</h2>{played.length ? played.slice(0, 8).map((match) => <Link className="history-row" href={`/dashboard/matches/${match.id}`} key={match.id}><time dateTime={match.starts_at}>{new Date(match.starts_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</time><strong>{match.title}</strong><span>{match.bibs_score ?? '—'}–{match.non_bibs_score ?? '—'}</span><b aria-label={`Result ${resultFor(match)}`}>{resultFor(match)}</b></Link>) : <p className="muted">No completed matches yet.</p>}</section>
  </>
}
