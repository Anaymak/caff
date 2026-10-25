'use client'

import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import Link from 'next/link'
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
        const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { full_name: fullName.trim() } } })
        if (error) return setMessage('We could not create your account. Check the details and try again.')
        // With email confirmation off, Supabase signs the new member straight in; they then wait for approval.
        if (data.session) { router.replace('/pending'); return }
        setMessage('Account created. Check your email to confirm it, then an admin will approve your access.')
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
        <Image className="brand-mark" src="/brand/caff-logo-288.png" alt="CAFF League" width={96} height={96} priority />
        <p className="eyebrow">CASUAL FOOTBALL, SORTED</p>
        <h1>Your game.<br />Your people.</h1>
        <p>Availability, balanced teams, results and bragging rights—all in one place.</p>
        <ol className="how-it-works" aria-label="How CAFF works">
          <li><strong>Join</strong><span>Create an account. An admin approves new players.</span></li>
          <li><strong>Say you’re in</strong><span>Mark your availability for each game.</span></li>
          <li><strong>Pay your share</strong><span>The pitch cost is split equally; pay securely by card through Stripe.</span></li>
        </ol>
      </section>
      <section className="auth-card">
        <div className="segmented" role="group" aria-label="Sign in or join">
          <button type="button" aria-pressed={mode === 'signin'} className={mode === 'signin' ? 'active' : ''} onClick={() => { setMode('signin'); setMessage('') }}>Sign in</button>
          <button type="button" aria-pressed={mode === 'signup'} className={mode === 'signup' ? 'active' : ''} onClick={() => { setMode('signup'); setMessage('') }}>Join CAFF</button>
        </div>
        <form onSubmit={submit}>
          <h2>{mode === 'signin' ? 'Welcome back' : 'Create your account'}</h2>
          <p className="muted">{mode === 'signin' ? 'Sign in to see the next match.' : 'New accounts need approval from an admin.'}</p>
          {mode === 'signup' && <label>Full name<input required autoComplete="name" value={fullName} onChange={(event) => setFullName(event.target.value)} /></label>}
          <label>Email<input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          <label>Password<input required minLength={8} type="password" autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
          <button className="primary-button" disabled={busy}>{busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Create account'}</button>
          {message && <p className="form-message" role="status" aria-live="polite">{message}</p>}
        </form>
        <p className="auth-privacy"><Link href="/privacy">Privacy notice</Link></p>
      </section>
    </main>
  )
}
