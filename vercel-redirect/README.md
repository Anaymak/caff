# CAFF on Vercel: redirect-only deployment (prepared 21 Oct 2026, NOT deployed)

CAFF lives at https://caffleague.com (AWS). Deploying this folder to the Vercel project `caff`
replaces the app with permanent redirects (no functions, no build), so old `caffleague.vercel.app` /
`caff-ecru.vercel.app` bookmarks land on the new site.

Deploy (owner approval required):
    npx vercel@latest deploy --prod --yes --scope anaymaks-projects   # from this folder, linked to project caff
Rollback (instant): `npx vercel@latest rollback caff-dq6s8vri2-anaymaks-projects.vercel.app --scope anaymaks-projects`
