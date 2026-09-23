# CAFF

Mobile-first football management for a casual local group. CAFF covers account approval, availability, fair Bibs/Non-Bibs generation, results, player ratings, MOTM voting, comments, player records and admin operations.

## Local setup

1. Copy `.env.example` to `.env.local` and add the Supabase project URL and anon key.
2. Apply the SQL files in `supabase/migrations/` in filename order using the Supabase SQL editor or Supabase CLI.
3. Run `npm install` and `npm run dev`.
4. Sign up once, then bootstrap the first admin in the SQL editor:

```sql
update public.profiles
set role = 'ADMIN', status = 'APPROVED'
where email = 'your@email.com';
```

All subsequent accounts start as `PENDING` and can be approved in CAFF's Admin area.

## Security model

- PostgreSQL constraints enforce lifecycle values, rating range/half-steps, one rating per voter/player/match, one MOTM vote per voter/match, and unique attendance/team assignments.
- RLS gates every private table. Pending users can only read/update their own profile.
- Ratings and MOTM voter identities are only readable by the voter and admins. Players use finalised aggregate views.
- Anonymous comment author IDs remain in the private table for moderation; the public view removes the author object.
- Rating and MOTM inserts verify attendance, participation, self-voting restrictions, match state and voting deadline in the database.
- Role/status changes are protected by both admin RLS and a privilege-escalation trigger.

The browser UI is an ergonomic layer, not the security boundary.

## Match lifecycle

`DRAFT → AVAILABILITY_OPEN → TEAMS_GENERATED → PLAYED → VOTING_OPEN → FINALISED`

`CANCELLED` is terminal and keeps the fixture in history without including it in stats.

## Team balancing

`lib/domain/team-generator.ts` uses an effective player strength based on 60% career rating and 40% recent form. A 6.0 prior is blended out over the first five eligible rated matches. The generator samples many splits, scores rating difference, positional distribution and goalkeeper coverage, then randomly picks from the best candidates. This keeps repeated generations fair without always producing an identical team sheet.

## Notifications

The migration includes per-player preferences and a provider-neutral `notification_outbox`. No email vendor is hard-coded. A deployment worker/Edge Function should consume outbox events after a provider (for example Resend, Postmark or an existing club email service) is chosen.

## Future game date polls

Admins can open a poll with two to six proposed kick-off times, an optional venue and a closing time. Approved players can select every date they can attend and revise their choices until the poll closes. The app publishes totals without exposing voter identities to other players.

## Checks

```bash
npm run lint
npx tsc --noEmit
npm run build
```

The app intentionally uses system fonts, avoiding a network dependency during builds. The manifest and installable app icons use the supplied CAFF League artwork.
