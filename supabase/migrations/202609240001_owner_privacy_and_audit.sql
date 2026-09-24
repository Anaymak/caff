-- Keep the existing ADMIN role for the owner so older clients remain usable.
-- is_owner is the persisted third authority level; the email is used only here.
alter table public.profiles add column if not exists is_owner boolean not null default false;
alter table public.profiles add column if not exists goalkeeper_willing boolean not null default false;
create unique index if not exists one_caff_owner on public.profiles (is_owner) where is_owner;

do $$
declare owner_id uuid;
begin
  select id into owner_id from auth.users where lower(email) = 'anaymakwana@icloud.com';
  if owner_id is null then raise exception 'CAFF owner account is missing'; end if;
  update public.profiles set is_owner = true, role = 'ADMIN', status = 'APPROVED'
  where id = owner_id;
end $$;

create or replace function public.is_owner() returns boolean language sql stable security definer
set search_path = public as $$
  select exists (select 1 from public.profiles
    where id = auth.uid() and is_owner and role = 'ADMIN' and status = 'APPROVED')
$$;
create or replace function public.is_admin() returns boolean language sql stable security definer
set search_path = public as $$
  select exists (select 1 from public.profiles
    where id = auth.uid() and role = 'ADMIN' and status = 'APPROVED')
$$;
grant execute on function public.is_owner() to authenticated;

