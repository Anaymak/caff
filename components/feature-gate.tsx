import Link from 'next/link'
import { PITCH_SESSIONS_ENABLED } from '@/lib/features'

/** Renders pitch-session pages only once the feature is switched on at build time. */
export function PitchSessionsGate({ children, publicPage = false }: { children: React.ReactNode; publicPage?: boolean }) {
  if (PITCH_SESSIONS_ENABLED) return children
  const body = <div className="card empty-state"><h2>Coming soon</h2><p className="muted">Pitch sessions and payments are being set up.</p><Link className="secondary-button" href={publicPage ? '/auth' : '/dashboard/admin'}>{publicPage ? 'Go to CAFF' : 'Back to Admin'}</Link></div>
  return publicPage ? <main className="pay-page">{body}</main> : body
}
