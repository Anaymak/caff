'use client'

import { useRouter } from 'next/navigation'
import Image from 'next/image'
import { useEffect } from 'react'
import { useAuth } from '@/components/auth-provider'
import { StatusPill } from '@/components/status-pill'

export default function PendingPage() {
  const { user, profile, loading, refreshProfile, signOut } = useAuth()
  const router = useRouter()
  useEffect(() => {
    if (!loading && !user) router.replace('/auth')
    if (profile?.status === 'APPROVED') router.replace('/dashboard')
  }, [loading, profile, router, user])

  return <main className="center-screen pending-screen">
    <Image className="brand-mark" src="/brand/caff-logo.png" alt="CAFF League" width={96} height={96} priority />
    <StatusPill status={profile?.status ?? 'PENDING'} />
    <h1>{profile?.status === 'SUSPENDED' ? 'Account suspended' : profile?.status === 'REJECTED' ? 'Access not approved' : 'You’re on the team sheet'}</h1>
    <p>{profile?.status === 'PENDING' || !profile ? 'Your account is awaiting admin approval. We’ll let you in as soon as it has been reviewed.' : 'Please contact a CAFF admin if you think this is a mistake.'}</p>
    <div className="button-row"><button className="primary-button" onClick={refreshProfile}>Check again</button><button className="secondary-button" onClick={signOut}>Sign out</button></div>
  </main>
}
