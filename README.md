# CAFF

Mobile-first football management for a casual local group. CAFF covers account approval, availability, fair Bibs/Non-Bibs generation, results, player ratings, MOTM voting, comments, player records and admin operations.

## Local setup

1. Copy `.env.example` to `.env.local` and add the Supabase project URL and anon key.
2. Apply the SQL files in `supabase/migrations/` in filename order using the Supabase SQL editor or Supabase CLI.
3. Run `npm install` and `npm run dev`.
4. The `202609240001` migration bootstraps the existing `anaymakwana@icloud.com` account as the protected Owner. It intentionally fails if that account does not exist; on a fresh installation, create the owner account before applying it. All subsequent accounts start as `PENDING` and can be approved in CAFF's Admin area.

## Security model

- PostgreSQL constraints enforce lifecycle values, rating range/half-steps, one rating per voter/player/match, one MOTM vote per voter/match, and unique attendance/team assignments.
- RLS gates every private table. Pending users can only read/update their own profile. Approved members see a deliberately narrow player view without email or role data.
- Ratings and MOTM voter identities are only readable by the voter and admins. Players use finalised aggregate views.
- Anonymous comment author IDs remain in the private table for moderation; the public view removes the author object.
- Rating and MOTM inserts verify attendance, participation, self-voting restrictions, match state and voting deadline in the database.
- Role/status changes use `manage_member`, which checks the persisted Owner/Admin flags and writes an access audit. Direct client changes are rejected by the privilege-escalation trigger. Only the Owner can grant or revoke Admin access.

## Account and feedback operations

The Help page accepts feedback and account deletion requests. Admins can review these in People & access. Deletion is not automated: the Owner must confirm the person's identity, decide how historical football data should be handled, remove their Supabase Auth user in the dashboard, then mark the request resolved. Do not promise erasure of match history without reviewing foreign keys and published records first.

The access audit records member status/role changes through `manage_member`. After `202609240003`, triggers also record match lifecycle/results, team edits, goal corrections, availability overrides and comment moderation. The log is admin-only and does not contain private vote identities or secrets.

After `202609240003`, profile photos are kept in a private Storage bucket. The browser requests one-hour signed URLs for approved members; links remain usable by anyone who receives them until they expire. Existing stored profile URLs remain in the database for path lookup, but their public endpoints no longer return the image.

The browser UI is an ergonomic layer, not the security boundary.

## Match lifecycle

`DRAFT → AVAILABILITY_OPEN → TEAMS_GENERATED → PLAYED → VOTING_OPEN → FINALISED`

`CANCELLED` is terminal and keeps the fixture in history without including it in stats.

For capped matches, `set_player_availability` serializes replies on the match row. Extra Playing responses join an ordered waiting list rather than overfilling the fixture. Admins can promote a queued player when a place becomes available. Uncapped matches do not use the queue. Apply `202609240002_waitlist.sql` before deploying a client that calls these functions.

## Team balancing

`lib/domain/team-generator.ts` uses an effective player strength based on 60% career rating and 40% recent form. A 6.0 prior is blended out over the first five eligible rated matches. The generator samples many splits, scores rating difference, positional distribution and goalkeeper coverage, then randomly picks from the best candidates. This keeps repeated generations fair without always producing an identical team sheet.

## Notifications

The migration includes per-player preferences and a provider-neutral `notification_outbox`. `202609240003` fans out new outbox events into private in-app alerts with unread counts and member preferences. No email vendor is hard-coded and email is not sent yet. A deployment worker/Edge Function should consume outbox events after a provider (for example Resend, Postmark or an existing club email service) is chosen.

## Future game date polls

Admins can open a poll with two to six proposed kick-off times, an optional venue and a closing time. Approved players can select every date they can attend and revise their choices until the poll closes. The app publishes totals without exposing voter identities to other players.

## Checks

```bash
npm run lint
npx tsc --noEmit
npm run build
```

The app intentionally uses system fonts, avoiding a network dependency during builds. The manifest and installable app icons use the supplied CAFF League artwork.

## Pitch bookings and payments

Admin → **Sessions & payments**. Create a session with its own pitch cost, add or import players, confirm attendance, then **Review & issue** payment requests. Each player gets a personal link (`/pay/?r=<request id>`) that opens Stripe-hosted Checkout. Players are marked paid only by a verified Stripe webhook, never by the browser redirect. Bank transfers and cash are recorded manually; corrections mark the original entry void rather than deleting it.

- **Money rules live in Postgres** (`supabase/migrations/202610250001_pitch_sessions_payments.sql`): integer pence, equal shares with leftover pennies spread deterministically, issued amounts snapshotted, a version check so an admin can only issue the numbers they reviewed, one payable request per player, and a confirmation step before any change that affects requested or paid amounts. All writes are `SECURITY DEFINER` functions that check permissions and write `admin_audit_log`.
- **Permissions:** the Owner has all of them. Existing Admins were given sessions, attendance, payment requests, finance view and manual payments. Refunds and payment settings stay Owner-only until granted in **Payment settings**.
- **Fees:** estimates use the configurable assumption (default 1.5% + 20p for each separate payment). The actual Stripe balance-transaction fee replaces the estimate when it is known. “Cover in price” raises the shared total so everyone pays the same price whatever the payment method; there is never a card surcharge.
- **Payments API:** `payments/handler.mjs`, one dependency-free Lambda (`infra/caff-payments.yaml`) behind the existing CloudFront distribution at `/api/*`. It uses the Stripe REST API, verifies webhook signatures, and reads its secrets from SSM Parameter Store.

### Setup (once, in this order)
1. Apply the migration in the Supabase SQL editor. It runs in one transaction and is additive only.
2. In SSM Parameter Store (us-east-1), create SecureString parameters `/caff/payments/STRIPE_SECRET_KEY` (start with `sk_test_…`), `/caff/payments/STRIPE_WEBHOOK_SECRET` and `/caff/payments/SUPABASE_SERVICE_ROLE_KEY`.
3. Run `scripts/deploy-payments.sh`, then update the site stack with `PaymentsApiDomain=<FunctionUrlDomain output>` (all other parameters unchanged), and run `scripts/deploy-aws.sh caff-site`.
4. In Stripe (test mode first), go to Developers → Webhooks → Add endpoint `https://caff.anaysprojects.com/api/stripe/webhook` with these events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `payment_intent.payment_failed`, `charge.updated`, `charge.dispute.created`, `refund.created`, `refund.updated`, `refund.failed`. Put its signing secret in step 2's parameter.
5. To go live, replace both Stripe parameters with live values and add a live-mode webhook endpoint. Then, as Owner, switch **Payment settings → Stripe mode** to Live. Events from the other mode are ignored. Secrets are cached for up to five minutes.

### Local end-to-end harness
`tests/e2e/mock-server.mjs` serves the static build with a Supabase stand-in (PGlite running the real migration), the real payments handler and a fake Stripe that sends signed webhooks. Build with `NEXT_PUBLIC_SUPABASE_URL=http://localhost:4310/sb NEXT_PUBLIC_SUPABASE_ANON_KEY=anon npm run build`, run `node --experimental-strip-types tests/e2e/mock-server.mjs`, and sign in as `owner@caff.test` with any password. Rebuild normally before deploying.
