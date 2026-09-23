import type { Profile } from '@/lib/types'

type AvatarProfile = Pick<Profile, 'full_name' | 'avatar_url'>

export function Avatar({ profile, size = 'md' }: { profile: AvatarProfile; size?: 'sm' | 'md' | 'lg' }) {
  const initials = profile.full_name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase() || '?'

  return profile.avatar_url ? (
    // User-uploaded Supabase URLs cannot be known at build time.
    // eslint-disable-next-line @next/next/no-img-element
    <img className={`avatar avatar-${size}`} src={profile.avatar_url} alt={`${profile.full_name} profile`} />
  ) : (
    <span className={`avatar avatar-${size} avatar-fallback`} aria-hidden="true">{initials}</span>
  )
}

