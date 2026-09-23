'use client'

import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import { getSupabaseBrowserClient } from '@/lib/supabase/client'

export default function AuthPage() {
  const router = useRouter()
  const supabase = useMemo(() => getSupabaseBrowserClient(), [])
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) router.replace('/dashboard')
    })
  }, [router, supabase])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setMessage('')
    try {
      if (mode === 'signup') {
        const { error } = await supabase.auth.signUp({ email, password, options: { data: { full_name: fullName.trim() } } })
        if (error) return setMessage('We could not create your account. Check the details and try again.')
        setMessage('Account created. Confirm your email, then an admin will approve your access.')
        return
      }
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) return setMessage('Email or password is incorrect.')
      router.replace('/dashboard')
    } catch {
      setMessage('Sign in was interrupted. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-intro">
        <Image className="brand-mark" src="/brand/caff-logo.png" alt="CAFF League" width={96} height={96} priority />
        <p className="eyebrow">CASUAL FOOTBALL, SORTED</p>
        <h1>Your game.<br />Your people.</h1>
        <p>Availability, balanced teams, results and bragging rights—all in one place.</p>
      </section>
      <section className="auth-card">
        <div className="segmented" role="tablist">
          <button className={mode === 'signin' ? 'active' : ''} onClick={() => setMode('signin')}>Sign in</button>
          <button className={mode === 'signup' ? 'active' : ''} onClick={() => setMode('signup')}>Join CAFF</button>
        </div>
        <form onSubmit={submit}>
          <h2>{mode === 'signin' ? 'Welcome back' : 'Create your account'}</h2>
          <p className="muted">{mode === 'signin' ? 'Sign in to see the next match.' : 'New accounts need approval from an admin.'}</p>
          {mode === 'signup' && <label>Full name<input required autoComplete="name" value={fullName} onChange={(event) => setFullName(event.target.value)} /></label>}
          <label>Email<input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          <label>Password<input required minLength={8} type="password" autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          <button className="primary-button" disabled={busy}>{busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Create account'}</button>
          {message && <p className="form-message" role="status">{message}</p>}
        </form>
      </section>
    </main>
  )
}
