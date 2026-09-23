'use client'

import type { User } from '@supabase/supabase-js'
import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { getSupabaseBrowserClient } from '@/lib/supabase/client'
import type { Profile } from '@/lib/types'

interface AuthState {
  user: User | null
  profile: Profile | null
  loading: boolean
  refreshProfile: () => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loading, setLoading] = useState(true)
  const supabase = useMemo(() => getSupabaseBrowserClient(), [])

  async function loadProfile(userId: string) {
    const { data } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle()
    setProfile(data as Profile | null)
  }

  async function refreshProfile() {
    if (user) await loadProfile(user.id)
  }

  useEffect(() => {
    let mounted = true
    async function initialise() {
      try {
        const { data } = await supabase.auth.getSession()
        if (!mounted) return
        const sessionUser = data.session?.user ?? null
        setUser(sessionUser)
        if (sessionUser) await loadProfile(sessionUser.id)
      } finally {
        if (mounted) setLoading(false)
      }
    }
    void initialise()

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      const sessionUser = session?.user ?? null
      setUser(sessionUser)
      // Supabase invokes this callback while holding its auth lock. Starting a
      // second Supabase request inside an awaited callback can deadlock login.
      if (sessionUser) {
        setLoading(true)
        setTimeout(() => {
          if (mounted) {
            void loadProfile(sessionUser.id).finally(() => {
              if (mounted) setLoading(false)
            })
          }
        }, 0)
      } else {
        setProfile(null)
        setLoading(false)
      }
    })
    return () => {
      mounted = false
      data.subscription.unsubscribe()
    }
    // Supabase and loadProfile are intentionally stable for the provider lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase])

  async function signOut() {
    await supabase.auth.signOut()
    window.location.assign('/auth')
  }

  return (
    <AuthContext.Provider value={{ user, profile, loading, refreshProfile, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used within AuthProvider')
  return context
}
