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
