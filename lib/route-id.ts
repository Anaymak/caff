'use client'
import { useParams, usePathname } from 'next/navigation'

/** Placeholder segment the static export renders for every dynamic [id] route. */
export const STATIC_ID_PLACEHOLDER = '_'

/**
 * The [id] segment of the current URL. On the static (S3 + CloudFront) build every
 * id is served by the page prerendered for "_", so useParams() would return "_";
 * the real id is read from the browser path instead.
 */
export function useRouteId(): string {
  const params = useParams<{ id?: string }>()
  const pathname = usePathname()
  const fromParams = params?.id
  if (fromParams && fromParams !== STATIC_ID_PLACEHOLDER) return decodeURIComponent(fromParams)
  // usePathname() follows client-side navigation (window.location updates only after render);
  // window.location is the fallback if the router still reports the "_" placeholder path.
  const fromPath = idFromPath(pathname ?? '')
  if (fromPath) return fromPath
  return typeof window === 'undefined' ? '' : idFromPath(window.location.pathname)
}

/** Last non-empty path segment, e.g. /dashboard/matches/abc/ -> "abc". */
export function idFromPath(pathname: string): string {
  const parts = pathname.split('/').filter(Boolean)
  const last = parts[parts.length - 1] ?? ''
  return last === STATIC_ID_PLACEHOLDER ? '' : decodeURIComponent(last)
}
