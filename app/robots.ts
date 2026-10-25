import type { MetadataRoute } from 'next'

export const dynamic = 'force-static'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/', disallow: ['/dashboard/', '/pay/', '/pending/', '/api/'] },
    sitemap: 'https://caffleague.com/sitemap.xml',
    host: 'https://caffleague.com',
  }
}
