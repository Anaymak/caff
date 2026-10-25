# CAFF handover (source of truth for any new AI session)

Last updated: 2026-10-25 (Claude Code session). Read this first, then `PROJECT_STATUS.md`, then the relevant file in `docs/`. Verify against `git status`, the code and live infrastructure before acting; this file can be wrong. Legend: **[V]** verified on the date shown, **[U]** unverified or assumed.

## 1. What CAFF is
A members-only web app for one casual football group in London ("CAFF League"). Players sign up, are approved by an admin, mark availability for games, get balanced Bibs/Non-Bibs teams, see results, rate players and vote MOTM. Admins run fixtures, people and (new) **pitch sessions**: split the pitch hire cost equally, send each player a Stripe payment link, record cash/bank payments and reconcile fees. Users: ~9 members, 2 admins (one is the Owner, anaymakwana@icloud.com). [V 2026-10-25: 9 auth users, 9 profiles, 2 admins]

## 2. Production status (2026-10-25)
- https://caffleague.com is live and the only canonical site. [V]
- Members, matches, availability, teams, ratings, polls, people/admin pages work signed in on caffleague.com. [V via owner's Chrome session]
- Pitch sessions & payments are **live in Stripe TEST mode** only. A £1.00 end-to-end test checkout succeeded: signed webhook received, the right player marked PAID, actual 23p fee recorded. [V]
- **Live payments are NOT enabled.** Blocker: the CAFF Stripe account must be verified by the owner in the Stripe dashboard ("Verify your business"). [V: dashboard shows "Next, verify your account"]
- Test-session labelling, player payment card, sign-up redirect and the live/test guard are committed and deployed; migration `202610250002` **applied 2026-10-25** [V].

## 3. Hosting and infrastructure (AWS account 971422695222, us-east-1)
- Static Next.js export on **S3 + CloudFront**, CloudFormation stack `caff-site` (`infra/caff-site.yaml`): bucket `caff-site-971422695222` (private, versioned), distribution `EGBP9DEUE6XFR` (`d2h2djtswdb4sj.cloudfront.net`), CloudFront Function `caff-static-routes` (source of truth `infra/viewer-request.js`, tests compare the two), response-headers policy `caff-security-headers` (HSTS, CSP, frame DENY). [V]
- Domain: `caffleague.com` (Route 53 zone `Z0113817247OYN829KD1P`, registered 25 Oct 2026 via Amazon Registrar). ACM certificate `34081bcd-…` covers caffleague.com, www.caffleague.com, caff.anaysprojects.com (expires 2027-05, auto-renews). [V]
- Redirects: the URL function 301s every host except `caffleague.com` (www, caff.anaysprojects.com, the cloudfront.net name) to `https://caffleague.com` with path + query. `caffleague.vercel.app` and `caff-ecru.vercel.app` are a redirect-only Vercel project `caff` (folder `vercel-redirect/`, 308 to caffleague.com). [V]
- Payments API: stack `caff-payments` (`infra/caff-payments.yaml`): Lambda `caff-payments` (Node 22, arm64, Function URL, no dependencies, code `payments/handler.mjs` uploaded as `index.mjs`), log group 30-day retention. CloudFront routes `/api/*` to it (site-stack parameter `PaymentsApiDomain`). Parameters: `StripeMode=test`, `SecretsPath=/caff/payments/`. [V]
- Secrets: SSM Parameter Store SecureStrings `/caff/payments/STRIPE_SECRET_KEY` (CAFF test restricted key), `/caff/payments/STRIPE_WEBHOOK_SECRET` (CAFF test webhook), `/caff/payments/SUPABASE_SERVICE_ROLE_KEY` (Supabase secret key `caff_payments_lambda`). Values never in Git or docs. [V names only]
- Cost: everything within free tiers; expected extra cost ~£0/month. [U: based on usage, not a bill]
Details: `docs/deployment.md`.

## 4. Database (Supabase project `vkdsdgiecuvviaukrafa`, "CAFF Production", Free plan)
- Postgres with RLS on every table; the browser talks to it directly with the publishable key. Core tables: profiles, venues, matches, match_availability, team_assignments, ratings, motm_votes, comments, goals, game_date_*, notifications, admin_audit_log, feedback_reports, account_deletion_requests.
- Payments tables (migration `202610250001`, **applied 2026-10-25** [V]): admin_permissions, payment_settings, pitch_sessions, session_attendees, payment_requests, payment_request_checkouts, payments, payment_refunds, stripe_events. All writes go through SECURITY DEFINER functions; the browser has SELECT only (RLS-filtered).
- Rollback for 001: `supabase/rollback/202610250001_pitch_sessions_payments_down.sql` (removes only payment objects; verified on PGlite, not run in production).
- Migration `202610250002_test_sessions_player_history.sql`: **applied 2026-10-25** (checksum-verified; rollback `supabase/rollback/202610250002_..._down.sql`, verified on PGlite) [V]. Adds `pitch_sessions.is_test`, marks session `68e3f37d-…` as test, `set_pitch_session_test`, `my_pitch_payments`, and replaces `get_pitch_sessions` / `my_payment_requests` to hide test sessions.
- Supabase Free projects pause after ~7 days without activity; a daily health-check workflow exists on GitHub `main` [U: whether it is running].
Details: `docs/database.md`.

## 5. Auth, registration, roles
- Supabase Auth, Email provider only; sign-ups ON; "Confirm email" OFF (new users are signed in immediately and land on /pending); anonymous sign-ins and manual linking OFF. Site URL `https://caffleague.com`; redirect allow-list: localhost:3000, cloudfront.net, both vercel.app, caff.anaysprojects.com, caffleague.com, www.caffleague.com. [V 2026-10-25]
- New accounts are `PENDING`; an admin approves on Admin / People & access (`manage_member` RPC, audited). Roles: PLAYER, ADMIN; `is_owner` = Owner. Only the Owner grants/revokes Admin.
- Finance permissions (table `admin_permissions`): sessions.manage, attendance.manage, payments.request, finance.view, payments.record_manual, payments.refund, settings.manage. Owner has all. The other existing admin has the first five; refunds and settings are Owner-only. Only the Owner can switch Stripe test/live in Payment settings. [V seeded count]
- No password-reset flow exists (known gap).

## 6. Pitch sessions workflow
Admin → Sessions & payments: create session (name, date/time, duration, venue/pitch, pitch cost per session, fee mode, deadline, notes, status PLANNING/OPEN/CONFIRMED/COMPLETED/CANCELLED) → add members/guests or import a match's Playing list → shares are computed in integer pence (equal split, leftover pennies on a per-session hash order) → "Review & issue" creates one request per player (version-guarded; changes after issue need confirmation, old amounts are never rewritten) → copy each player's link `/pay/?r=<request id>` → Stripe Checkout → webhook marks PAID. Manual cash/bank entries, void-with-reason corrections, manual and Stripe refunds, CSV export, audit history. Players see their open requests on the dashboard (with 002: a "Pitch payments" card with share/paid/owed). Players do **not** self-confirm pitch attendance; they mark match availability and admins add/import them.

## 7. Stripe
- CAFF uses its **own separate Stripe account "CAFF" (UK)**. `acct_1UUS7nIatQExHTBt` is that account's **sandbox** (shown as "Test mode", with "Exit sandbox" in the account menu); every test key and webhook lives there. **No live CAFF account exists yet** [V 2026-10-25 evening]: Stripe shows "Get your live account to exit sandbox. We need to verify some information about you and your business" with a "Get live account" button; the setup guide has Verify email ✓, Activate products ✗, Create your Stripe profile ✗. The live account will have its own `acct_` id, which must be recorded here when it exists. **Never use MotorPortal HQ (`acct_1UCn8RIbvHqmbRtL`)** for anything CAFF. [V]
- Test webhook `we_1UUSB2IatQExHTBtwygzOXv4` → `https://caffleague.com/api/stripe/webhook`, snapshot payloads, 10 events (checkout.session.completed / async_payment_succeeded / async_payment_failed / expired, payment_intent.payment_failed, charge.updated, charge.dispute.created, refund.created / updated / failed). Restricted key `caff-payments-lambda`: Checkout Sessions write, Charges and Refunds write, Payment Intents read, Balance read. [V]
- Safety: signature verification (manual HMAC, 5-min tolerance), idempotent event table, amount from DB only, checkout tied to request via our own checkout table + metadata, redirect never marks paid, one payable request per player, duplicate payment guarded by unique PaymentIntent id, overpay links paused until reissue. Mode isolation: Lambda refuses keys whose mode differs from `STRIPE_MODE`; DB ignores events whose livemode differs from `payment_settings.stripe_mode` (Owner-only switch). Live launch procedure: `docs/payments-security.md`.

## 8. Environment variables (names only)
Site build (`.env.local`, gitignored, public values): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (publishable `sb_publishable_…`), `NEXT_PUBLIC_PITCH_SESSIONS=on` (shows sessions/payments UI; must be set for deploys), optional `NEXT_PUBLIC_PAYMENTS_API_BASE` (local dev only). `.env.local` also contains a legacy `VERCEL_OIDC_TOKEN` (unused by AWS deploys).
Lambda env: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SITE_URL`, `SECRETS_PATH`, `STRIPE_MODE`. Lambda secrets from SSM: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`.

## 9. Repository layout
`app/` Next.js pages (static export; dynamic `[id]` pages prerendered as `_`; sessions detail uses `?id=`) · `components/` · `lib/domain/payments.ts` (pence maths mirrored from SQL) · `lib/payments-api.ts` · `payments/handler.mjs` (Lambda) · `infra/` (CloudFormation + CloudFront function) · `supabase/migrations/` (apply in filename order) · `supabase/rollback/` · `scripts/deploy-aws.sh` (site), `scripts/deploy-payments.sh` (Lambda) · `tests/` (node:test; `payments-sql` runs migrations on PGlite) · `tests/e2e/mock-server.mjs` (local harness: PGlite + fake Stripe) · `vercel-redirect/` (redirect-only Vercel project).

## 10. Git and deployment state (2026-10-25)
- Local home: `~/Documents/ChatGPT/CAFF` (copied from `~/caff` on 2026-10-25 with full history; `~/caff` still exists, awaiting the owner's approval to remove). Remote `github.com/Anaymak/caff`.
- Branch `pitch-payments` (latest commits `83695b9`, `27d21d6`, plus the docs commit after them) is the deployed line; it contains `aws-static` and `caffleague-domain`. **13 commits are not pushed to GitHub**; local `main` is 1 ahead/1 behind `origin/main`.
- All commits pushed to GitHub branch `origin/pitch-payments` (2026-10-25). `main` on GitHub is unchanged and older; merging is the owner's decision.
- Deployed: latest site from the commit "Payment card shows the owed amount…" (invalidation `IE3N8DN2E77WQ4P6DF5WENPILD`); earlier from `27d21d6` (+ `NEXT_PUBLIC_PITCH_SESSIONS=on`), from `~/Documents/ChatGPT/CAFF`, 2026-10-25, invalidation `IE6NV3RUDJHBQ5WHBA58IPN1EQ`. Lambda/stack `caff-payments` match `83695b9` (deployed 14:31 UTC before that commit, code unchanged since).
- Stale: a prunable worktree for `keepalive-workflow` under /private/tmp.

## 11. Key decisions (why)
- Static S3/CloudFront instead of Vercel: cost and no server code needed; only Stripe needs a server, so one dependency-free Lambda behind the same CloudFront origin (no CORS/CSP changes).
- Money logic in Postgres functions: transactions, row locks and constraints in one place; the Lambda only talks to Stripe and passes verified facts.
- Secrets in SSM (not CloudFormation parameters/env) so values never pass through CLI args or templates.
- Separate Stripe account for CAFF; no organisation shared with MotorPortal.
- Fees absorbed by default; optional "cover in price" mode raises the shared total for everyone (no card surcharge; UK rules).
- Test session kept (financial/audit records are never deleted), labelled `is_test` and hidden from normal views.

## 12. Changes completed: see `CHANGELOG.md`.

## 13. Known issues, risks, gaps
1. 13 unpushed commits: GitHub is not a full backup. Owner decision to push.
2. Production now has two sessions, both `is_test`: the Stripe test session and `a35c7165-…` "LAUNCH CHECK - player card (owner only)" (created 2026-10-25 to verify the player card on a real session, then voided, cancelled and marked test). No real sessions yet.
4. `~/Documents` is in iCloud Drive (Optimize Mac Storage on). TypeScript's incremental cache write hung there, so `tsconfig.json` now has `incremental: false`. Keep `node_modules`, `.next` and `out` regenerable; if builds stall, check iCloud.
3. Two Supabase SQL-editor tabs in the owner's Chrome hold unsaved placeholder text (safe to discard).
4. Live Stripe blocked on account verification (owner only).
5. No password reset; no admin notification of new sign-ups (admins check the Admin page).
6. "Confirm email" off: anyone can create a pending account (approval still gates access).
7. AWS CLI session uses root credentials (works, but an IAM admin user would be safer).
8. Supabase "default" secret key still exists alongside `caff_payments_lambda`; redirect allow-list keeps legacy hosts.
9. Supabase Free pausing risk [U whether keep-alive runs].

## 14. Production safety rules
Never: enable live Stripe or switch payment mode without the owner's explicit approval; touch MotorPortal HQ (Stripe, AWS, DNS); delete financial/audit rows; run production SQL without review; put secrets in files/commits/chat; remove caff.anaysprojects.com records; deploy unrelated projects. Always: migrations additive and reviewed, applied in filename order; build with `NEXT_PUBLIC_PITCH_SESSIONS=on`; verify after deploy.

## 15. Verification commands
```
npm ci && npm test && npx tsc --noEmit && npm run lint && npm run build
scripts/deploy-aws.sh caff-site        # site (runs tests/lint/build, syncs S3, invalidates)
scripts/deploy-payments.sh             # Lambda + stack (test mode)
curl -sI https://www.caffleague.com/   # expect 301 to https://caffleague.com/
curl -s "https://caffleague.com/api/pay/request?id=00000000-0000-4000-8000-000000000000"  # expect 400 not found
```
Local end-to-end without production: see README "Local end-to-end harness".

## 16. Next recommended task (≈15 minutes of owner time, then ≈30 minutes agent)
Owner: verify the CAFF Stripe account ("Verify your business" in the Stripe dashboard). Then, with explicit approval, follow the live launch procedure in `docs/payments-security.md`. Optionally first: invite one real player to sign up, approve them, add them to a real session and check their dashboard card (≈10 min).

## 17. Last verified state (2026-10-25)
Launch check (real, non-test session, owner as the only player): the card showed £3.00 owed with a Pay £3.00 link. After £1 cash it showed paid £1.00; the stale £3 link stayed blocked server-side (bug found: the card still offered Pay £3.00, fixed and deployed). An admin reissue (confirmation required) replaced it with £2.00 and the card showed Pay £2.00. Then: payment voided with a reason (kept), request cancelled, session marked test. The audit trail has every step. Production probes: unsigned, forged and expired webhook signatures return 400; a bad pay id returns 400; a paid request's checkout returns 409; admin endpoints without a JWT return 401; anon cannot call finance RPCs or read payment tables (42501). Mobile sign-up page renders without overflow. Stripe account `acct_1UUS7nIatQExHTBt` is still unverified (dashboard: "Verify your business", "Verify your email"); live mode unavailable.
Migration 002 verified in production: is_test column (boolean, default false), test session flagged, both new functions present, authenticated may execute and anon may not, counts unchanged (1 session, 1 payment, 1 request, 12 audit, 9 profiles, 1 match), stripe_mode test. Live checks: admin Sessions page hides the test session from Upcoming/All and shows it under Test sessions with a badge; session page shows the test banner and keeps its records; owner dashboard shows no pitch card (only a test session) and `my_pitch_payments` returns 200 with 0 rows; sign-in page shows How CAFF works; www/caff.anaysprojects.com/vercel.app redirect to caffleague.com.
Earlier: 45/45 automated tests, typecheck, lint, production build in `~/Documents/ChatGPT/CAFF`; live redirects/HTTPS for all five hostnames; owner sign-in and admin pages on caffleague.com; £1 Stripe test checkout → webhook → PAID with actual fee. Unverified: a real new-player sign-up and approval on production, the second admin's view, Supabase keep-alive, any live-mode behaviour.
