'use client'

import Link from 'next/link'
import Image from 'next/image'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useAuth } from '@/components/auth-provider'
import { getSupabaseBrowserClient } from '@/lib/supabase/client'

const navigation = [
  { href: '/dashboard', label: 'Home', icon: '⌂' },
  { href: '/dashboard/matches', label: 'Matches', icon: '⚽' },
  { href: '/dashboard/players', label: 'Players', icon: '◉' },
  { href: '/dashboard/profile', label: 'Profile', icon: '♙' },
]

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, profile, loading, signOut } = useAuth()
  const pathname = usePathname()
  const router = useRouter()
  const [unread, setUnread] = useState(0)

  useEffect(() => {
    if (!profile?.id) return
    let active = true
    const refresh = async () => {
      const { count, error } = await getSupabaseBrowserClient().from('in_app_notifications')
        .select('id', { count: 'exact', head: true }).eq('recipient_id', profile.id).is('read_at', null)
      if (active && !error) setUnread(count ?? 0)
    }
    void refresh()
    window.addEventListener('caff-notifications-updated', refresh)
    return () => { active = false; window.removeEventListener('caff-notifications-updated', refresh) }
  }, [profile?.id, pathname])

  useEffect(() => {
    if (loading) return
    if (!user) router.replace('/auth')
    else if (!profile || profile.status !== 'APPROVED') router.replace('/pending')
  }, [loading, profile, router, user])

  if (loading || !user || !profile || profile.status !== 'APPROVED') {
    return <main className="center-screen"><div className="spinner" /><p>Preparing CAFF…</p></main>
  }

  return (
    <div className="app-frame">
      <header className="topbar">
        <Link href="/dashboard" className="brand" aria-label="CAFF home">
          <Image className="brand-logo" src="/brand/caff-logo.png" alt="CAFF League" width={46} height={46} priority />
          <span className="brand-copy"><strong>CAFF</strong><small>Casual football</small></span>
        </Link>
        <div className="topbar-actions">
          {profile.role === 'ADMIN' && <Link className="admin-link" href="/dashboard/admin">Admin</Link>}
          <Link className="text-button notification-link" href="/dashboard/notifications" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}>🔔<span className="notification-label">Alerts</span>{unread > 0 && <span className="notification-badge">{unread > 99 ? '99+' : unread}</span>}</Link>
          <Link className="text-button" href="/dashboard/help">Help</Link>
          <button className="text-button" onClick={signOut}>Sign out</button>
        </div>
      </header>
      <main className="page-content">{children}</main>
      <nav className="bottom-nav" aria-label="Primary navigation">
        {navigation.map((item) => {
          const active = item.href === '/dashboard' ? pathname === item.href : pathname.startsWith(item.href)
          return <Link key={item.href} href={item.href} className={active ? 'active' : ''}><span>{item.icon}</span>{item.label}</Link>
        })}
      </nav>
    </div>
  )
}
