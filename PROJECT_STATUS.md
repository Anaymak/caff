# CAFF project status (2026-10-25)

**Phase:** launched. Core app and pitch payments live (Stripe live mode, enabled 2026-10-25 with owner approval).

**Production:** https://caffleague.com (S3 + CloudFront, Supabase). Old domains redirect. Payments API (Lambda) deployed in test mode.

**Completed:** membership, approval, matches, availability, teams, ratings/MOTM, polls, admin/people/audit; canonical domain + redirects + SEO; pitch sessions, equal penny-exact splits, payment requests, Stripe Checkout + signed idempotent webhooks, manual payments, refunds, fee estimates + actual fees, permissions, CSV; £1 test-mode end-to-end payment verified.

**Blockers:**
- None. First real live payment (£0.30, owner's card) verified end to end on 2026-10-25.

**Risks:** GitHub `main` lags `pitch-payments` (all pushed to `origin/pitch-payments`); project in iCloud-synced ~/Documents (incremental tsc disabled); no password reset; AWS CLI on root credentials; Supabase Free pause risk.

**Verification:** 46/46 tests (2026-10-25 late); earlier 45/45 tests, tsc, lint, build pass (2026-10-25). Migration 002 applied and verified; site deployed from the new folder (invalidation `IE6NV3RUDJHBQ5WHBA58IPN1EQ`); test-session exclusion, banner and redirects verified live.

**Next three actions:**
1. Invite players: sign up at https://caffleague.com, approve in Admin (~10 min).
2. Issue payment requests for the next real session (~5 min).
3. Fix the test-session banner copy that calls all test-session payments "not real money" (~10 min).
3. Invite the first real players: they sign up at https://caffleague.com, you approve them in Admin (~10 min).
