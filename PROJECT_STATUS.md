# CAFF project status (2026-10-25)

**Phase:** launch preparation. Core app live; pitch payments live in Stripe test mode.

**Production:** https://caffleague.com (S3 + CloudFront, Supabase). Old domains redirect. Payments API (Lambda) deployed in test mode.

**Completed:** membership, approval, matches, availability, teams, ratings/MOTM, polls, admin/people/audit; canonical domain + redirects + SEO; pitch sessions, equal penny-exact splits, payment requests, Stripe Checkout + signed idempotent webhooks, manual payments, refunds, fee estimates + actual fees, permissions, CSV; £1 test-mode end-to-end payment verified.

**Blockers:**
- Live payments: CAFF Stripe account (`acct_1UUS7nIatQExHTBt`) needs owner verification in Stripe.
- Migration `202610250002` not applied; related UI changes uncommitted and undeployed.

**Risks:** 13 commits not pushed to GitHub; Lambda deployed from uncommitted code; no password reset; AWS CLI on root credentials; Supabase Free pause risk.

**Verification:** 45/45 tests, tsc, lint, build pass (2026-10-25, new folder). Live redirects, owner sign-in and test payment verified on production.

**Next three actions:**
1. Commit working tree; apply migration 002; deploy site (~15 min).
2. Owner completes Stripe account verification (owner, ~15 min).
3. Create live key + live webhook, store under `/caff/payments-live/`, switch stack and Payment settings to live after explicit approval (~30 min).
