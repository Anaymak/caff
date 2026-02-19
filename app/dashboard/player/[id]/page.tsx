'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useParams } from 'next/navigation'

export default function PlayerProfile() {
  const params = useParams()
  const playerId = params.id
  const [player, setPlayer] = useState<any>(null)
  const [user, setUser] = useState<any>(null)
  const [ratings, setRatings] = useState<any[]>([])
  const [avgRating, setAvgRating] = useState<number | null>(null)

  useEffect(() => {
    // Fetch logged-in user
    const fetchUser = async () => {
      const { data } = await supabase.auth.getSession()
      setUser(data.session?.user ?? null)
    }

    // Fetch player profile
    const fetchPlayer = async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', playerId)
        .single()
      if (error) console.log(error)
      else setPlayer(data)
    }

    // Fetch all ratings for this player
    const fetchRatings = async () => {
      const { data, error } = await supabase
        .from('ratings')
        .select('rating, game_id, created_at, rater_user_id')
        .eq('rated_user_id', playerId)
      if (error) console.log(error)
      else {
        setRatings(data ?? [])
        const avg =
          data?.reduce((acc: number, r: any) => acc + r.rating, 0) / data.length
        setAvgRating(avg ?? null)
      }
    }

    fetchUser()
    fetchPlayer()
    fetchRatings()
  }, [playerId])

  // Function to rate player
  const ratePlayer = async (rating: number) => {
    if (!user) return

    if (user.id === playerId) {
      alert("You can't rate yourself!")
      return
    }

    // Check if already rated this player for the same game
    const existing = ratings.find((r) => r.rater_user_id === user.id)
    if (existing) {
      alert('You have already rated this player!')
      return
    }

    const { error } = await supabase.from('ratings').insert([
      {
        rated_user_id: playerId,
        rater_user_id: user.id,
        rating,
        game_id: null, // you can replace with current game id if you track games
      },
    ])

    if (error) console.log(error)
    else {
      alert(`You rated ${player.email} a ${rating}/10`)
      setRatings([...ratings, { rating, rater_user_id: user.id }])
      const total = ratings.reduce((acc, r) => acc + r.rating, 0) + rating
      setAvgRating(total / (ratings.length + 1))
    }
  }

  if (!player) return <p>Loading player...</p>

  return (
    <div className="p-10 max-w-md mx-auto">
      <div className="flex items-center mb-4">
        {player.avatar_url ? (
          <img
            src={player.avatar_url}
            alt={player.email}
            className="w-16 h-16 rounded-full mr-4 object-cover"
          />
        ) : (
          <div className="w-16 h-16 rounded-full mr-4 bg-gray-300 flex items-center justify-center text-lg">
            {player.email[0].toUpperCase()}
          </div>
        )}
        <div>
          <h1 className="text-2xl font-bold">{player.email}</h1>
          <p className="text-gray-600">Average Rating: {avgRating?.toFixed(1) ?? 'N/A'}/10</p>
        </div>
      </div>

      {user?.id !== playerId && (
        <div className="mb-4">
          <p className="font-semibold mb-2">Rate this player:</p>
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: 10 }, (_, i) => i + 1).map((num) => (
              <button
                key={num}
                onClick={() => ratePlayer(num)}
                className="px-3 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 transition"
              >
                {num}
              </button>
            ))}
          </div>
        </div>
      )}

      <h2 className="text-xl font-semibold mb-2">Past Ratings</h2>
      <ul>
        {ratings.length === 0 && <li>No ratings yet.</li>}
        {ratings.map((r, idx) => (
          <li key={idx}>
            {r.rating}/10 {r.rater_user_id === user?.id ? '(You)' : ''}
          </li>
        ))}
      </ul>
    </div>
  )
}