-- Admins remain ordinary players for voting and discussion eligibility.
create or replace function public.is_match_attendee(mid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_approved() and exists (
    select 1 from public.match_availability
    where match_id = mid and player_id = auth.uid() and status in ('PLAYING','WATCHING'))
$$;

-- A client may edit football profile fields but never membership, role, owner or email.
-- Membership changes go through manage_member, whose owner is postgres.
create or replace function public.prevent_profile_privilege_escalation() returns trigger
language plpgsql security invoker set search_path = public as $$
begin
  if current_user <> 'postgres' then
    if new.role is distinct from old.role or new.status is distinct from old.status
       or new.is_owner is distinct from old.is_owner or new.email is distinct from old.email
       or new.created_at is distinct from old.created_at
       or (new.comment_restricted is distinct from old.comment_restricted and not public.is_admin()) then
      raise exception 'Account access can only be changed through CAFF account management';
    end if;
  end if;
  if old.is_owner and (not new.is_owner or new.role <> 'ADMIN' or new.status <> 'APPROVED') then
    raise exception 'The CAFF owner account cannot be removed or demoted';
  end if;
  return new;
end $$;

-- Private account rows are visible only to their owner and administrators.
drop policy if exists "profiles visible safely" on public.profiles;
create policy "profiles visible to self and admins" on public.profiles for select to authenticated
using (id = auth.uid() or public.is_admin());

-- The approved squad is exposed through a deliberately narrow view.
create or replace view public.public_player_profiles with (security_barrier = true) as
select id, full_name, nickname, avatar_url, bio, preferred_position,
  secondary_position, goalkeeper_willing
from public.profiles
where status = 'APPROVED' and public.is_approved();
grant select on public.public_player_profiles to authenticated;
revoke all on public.public_player_profiles from anon;

-- A suspended former member must not keep reading old private submissions.
drop policy if exists "voters read own ratings" on public.ratings;
create policy "approved voters read own ratings" on public.ratings for select to authenticated
using (public.is_approved() and (voter_id = auth.uid() or public.is_admin()));
drop policy if exists "admins audit ratings" on public.ratings;
create policy "admins audit ratings" on public.ratings for select to authenticated using (public.is_admin());
drop policy if exists "voters read own motm" on public.motm_votes;
create policy "approved voters read own motm" on public.motm_votes for select to authenticated
using (public.is_approved() and (voter_id = auth.uid() or public.is_admin()));
drop policy if exists "admins audit motm" on public.motm_votes;
create policy "admins audit motm" on public.motm_votes for select to authenticated using (public.is_admin());
drop policy if exists "authors read own comments" on public.comments;
create policy "approved authors read own comments" on public.comments for select to authenticated
using (public.is_approved() and (author_id = auth.uid() or public.is_admin()));

-- Existing aggregate views run with the view owner's privileges. Require an
-- approved account inside each view as well as granting only authenticated access.
create or replace view public.public_match_ratings with (security_barrier = true) as
select r.match_id, r.target_player_id as player_id,
  round(avg(r.score), 1) as average_rating, count(*)::int as rating_count
from public.ratings r join public.matches m on m.id = r.match_id
where m.status = 'FINALISED' and public.is_approved()
group by r.match_id, r.target_player_id having count(*) >= 3;

create or replace view public.public_motm_results with (security_barrier = true) as
select v.match_id, v.target_player_id as player_id, count(*)::int as votes
from public.motm_votes v join public.matches m on m.id = v.match_id
where m.status = 'FINALISED' and public.is_approved()
group by v.match_id, v.target_player_id;

create or replace view public.public_comments with (security_barrier = true) as
select c.id, c.match_id, c.target_player_id, c.body, c.anonymous, c.created_at,
  case when c.anonymous then null else
    jsonb_build_object('id', p.id, 'full_name', p.full_name, 'avatar_url', p.avatar_url)
  end as author
from public.comments c join public.profiles p on p.id = c.author_id
where c.deleted_at is null and not c.moderated and public.is_approved();

create or replace view public.player_stats with (security_barrier = true) as
with played as (
  select ta.player_id, m.id, m.starts_at, ta.side, m.bibs_score, m.non_bibs_score,
    case when m.bibs_score = m.non_bibs_score then 'D'
      when (ta.side = 'BIBS' and m.bibs_score > m.non_bibs_score)
        or (ta.side = 'NON_BIBS' and m.non_bibs_score > m.bibs_score) then 'W'
      else 'L' end result
  from public.team_assignments ta join public.matches m on m.id = ta.match_id
  where m.status = 'FINALISED'
), match_scores as (
  select match_id, player_id, average_rating,
    row_number() over (partition by player_id order by mt.starts_at desc) rn
  from public.public_match_ratings pr join public.matches mt on mt.id = pr.match_id
), motm_max as (
  select match_id, max(votes) votes from public.public_motm_results group by match_id
), motm as (
  select r.player_id, count(*)::int awards
  from public.public_motm_results r join motm_max x on x.match_id = r.match_id and x.votes = r.votes
  group by r.player_id
)
select p.id player_id, count(distinct pl.id)::int matches_played,
  count(distinct pl.id) filter (where pl.result = 'W')::int matches_won,
  count(distinct pl.id) filter (where pl.result = 'D')::int matches_drawn,
  count(distinct pl.id) filter (where pl.result = 'L')::int matches_lost,
  coalesce((select sum(g.quantity) from public.goals g join public.matches gm on gm.id = g.match_id
    where g.scorer_id = p.id and gm.status = 'FINALISED'), 0)::int goals,
  coalesce(mo.awards, 0)::int motm_awards,
  round(avg(ms.average_rating), 1) overall_rating,
  round(avg(ms.average_rating) filter (where ms.rn <= 5), 1) recent_form,
  max(ms.average_rating) highest_rating,
  round(100.0 * (select count(*) from public.match_availability ma
    join public.matches am on am.id = ma.match_id
    where ma.player_id = p.id and ma.status in ('PLAYING','WATCHING') and am.status = 'FINALISED')
    / nullif((select count(*) from public.matches fm where fm.status = 'FINALISED'), 0), 1)
    attendance_percentage
from public.profiles p left join played pl on pl.player_id = p.id
left join match_scores ms on ms.player_id = p.id
left join motm mo on mo.player_id = p.id
where p.status = 'APPROVED' and public.is_approved()
group by p.id, mo.awards;

create or replace view public.game_date_poll_counts with (security_barrier = true) as
select option_id, poll_id, count(*)::int as vote_count
from public.game_date_votes where public.is_approved()
group by option_id, poll_id;

drop policy if exists "eligible voters edit ratings" on public.ratings;
create policy "eligible voters edit ratings" on public.ratings for update to authenticated
using (voter_id = auth.uid() and exists (
  select 1 from public.matches m where m.id = match_id and m.status = 'VOTING_OPEN'
    and (m.voting_closes_at is null or now() <= m.voting_closes_at)))
with check (voter_id = auth.uid() and voter_id <> target_player_id
  and public.is_match_attendee(match_id) and public.is_match_player(match_id, target_player_id)
  and exists (select 1 from public.matches m where m.id = match_id and m.status = 'VOTING_OPEN'
    and (m.voting_closes_at is null or now() <= m.voting_closes_at)));

drop policy if exists "eligible voters edit motm" on public.motm_votes;
create policy "eligible voters edit motm" on public.motm_votes for update to authenticated
using (voter_id = auth.uid() and exists (
  select 1 from public.matches m where m.id = match_id and m.status = 'VOTING_OPEN'
    and (m.voting_closes_at is null or now() <= m.voting_closes_at)))
with check (voter_id = auth.uid() and voter_id <> target_player_id
  and public.is_match_attendee(match_id) and public.is_match_player(match_id, target_player_id)
  and exists (select 1 from public.matches m where m.id = match_id and m.status = 'VOTING_OPEN'
    and (m.voting_closes_at is null or now() <= m.voting_closes_at)));

create table if not exists public.admin_audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid references public.profiles(id) on delete set null,
  target_id uuid,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.admin_audit_log enable row level security;
drop policy if exists "admins view audit log" on public.admin_audit_log;
create policy "admins view audit log" on public.admin_audit_log for select to authenticated
using (public.is_admin());
revoke all on public.admin_audit_log from anon, authenticated;
grant select on public.admin_audit_log to authenticated;
create index if not exists admin_audit_recent_idx on public.admin_audit_log(created_at desc);

create or replace function public.manage_member(p_target uuid, p_action text)
returns void language plpgsql security definer set search_path = public as $$
declare actor uuid := auth.uid(); target public.profiles%rowtype;
begin
  if actor is null or not public.is_admin() then raise exception 'Admin access required'; end if;
  select * into target from public.profiles where id = p_target for update;
  if not found then raise exception 'Account not found'; end if;
  if target.is_owner then raise exception 'The CAFF owner account is protected'; end if;

  case p_action
    when 'APPROVE' then
      if target.status not in ('PENDING','REJECTED') then raise exception 'Account cannot be approved from its current state'; end if;
      update public.profiles set status = 'APPROVED' where id = p_target;
    when 'REJECT' then
      if target.status <> 'PENDING' then raise exception 'Only pending accounts can be rejected'; end if;
      update public.profiles set status = 'REJECTED' where id = p_target;
    when 'SUSPEND' then
      if target.status <> 'APPROVED' then raise exception 'Only approved accounts can be suspended'; end if;
      update public.profiles set status = 'SUSPENDED' where id = p_target;
    when 'REINSTATE' then
      if target.status <> 'SUSPENDED' then raise exception 'Only suspended accounts can be reinstated'; end if;
      update public.profiles set status = 'APPROVED' where id = p_target;
    when 'MAKE_ADMIN' then
      if not public.is_owner() then raise exception 'Only the owner can grant Admin access'; end if;
      if target.status <> 'APPROVED' or target.role <> 'PLAYER' then raise exception 'An approved player is required'; end if;
      update public.profiles set role = 'ADMIN' where id = p_target;
    when 'REMOVE_ADMIN' then
      if not public.is_owner() then raise exception 'Only the owner can revoke Admin access'; end if;
      if target.role <> 'ADMIN' then raise exception 'Account is not an Admin'; end if;
      update public.profiles set role = 'PLAYER' where id = p_target;
    else raise exception 'Unsupported account action';
  end case;
  insert into public.admin_audit_log(actor_id, target_id, action, details)
  values(actor, p_target, p_action, jsonb_build_object('previous_role', target.role,
    'previous_status', target.status));
end $$;
revoke all on function public.manage_member(uuid, text) from public, anon;
grant execute on function public.manage_member(uuid, text) to authenticated;

-- Clients cannot bypass manage_member with a direct profile update.
drop policy if exists "admins manage profiles" on public.profiles;
create policy "admins edit football profiles" on public.profiles for update to authenticated
using (public.is_admin()) with check (public.is_admin());

-- Public read grants are deliberately narrow; auth users still only see their
-- own raw votes, ratings and comments through their respective RLS policies.
grant select on public.public_match_ratings, public.public_motm_results,
  public.public_comments, public.player_stats, public.game_date_poll_counts to authenticated;

create table if not exists public.feedback_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  description text not null check (char_length(trim(description)) between 10 and 2000),
  route text not null check (char_length(route) <= 300),
  created_at timestamptz not null default now()
);
alter table public.feedback_reports enable row level security;
grant select, insert on public.feedback_reports to authenticated;
create policy "approved members send feedback" on public.feedback_reports for insert to authenticated
with check (reporter_id = auth.uid() and public.is_approved());
create policy "members view own feedback" on public.feedback_reports for select to authenticated
using (reporter_id = auth.uid() or public.is_admin());
create index if not exists feedback_reports_recent_idx on public.feedback_reports(created_at desc);

create table if not exists public.account_deletion_requests (
  player_id uuid primary key references public.profiles(id) on delete cascade,
  requested_at timestamptz not null default now(),
  resolved_at timestamptz
);
alter table public.account_deletion_requests enable row level security;
grant select, insert, update on public.account_deletion_requests to authenticated;
create policy "members request account deletion" on public.account_deletion_requests for insert to authenticated
with check (player_id = auth.uid() and not public.is_owner());
create policy "members and admins read deletion requests" on public.account_deletion_requests for select to authenticated
using (player_id = auth.uid() or public.is_admin());
create policy "admins resolve deletion requests" on public.account_deletion_requests for update to authenticated
using (public.is_admin()) with check (public.is_admin());
