# CAFF project status (2026-10-25)

**Phase:** launch ready. Core app live; pitch payments in Stripe test mode; live mode fully prepared and verified, awaiting owner approval.

**Production:** https://caffleague.com (S3 + CloudFront, Supabase). Old domains redirect. Payments API (Lambda) deployed in test mode.

**Completed:** membership, approval, matches, availability, teams, ratings/MOTM, polls, admin/people/audit; canonical domain + redirects + SEO; pitch sessions, equal penny-exact splits, payment requests, Stripe Checkout + signed idempotent webhooks, manual payments, refunds, fee estimates + actual fees, permissions, CSV; £1 test-mode end-to-end payment verified.

**Blockers:**
- Live payments: only the owner's explicit approval. Live account active, live key + webhook + `/caff/payments-live/` secrets verified, live health check passed, rollback verified (2026-10-25).

**Risks:** GitHub `main` lags `pitch-payments` (all pushed to `origin/pitch-payments`); project in iCloud-synced ~/Documents (incremental tsc disabled); no password reset; AWS CLI on root credentials; Supabase Free pause risk.

**Verification:** 46/46 tests (2026-10-25 late); earlier 45/45 tests, tsc, lint, build pass (2026-10-25). Migration 002 applied and verified; site deployed from the new folder (invalidation `IE6NV3RUDJHBQ5WHBA58IPN1EQ`); test-session exclusion, banner and redirects verified live.

**Next three actions:**
1. Owner: approve the live switch (agent: `scripts/go-live.sh live`; Owner: Payment settings → Live) (~5 min).
2. First real payment: a small real charge only with the owner's approval, then refund or keep (~5 min).
3. Invite the first real players: they sign up at https://caffleague.com, you approve them in Admin (~10 min).
