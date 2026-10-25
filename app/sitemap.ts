import type { MetadataRoute } from 'next'

export const dynamic = 'force-static'

// Only the public pages; everything else needs a member account.
export default function sitemap(): MetadataRoute.Sitemap {
  return ['/auth/', '/privacy/'].map((path) => ({ url: `https://caffleague.com${path}`, changeFrequency: 'monthly' }))
}
