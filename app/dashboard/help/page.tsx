'use client'

import { type FormEvent, useMemo, useState } from 'react'
import Link from 'next/link'
import { useAuth } from '@/components/auth-provider'
import { getSupabaseBrowserClient } from '@/lib/supabase/client'

export default function HelpPage() {
  const { profile } = useAuth()
  const supabase = useMemo(() => getSupabaseBrowserClient(), [])
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!profile) return
    const form = event.currentTarget
    const description = String(new FormData(form).get('description') ?? '').trim()
    if (description.length < 10) return setNotice('Please add a little more detail.')
    setBusy(true)
    const referrer = document.referrer
    const route = referrer && new URL(referrer).origin === window.location.origin ? new URL(referrer).pathname : window.location.pathname
    const { error } = await supabase.from('feedback_reports').insert({ reporter_id: profile.id, description, route })
    setBusy(false)
    setNotice(error ? 'Could not send your report. Please try again.' : 'Thanks, your report has been sent to the admins.')
    if (!error) form.reset()
  }

  async function requestDeletion() {
    if (!profile || !window.confirm('Request account deletion? An admin will review the request and contact you before removing your login and personal details.')) return
    setBusy(true)
    const { error } = await supabase.from('account_deletion_requests').insert({ player_id: profile.id })
    setBusy(false)
    setNotice(error ? 'Could not submit the request, or one is already open. Please contact the group owner.' : 'Your deletion request has been sent to the admins.')
  }

  return <><header className="page-header"><div><p className="eyebrow">HELP & PRIVACY</p><h1>Need a hand?</h1><p className="muted">Send a problem report or ask about your account.</p></div></header>
    {notice && <p className="form-message" role="status">{notice}</p>}
    <form className="card" onSubmit={submit}><h2>Report a problem</h2><label>What happened?<textarea name="description" minLength={10} maxLength={2000} required placeholder="Tell us what you were trying to do and what went wrong." /></label><button className="primary-button" disabled={busy}>Send report</button></form>
    <section className="card section"><h2>Your data</h2><p className="muted">Read how CAFF uses and shares football data.</p><Link className="secondary-button" href="/privacy">Read privacy notice</Link>{!profile?.is_owner && <p className="section"><button className="text-button" disabled={busy} onClick={requestDeletion}>Request account deletion</button></p>}</section>
  </>
}
