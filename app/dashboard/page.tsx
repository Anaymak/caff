'use client'  // 🔑 Must have this at the top

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import Link from 'next/link'

export default function Dashboard() {
  const [user, setUser] = useState<any>(null)

  useEffect(() => {
    // Get current logged-in user session
    const fetchUser = async () => {
      const { data } = await supabase.auth.getSession()
      setUser(data.session?.user ?? null)
    }
    fetchUser()
  }, [])

  if (!user) return <p>Loading...</p>

  return (
    <div className="p-10 max-w-md mx-auto">
      <h1 className="text-2xl mb-4">Welcome, {user.email}!</h1>
      <p>This is your dashboard. We will add teams and ratings here next.</p>

      {/* Link to Teams page */}
      <Link href="/dashboard/teams" className="text-blue-500 underline mt-4 block">
        View Teams & Rate Players
      </Link>
    </div>
  )
}
