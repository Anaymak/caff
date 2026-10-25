# Instructions for AI coding agents (Claude Code, Codex, others)

## Before starting any task
1. Read `HANDOVER.md`, `PROJECT_STATUS.md` and the relevant file in `docs/`.
2. Run `git status` and `git log --oneline -5`; read the actual code you will change. Trust code and live checks over notes.
3. Note any discrepancy between documentation and reality and fix the documentation as part of the task.

## Architecture in one paragraph
Next.js 16 static export (`output: 'export'`) served from S3 + CloudFront; all data via supabase-js under Postgres RLS; money logic in SECURITY DEFINER SQL functions; one dependency-free Lambda (`payments/handler.mjs`) behind CloudFront `/api/*` for Stripe Checkout and webhooks; secrets in SSM Parameter Store. No Next.js API routes or server components with runtime data: they will not exist in production.

## Conventions
- Match the surrounding style (compact React components, CSS in `app/globals.css`, no new UI libraries).
- Money is integer pence everywhere; never floats. Shared maths in `lib/domain/payments.ts` must match the SQL (tests compare).
- Database changes: new, additive, reviewed migration files in `supabase/migrations/` (timestamped, applied in order). Every new table: RLS + explicit grants (`supabase/MIGRATION_TEMPLATE.sql`). Write a rollback for anything non-trivial. Keep migration files ASCII-only (the SQL editor paste path mangles non-ASCII).
- Dynamic routes: prerender `_` + `useRouteId()`, or use `?id=` query pages.

## Tests (run before finishing)
`npm test` (node:test incl. PGlite migration tests), `npx tsc --noEmit`, `npm run lint`, `npm run build`. Add tests for new SQL/Lambda behaviour. Never claim a check passed without running it.

## Security and safety (non-negotiable)
- Never commit or write secrets (Stripe keys, webhook secrets, Supabase secret keys, tokens, passwords) into files, docs, logs or chat. `.env.local` is gitignored; values are never quoted.
- Never enable live Stripe, change `payment_settings.stripe_mode`, the stack's `StripeMode`/`SecretsPath`, or financial settings without the owner's explicit approval in that conversation.
- CAFF's Stripe account is `acct_1UUS7nIatQExHTBt`. Never use or modify MotorPortal HQ (Stripe, AWS, DNS) or other projects.
- Never delete financial, payment, audit or test records; correct via the provided void/refund/test-flag functions.
- Production SQL, deploys and infrastructure changes need explicit approval unless the owner pre-authorised that exact step. No deploy just to verify a refactor.
- Build deploys with `NEXT_PUBLIC_PITCH_SESSIONS=on` (in `.env.local`).

## Mandatory handover maintenance (every meaningful change)
After changing code, config, schema, infrastructure or deployment:
1. Update `HANDOVER.md` with the verified current state and any decisions (mark unverified items).
2. Add a dated entry to `CHANGELOG.md` (what, why, tests run with results, deploy status, commit hashes).
3. Update `PROJECT_STATUS.md` if status, blockers, risks or next steps changed.
4. Update `docs/` when architecture, infrastructure, schema, deployment or security changed.
5. Record unfinished work and the exact next action; if interrupted, leave docs so another agent can continue.
Before finishing: check docs match the implementation, list which docs you updated, never describe planned work as done, and confirm no secrets were written.
