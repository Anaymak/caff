# Database and migrations

Supabase project `vkdsdgiecuvviaukrafa` ("CAFF Production", Free plan). Migrations are in `supabase/migrations/`, applied in filename order through the Supabase SQL editor. There is no migration-tracking table, so record every application in `CHANGELOG.md`.

| Migration | Status |
|---|---|
| 202609230001_caff_foundation … 202610210001_explicit_table_grants | applied before Oct 2026 [V: objects exist] |
| 202610250001_pitch_sessions_payments | applied 2026-10-25 [V] (rollback in `supabase/rollback/`) |
| 202610250002_test_sessions_player_history | **not applied** |

## Payment schema (202610250001)
- `pitch_sessions`: one booking with its own `pitch_cost_pence`, `fee_mode` (ABSORB / COVER_IN_PRICE), status and `calc_version` (bumped on price or chargeable-attendance changes). Migration 002 adds `is_test`.
- `session_attendees`: a member (`profile_id`) or guest; attendance CONFIRMED / UNCONFIRMED / CANCELLED; `chargeable`.
- `payment_requests`: issued amount plus a `calculation` snapshot. Status PENDING / FAILED / PAID / MANUALLY_PAID / REFUNDED / CANCELLED / SUPERSEDED. A partial unique index allows only one payable request per attendee. The request UUID doubles as the pay-link token.
- `payment_request_checkouts`: one row per Stripe Checkout attempt (reserved before Stripe is called).
- `payments`: money received (STRIPE / BANK_TRANSFER / CASH / OTHER). Unique Stripe PaymentIntent and Checkout ids, `client_token` for idempotent manual entries, VOID with a reason instead of deletes, estimated and actual fees.
- `payment_refunds`: STRIPE or MANUAL refunds.
- `stripe_events`: processed event ids (replay protection), stored without personal data.
- `payment_settings`: single row holding the fee assumptions and `stripe_mode`.
- `admin_permissions`: per-admin finance permissions.
- Key functions: `session_shares` / `session_balances` / `session_totals` (internal); admin functions `create_pitch_session`, `update_pitch_session`, `add_session_attendee`, `issue_payment_requests`, `record_manual_payment`, `void_manual_payment`, `refund_begin`, `get_pitch_session(s)`; service-role functions `checkout_prepare`, `checkout_attach`, `stripe_apply_event`, `refund_attach`, `payment_set_actual_fee`.
- Browser roles have SELECT only (RLS-filtered); all writes go through these functions, which write `admin_audit_log`.

## Testing migrations
`tests/payments-sql.test.mjs` runs both payment migrations on PGlite, with a stub of the Supabase objects they depend on.
