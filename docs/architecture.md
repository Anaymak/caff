# Architecture

```
Browser ──https──> CloudFront EGBP9DEUE6XFR (caffleague.com)
   │                 ├─ default: S3 caff-site-971422695222 (static Next.js export)
   │                 │    viewer-request function caff-static-routes:
   │                 │      non-canonical host → 301 https://caffleague.com
   │                 │      /dashboard/{matches,admin/matches,player}/<id>/ → prerendered "_" page
   │                 │      directories → index.html; extensionless → trailing-slash 301
   │                 └─ /api/*: Lambda Function URL caff-payments (no cache)
   │                         ├─ Stripe REST API (checkout, refunds, fees)
   │                         └─ Supabase PostgREST RPC (service key for Stripe facts, user JWT for admin actions)
   └──https──> Supabase vkdsdgiecuvviaukrafa (Auth + Postgres + Storage), RLS enforced
Stripe (CAFF acct_1UUS7nIatQExHTBt) ──webhook──> https://caffleague.com/api/stripe/webhook
```

- **Frontend:** Next.js 16 / React 19, `output: 'export'`, `trailingSlash: true`. All pages are client components reading Supabase directly. Auth state: `components/auth-provider.tsx`; layout and nav: `components/app-shell.tsx`. Feature flag `NEXT_PUBLIC_PITCH_SESSIONS` (`lib/features.ts`) gates the sessions/payments pages.
- **Data:** Supabase Postgres with RLS on every table. Players see a narrow view of others (`public_player_profiles`). Votes and ratings are private to the voter and admins.
- **Money:** SQL functions (migration `202610250001`) own calculations, permissions, locking and audit. `lib/domain/payments.ts` mirrors the maths for previews.
- **Payments API:** `payments/handler.mjs`, routes `GET /api/pay/request`, `POST /api/pay/checkout`, `POST /api/stripe/webhook`, `POST /api/admin/{refund,expire-checkouts,reconcile-fees}`. It avoids 403/404 responses because CloudFront error pages would replace them.
- **Redirect-only Vercel project:** `vercel-redirect/` (no build, `vercel.json` redirects).
