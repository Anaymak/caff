'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import Link from 'next/link'

export default function TeamsPage() {
  const [teams, setTeams] = useState<any>(null)
  const [user, setUser] = useState<any>(null)
  const [ratings, setRatings] = useState<any[]>([])
  const [avgRatings, setAvgRatings] = useState<Record<string, { avg: number; count: number }>>({})
  const [showRatingButtons, setShowRatingButtons] = useState(true)

  // Fetch current user session
  useEffect(() => {
    const fetchUser = async () => {
      const { data } = await supabase.auth.getSession()
      setUser(data.session?.user ?? null)
    }
    fetchUser()
  }, [])

  // Fetch next game teams
  useEffect(() => {
    const fetchTeams = async () => {
      const { data, error } = await supabase
        .from('teams')
        .select(`
          *,
          profiles!inner(id,email,avatar_url)
        `)
        .order('game_date', { ascending: true })
        .limit(1)
      if (error) console.log(error)
      else setTeams(data?.[0] ?? null)
    }
    fetchTeams()
  }, [])

  // Fetch ratings for this game
  useEffect(() => {
    if (!user || !teams) return

    const fetchRatings = async () => {
      const { data, error } = await supabase
        .from('ratings')
        .select('*')
        .eq('game_id', teams.id)
      if (error) console.log(error)
      else setRatings(data ?? [])
    }

    fetchRatings()
  }, [user, teams])

  // Helper to compute average rating
  useEffect(() => {
    if (!ratings.length) return
    const avg: Record<string, { avg: number; count: number }> = {}
    ratings.forEach((r) => {
      if (!avg[r.rated_user_id]) avg[r.rated_user_id] = { avg: 0, count: 0 }
      avg[r.rated_user_id].avg += r.rating
      avg[r.rated_user_id].count += 1
    })
    Object.keys(avg).forEach((key) => {
      avg[key].avg = avg[key].avg / avg[key].count
    })
    setAvgRatings(avg)
  }, [ratings])

  if (!user) return <p className="p-10">Loading user...</p>
  if (!teams) return <p className="p-10">No teams assigned yet.</p>

  const alreadyRated = (playerId: string) =>
    ratings.some((r) => r.rated_user_id === playerId && r.rater_user_id === user.id)

  const ratePlayer = async (playerId: string, playerEmail: string, rating: number) => {
    if (playerEmail === user.email) {
      alert("You can't rate yourself!")
      return
    }
    if (alreadyRated(playerId)) {
      alert(`You already rated ${playerEmail} for this game!`)
      return
    }

    const { error } = await supabase.from('ratings').insert([
      {
        rated_user_id: playerId,
        rater_user_id: user.id,
        rating,
        game_id: teams.id,
      },
    ])
    if (error) console.log(error)
    else {
      alert(`You rated ${playerEmail} a ${rating}/10`)
      setRatings([...ratings, { rated_user_id: playerId, rater_user_id: user.id, rating }])
    }
  }

  const getAvgRatingDisplay = (playerId: string) => {
    const r = avgRatings[playerId]
    if (!r) return 'N/A'
    const color =
      r.avg < 4 ? 'text-red-500' : r.avg < 7 ? 'text-yellow-500' : 'text-green-500'
    return (
      <span className={`${color} font-semibold`}>
        {r.avg.toFixed(1)} ({r.count})
      </span>
    )
  }

  const renderPlayer = (profile: any) => (
    <li key={profile.id} className="flex flex-col sm:flex-row items-center justify-between mb-3 border-b pb-2">
      <div className="flex items-center gap-3 mb-2 sm:mb-0">
        {profile.avatar_url ? (
          <img
            src={profile.avatar_url}
            alt={profile.email}
            className="w-10 h-10 rounded-full border object-cover"
          />
        ) : (
          <div className="w-10 h-10 rounded-full border bg-gray-300 flex items-center justify-center text-sm font-bold">
            {profile.email[0].toUpperCase()}
          </div>
        )}
        <Link
          href={`/dashboard/player/${profile.id}`}
          className="truncate max-w-[150px] sm:max-w-[200px] text-blue-600 hover:underline"
          title={profile.email}
        >
          {profile.email}
        </Link>
        <span className="ml-2">(Avg: {getAvgRatingDisplay(profile.id)}/10)</span>
      </div>

      {showRatingButtons && (
        <div className="flex flex-wrap gap-1">
          {profile.email !== user.email &&
            Array.from({ length: 10 }, (_, i) => i + 1).map((num) => (
              <button
                key={num}
                disabled={alreadyRated(profile.id)}
                onClick={() => ratePlayer(profile.id, profile.email, num)}
                className={`px-2 py-1 rounded ${
                  alreadyRated(profile.id)
                    ? 'bg-gray-400 cursor-not-allowed'
                    : 'bg-blue-500 text-white hover:bg-blue-600'
                }`}
              >
                {num}
              </button>
            ))}
        </div>
      )}
    </li>
  )

  return (
    <div className="p-10">
      <h1 className="text-2xl mb-6 font-bold text-center">
        Teams for {new Date(teams.game_date).toLocaleString()}
      </h1>

      <div className="text-center mb-4">
        <button
          onClick={() => setShowRatingButtons(!showRatingButtons)}
          className="px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600"
        >
          {showRatingButtons ? 'Hide Ratings' : 'Show Ratings'}
        </button>
      </div>

      <div className="flex flex-col md:flex-row justify-between max-w-4xl mx-auto gap-10">
        <div className="w-full md:w-1/2">
          <h2 className="text-xl font-semibold mb-4 text-center">Team A</h2>
          <ul>{teams.team_a?.map((profile: any) => renderPlayer(profile))}</ul>
        </div>

        <div className="w-full md:w-1/2">
          <h2 className="text-xl font-semibold mb-4 text-center">Team B</h2>
          <ul>{teams.team_b?.map((profile: any) => renderPlayer(profile))}</ul>
        </div>
      </div>
    </div>
  )
}
