# Changelog

Dates are 2026 unless noted. "Deployed" only where there is evidence (stack update, invalidation id or live check).

## 25 Oct (late evening): release: banner fix + mobile polish deployed (`70f2406`)
- Pre-deploy: remaining pages audited on the harness (admin match open/final, match open/final, teams→matches, 6 phones + landscape + desktop): fixed matches-list overflow at 320/360px (Availability open pill widened cards; layout viewport 374px). Availability buttons exercised at 375px (Playing/Maybe/Can't make it/Watching: selection, pill, notice; 143×70px). Harness: open match + `set_player_availability` stand-in. Player profile pages crash only in the harness (mock `.single()` returns []), so checked on production instead: own and another player's profile and the real match page at 623px (Chrome minimum), no overflow, no errors.
- Deployed with `scripts/deploy-aws.sh caff-site` (tests 48/48, lint, build), invalidation `I7ABWNZ2NATT4VI5YXB6VI7XGT` completed. Verified: /, /auth/, /dashboard/, /pay/, /privacy/, session view 200; www 301; live CSS has the new rules; production at iPhone 375 (built-in browser): pay page for the real £0.30 request shows Paid pill, no deadline, dashboard button, no overflow; sign-in and sign-up forms 16px inputs, correct autocomplete. Payments unchanged: Lambda live `/caff/payments-live/` (stack last updated 19:45, before this work), Owner health ready=true, Payment settings Live. No payments, requests or data created.

## 25 Oct (late evening): mobile-first audit and polish (not deployed)
- Found (local harness, headless Chrome, iPhone 320/375/390/430, Android 360/412, landscape 844, desktop 1280): admin session page widened the layout viewport to 956px on every phone (absolutely positioned sr-only table headers escaped `.table-wrap`), 1160px/921px tables in a 278px card, form controls at 13px (iOS zoom on focus), Help/Sign out 30px tall at 11.5px, 🔔 link 25px wide, nav labels 10px, sign-in form below the fold, pay-page pill unreadable on the dark panel, deadline shown after payment, long session names truncated on the player card, desktop attendance table clipped by a long guest name.
- Fixed: `.table-wrap` positioned; `stack-table` labelled cards ≤720px (attendance, requests, payments, permissions); 16px controls; 44px targets; compact mobile sign-in intro; pay page Due/Processing/Paid/Failed pill (`payStatus`), Check again after the poll window, "Go to your CAFF dashboard"; viewport-fit cover + safe-area padding; 128px logo (75KB → 37KB per page). Harness now loads migration 002; added `tests/e2e/seed-session.mjs` and `tests/e2e/mobile-audit.mjs`.
- Verified: 129 page/device checks with 0 overflow, 0 undersized targets, 0 inputs <16px, 0 console errors/failed requests; full player journey (dashboard → Due → fake Checkout → Processing → Paid → dashboard Paid) at 375px. Tests 48/48, tsc, lint, production build. Production payments still live; no production data touched.

## 25 Oct (late evening): test-session banner wording
- Banner now states whether a test session holds real live card payments, test-mode payments, or none (links still charge in the current mode). `testSessionNote` + test. Tests 47/47, tsc, lint, build. Not deployed.

## 25 Oct (late evening): first real live payment verified
- Stripe GBP minimum is £0.30 (docs.stripe.com/currencies; CAFF enforces the same), so 30p not 10p. Owner-only session `2fd336a8…` (marked test) via the normal admin flow; one request `4acfc36d…` £0.30.
- Owner paid with their own card. Verified: Checkout complete/paid (`cs_live_a1Msm…`), PI `pi_3UUXWzIatQExHTBt0BWT0X63` succeeded, fee 20p, net 10p; webhooks completed → paid, charge.updated → fee_recorded (0 failed); CAFF request PAID once, one payment, owes £0.00; audit trail complete. Not refunded. No code or deploy changes.
- Found: test-session banner copy wrongly says such payments are test-mode money (follow-up).

## 25 Oct (late evening): LIVE payments enabled (owner approved)
- Stack `caff-payments` → StripeMode live, SecretsPath `/caff/payments-live/` (change set). Payment settings → Stripe mode Live (Owner session; audit-logged).
- Verified: Owner health ready=true (live/live, rk_, livemode true, DB ok); live signed webhook processed (`checkout_expired`, unlinked expired session, no charge); payments/requests unchanged. No real charge made; no site deploy.

## 25 Oct (late evening): live payments prepared and verified (not enabled)
- Stripe live (same `acct_1UUS7nIatQExHTBt`): live webhook `we_1UUVFrIatQExHTBtmOb48ulj` (10 events) and restricted key `caff-payments-lambda-live` (4 permissions; extra endpoints 403). Owner passed Stripe's email link + authenticator check and pasted the two Stripe values into AWS; the Supabase key was copied SSM-to-SSM without display.
- SSM: `/caff/payments-live/{STRIPE_SECRET_KEY,STRIPE_WEBHOOK_SECRET,SUPABASE_SERVICE_ROLE_KEY}` (SecureString).
- Stack `caff-payments` switched to live by change set, Owner health check ready=true in live; live webhook signature proven with an immediately-expired unlinked £1 Checkout Session (no charge): delivered, recorded `ignored_mode_mismatch` (DB test). Rolled back to test by change set: ready=true, forged webhook 400. Payment settings stayed test throughout. Tests 46/46. No site deploy.

## 25 Oct (evening): Stripe activation progressed; live tooling (`cd06818`)
- Stripe (CAFF sandbox flow): website, description, "Accept online payments" only (Stripe Tax unticked to avoid extra fees), dashboard setup. Stopped at Activate Payments → Business type (owner-only declarations, identity, bank).
- Payments Lambda: Owner-only `POST /api/admin/health` (mode, key type, Stripe/DB reachability, readiness; no secret values). Tests 12/12. Deployed (code 16:26 UTC, stack unchanged, test mode). Verified live: ready=true in test, anon 401.
- `scripts/go-live.sh live|test`: checks live SecureStrings exist, change set with confirmation. Not run.

## 25 Oct (evening): Stripe live status re-checked
- Owner reported verification complete; dashboard shows otherwise: CAFF still sandbox-only, "Get live account" pending (email verified only). Clarified that `acct_1UUS7nIatQExHTBt` is the CAFF sandbox. No keys, webhooks, AWS parameters or payment settings changed.

## 25 Oct: launch verification, card fix, pushed to GitHub
- Pushed `pitch-payments` to origin (16 commits; secret scan clean). `main` untouched.
- Real-session launch check on production (session `a35c7165-…`, owner only): card amounts verified through cash part-payment and reissue; then voided, cancelled and marked test (records kept).
- Fixed: the card offered the stale full amount after a part-payment (server already blocked it); manual payments show date only. `tsconfig` incremental off (iCloud stall). Tests 45/45, tsc, lint, build. Deployed (invalidation `IE3N8DN2E77WQ4P6DF5WENPILD`).
- Production security probes passed (webhook signatures, pay-link validation, paid-request 409, admin 401, anon 42501). Mobile sign-up verified.
- Stripe live: account still unverified; no live keys, webhook or settings changed.

## 25 Oct: migration 202610250002 applied; site deployed from ~/Documents/ChatGPT/CAFF
- Committed `83695b9` (launch prep + handover docs) and `27d21d6` (rollback for 002, PGlite-verified to restore exactly).
- Applied 002 once via the Supabase SQL editor (SHA-256 `e608d81e…` matched). Verified: is_test column, test session flagged, 2 new functions, grants (authenticated yes, anon no), counts unchanged, stripe_mode test.
- Deployed site (tests 45/45, build) from the new folder; invalidation `IE6NV3RUDJHBQ5WHBA58IPN1EQ`. Verified live: test session hidden from Upcoming/All, listed under Test sessions with badge and banner, owner dashboard card empty (my_pitch_payments 200, 0 rows), How CAFF works on sign-in, redirects intact. Stripe stays in test mode.

## 25 Oct: local home and handover
- Project copied from `~/caff` to `~/Documents/ChatGPT/CAFF` (full Git history, uncommitted work, local config; node_modules reinstalled with `npm ci`). Original left in place pending approval. Tests 45/45, tsc, lint, build passed in the new folder.
- Added HANDOVER.md, PROJECT_STATUS.md, CHANGELOG.md, AGENTS.md, CLAUDE.md, docs/. Not committed.

## 25 Oct: launch preparation (committed later as `83695b9`)
- Migration `202610250002` (test-session flag, player payment history) written and tested on PGlite (17/17 SQL tests). **Not applied.**
- Auth page "how it works" and sign-up → /pending redirect; dashboard pitch-payments card; Test sessions filter/badge/banner. **Not deployed.**
- Lambda refuses keys whose mode differs from `STRIPE_MODE`; stack parameter `StripeMode` and `SecretsPath` pattern. **Deployed 14:31 UTC from uncommitted code** (tests 11/11).

## 25 Oct: Stripe test mode live
- Separate Stripe account CAFF `acct_1UUS7nIatQExHTBt`; test webhook `we_1UUSB2IatQExHTBtwygzOXv4`; restricted test key; Supabase secret key `caff_payments_lambda`; three SSM SecureStrings under `/caff/payments/`.
- Stack `caff-payments` created; `/api/*` routed via CloudFront (`PaymentsApiDomain`); site built with `NEXT_PUBLIC_PITCH_SESSIONS=on` and deployed (invalidation `IF1KM8WC7UYANMAGCT28ALMA68`).
- Verified: £1.00 test checkout → signed webhook → request PAID, actual fee 23p, net 77p.

## 25 Oct: migration 202610250001 applied (production)
- Applied via Supabase SQL editor after SHA-256 check; verified 9 tables with RLS, functions present, test mode, existing row counts unchanged (9 users/profiles, 1 match, 3 availability, 1 venue, 9 audit rows).

## 25 Oct: site release with payments UI gated (`6707a53`)
- Sessions UI behind `NEXT_PUBLIC_PITCH_SESSIONS`; verified rollback SQL; sb_ key header fix. Deployed (invalidation `I4DRTBTLSERKA2VJ0L90ZD4M8A`); /api absent at the time.

## 25 Oct: canonical domain (`2acc250`, `db94800`, `2e4f883`)
- caffleague.com primary (ACM cert, aliases, Route 53 records); every other host 301s to it; Vercel redirect repointed; Supabase Site URL + redirect URLs updated; robots/sitemap/canonical tags; duplicate-session guard. Deployed and verified (DNS, HTTPS, redirects, signed-in admin).

## 25 Oct: pitch payments system (`a19f720`)
- Sessions, cost split, payment requests, Stripe Checkout + webhook Lambda, manual payments, refunds, fees, permissions, audit, CSV; visual polish (logos, heading hierarchy, accessibility). Tests added (PGlite SQL, Lambda, domain, e2e harness).

## 21–22 Oct: AWS migration
- Static export to S3 + CloudFront (`374493c`), caff.anaysprojects.com, Vercel redirect project (`993537b`), explicit Data API grants (`69a034c`), health-check workflow prepared (`4d418b0`).

## Sep 2026 and earlier
- Launch-ready app, membership security, player experience, private avatars, notifications, admin audit (`9b529e2` … `9e07e4b`).
