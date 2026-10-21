import PlayerPage from './client'

// Static export: one prerendered page per dynamic route; CloudFront serves it for every id.
export function generateStaticParams() {
  return [{ id: '_' }]
}

export default function Page() {
  return <PlayerPage />
}
