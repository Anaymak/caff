'use client'

import { useEffect, useState } from 'react'
import { getSupabaseBrowserClient } from '@/lib/supabase/client'
import type { Profile } from '@/lib/types'

type AvatarProfile = Pick<Profile, 'full_name' | 'avatar_url'>
const signedAvatars = new Map<string, { url: string; expiresAt: number }>()

function storagePath(url: string) {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!base) return null
  try {
    const source = new URL(url)
    const project = new URL(base)
    const prefix = '/storage/v1/object/public/avatars/'
    if (source.origin !== project.origin || !source.pathname.startsWith(prefix)) return null
    return decodeURIComponent(source.pathname.slice(prefix.length))
  } catch {
    return null
  }
}

export function invalidateAvatarUrl(url: string) {
  const path = storagePath(url)
  if (path) signedAvatars.delete(path)
}

export function Avatar({ profile, size = 'md' }: { profile: AvatarProfile; size?: 'sm' | 'md' | 'lg' }) {
  const [signed, setSigned] = useState<{ original: string; url: string } | null>(null)
  useEffect(() => {
    let mounted = true
    const original = profile.avatar_url
    if (!original) return
    const path = storagePath(original)
    if (!path) return
    const cached = signedAvatars.get(path)
    if (cached && cached.expiresAt > Date.now()) {
      queueMicrotask(() => { if (mounted) setSigned({ original, url: cached.url }) })
    } else {
      void getSupabaseBrowserClient().storage.from('avatars').createSignedUrl(path, 3600)
        .then(({ data, error }) => {
          if (error || !data?.signedUrl) return
          signedAvatars.set(path, { url: data.signedUrl, expiresAt: Date.now() + 50 * 60_000 })
          if (mounted) setSigned({ original, url: data.signedUrl })
        })
    }
    return () => { mounted = false }
  }, [profile.avatar_url])
  const initials = profile.full_name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase() || '?'

  const source = signed?.original === profile.avatar_url ? signed.url : null
  return source ? (
    // Supabase photos are displayed through short-lived signed URLs.
    // eslint-disable-next-line @next/next/no-img-element
    <img className={`avatar avatar-${size}`} src={source} alt={`${profile.full_name} profile`} onError={() => setSigned(null)} />
  ) : (
    <span className={`avatar avatar-${size} avatar-fallback`} aria-hidden="true">{initials}</span>
  )
}
