# CAFF project status (2026-10-25)

**Phase:** launch preparation. Core app live; pitch payments live in Stripe test mode.

**Production:** https://caffleague.com (S3 + CloudFront, Supabase). Old domains redirect. Payments API (Lambda) deployed in test mode.

**Completed:** membership, approval, matches, availability, teams, ratings/MOTM, polls, admin/people/audit; canonical domain + redirects + SEO; pitch sessions, equal penny-exact splits, payment requests, Stripe Checkout + signed idempotent webhooks, manual payments, refunds, fee estimates + actual fees, permissions, CSV; £1 test-mode end-to-end payment verified.

**Blockers:**
- Live payments: CAFF has no live Stripe account yet (re-checked 2026-10-25 evening: only email verified; "Get live account" outstanding). `acct_1UUS7nIatQExHTBt` is the sandbox.

**Risks:** GitHub `main` lags `pitch-payments` (all pushed to `origin/pitch-payments`); project in iCloud-synced ~/Documents (incremental tsc disabled); no password reset; AWS CLI on root credentials; Supabase Free pause risk.

**Verification:** 45/45 tests, tsc, lint, build pass (2026-10-25). Migration 002 applied and verified; site deployed from the new folder (invalidation `IE6NV3RUDJHBQ5WHBA58IPN1EQ`); test-session exclusion, banner and redirects verified live.

**Next three actions:**
1. Owner: Stripe → leave sandbox → Get live account → complete business/identity/bank steps (owner, ~15 min + Stripe review time).
2. Live key + webhook under `/caff/payments-live/`, stack and Payment settings to live, after explicit approval (~30 min).
3. Invite the first real players: they sign up at https://caffleague.com, you approve them in Admin (~10 min).
