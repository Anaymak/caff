'use client'

import { getSupabaseBrowserClient } from '@/lib/supabase/client'

// The payments Lambda is served by the same CloudFront distribution under /api.
// NEXT_PUBLIC_PAYMENTS_API_BASE can point local development at another origin.
const BASE = process.env.NEXT_PUBLIC_PAYMENTS_API_BASE || '/api'

export async function paymentsApi<T>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown; admin?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (init.admin) {
    const { data } = await getSupabaseBrowserClient().auth.getSession()
    if (!data.session) throw new Error('Sign in again to continue.')
    headers.Authorization = `Bearer ${data.session.access_token}`
  }
  let response: Response
  try {
    response = await fetch(`${BASE}${path}`, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body), cache: 'no-store' })
  } catch {
    throw new Error('Could not reach the payments service. Check your connection and try again.')
  }
  const json = await response.json().catch(() => null)
  if (!response.ok) {
    const error = new Error(json?.error ?? (response.status === 404 ? 'The payments service is not set up yet.' : 'The payments service could not complete that.')) as Error & { status?: number; reason?: string }
    error.status = response.status
    error.reason = json?.reason
    throw error
  }
  return json as T
}

/** Runs an RPC that may need explicit confirmation ("CONFIRM_REQUIRED: …"), asking the admin once. */
export async function rpcWithConfirm(run: (confirm: boolean) => PromiseLike<{ error: { message: string } | null; data?: unknown }>) {
  const first = await run(false)
  if (!first.error?.message.startsWith('CONFIRM_REQUIRED')) return first
  if (!window.confirm(`${first.error.message.replace(/^CONFIRM_REQUIRED:\s*/, '')}\n\nContinue?`)) return { error: null, data: null, cancelled: true }
  return run(true)
}

export function friendlyError(message: string) {
  return message.replace(/^(PERMISSION_DENIED|STALE|CONFIRM_REQUIRED):\s*/, '')
}

export function payLink(requestId: string) {
  return `${window.location.origin}/pay/?r=${requestId}`
}
