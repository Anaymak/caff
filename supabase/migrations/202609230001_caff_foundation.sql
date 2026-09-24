-- CAFF production foundation. Existing prototype tables are preserved as *_legacy
-- when their shape is incompatible with this normalized schema.
create extension if not exists pgcrypto;

do $$ begin create type public.user_role as enum ('ADMIN','PLAYER'); exception when duplicate_object then null; end $$;
do $$ begin create type public.account_status as enum ('PENDING','APPROVED','REJECTED','SUSPENDED'); exception when duplicate_object then null; end $$;
do $$ begin create type public.player_position as enum ('GOALKEEPER','DEFENDER','MIDFIELDER','ATTACKER'); exception when duplicate_object then null; end $$;
do $$ begin create type public.match_status as enum ('DRAFT','AVAILABILITY_OPEN','TEAMS_GENERATED','PLAYED','VOTING_OPEN','FINALISED','CANCELLED'); exception when duplicate_object then null; end $$;
do $$ begin create type public.availability_status as enum ('PLAYING','WATCHING','MAYBE','NOT_ATTENDING'); exception when duplicate_object then null; end $$;
do $$ begin create type public.team_side as enum ('BIBS','NON_BIBS'); exception when duplicate_object then null; end $$;
do $$ begin create type public.notification_event as enum ('MATCH_CREATED','AVAILABILITY_REMINDER','TEAMS_GENERATED','MATCH_CANCELLED','VOTING_OPENED','VOTING_REMINDER','MATCH_FINALISED'); exception when duplicate_object then null; end $$;

-- Preserve incompatible proof-of-concept data instead of deleting it.
do $$ begin
  if to_regclass('public.teams') is not null and not exists (select 1 from information_schema.columns where table_schema='public' and table_name='teams' and column_name='match_id') then
    alter table public.teams rename to teams_legacy;
  end if;
  if to_regclass('public.ratings') is not null and not exists (select 1 from information_schema.columns where table_schema='public' and table_name='ratings' and column_name='voter_id') then
    alter table public.ratings rename to ratings_legacy;
  end if;
end $$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text not null default 'New player',
  nickname text,
  avatar_url text,
  bio text check (char_length(bio) <= 300),
  preferred_position public.player_position,
  secondary_position public.player_position,
  role public.user_role not null default 'PLAYER',
  status public.account_status not null default 'PENDING',
  comment_restricted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.profiles add column if not exists full_name text not null default 'New player';
alter table public.profiles add column if not exists nickname text;
alter table public.profiles add column if not exists bio text;
alter table public.profiles add column if not exists preferred_position public.player_position;
alter table public.profiles add column if not exists secondary_position public.player_position;
alter table public.profiles add column if not exists role public.user_role not null default 'PLAYER';
alter table public.profiles add column if not exists status public.account_status not null default 'PENDING';
alter table public.profiles add column if not exists comment_restricted boolean not null default false;
alter table public.profiles add column if not exists created_at timestamptz not null default now();
alter table public.profiles add column if not exists updated_at timestamptz not null default now();

create table if not exists public.venues (
  id uuid primary key default gen_random_uuid(), name text not null, address text not null,
  pitch text, notes text, active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(name,address)
);

create table if not exists public.matches (
  id uuid primary key default gen_random_uuid(), title text not null default 'Thursday Football',
  starts_at timestamptz not null, venue_id uuid references public.venues(id) on delete set null,
  max_players smallint check (max_players is null or max_players between 2 and 50), notes text,
  availability_deadline timestamptz, availability_locked boolean not null default false,
  status public.match_status not null default 'DRAFT', bibs_score smallint check (bibs_score >= 0),
  non_bibs_score smallint check (non_bibs_score >= 0), voting_opens_at timestamptz,
  voting_closes_at timestamptz, created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (voting_closes_at is null or voting_opens_at is null or voting_closes_at > voting_opens_at)
);

create table if not exists public.match_availability (
  match_id uuid not null references public.matches(id) on delete cascade,
  player_id uuid not null references public.profiles(id) on delete cascade,
  status public.availability_status not null, updated_at timestamptz not null default now(),
  primary key(match_id,player_id)
);
create table if not exists public.team_assignments (
  match_id uuid not null references public.matches(id) on delete cascade,
  player_id uuid not null references public.profiles(id) on delete cascade,
  side public.team_side not null, assigned_at timestamptz not null default now(),
  primary key(match_id,player_id)
);
create table if not exists public.ratings (
  id uuid primary key default gen_random_uuid(), match_id uuid not null references public.matches(id) on delete cascade,
  voter_id uuid not null references public.profiles(id) on delete cascade,
  target_player_id uuid not null references public.profiles(id) on delete cascade,
  score numeric(3,1) not null check (score between 1 and 10 and mod(score * 2, 1) = 0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(match_id,voter_id,target_player_id), check (voter_id <> target_player_id)
);
create table if not exists public.motm_votes (
  id uuid primary key default gen_random_uuid(), match_id uuid not null references public.matches(id) on delete cascade,
  voter_id uuid not null references public.profiles(id) on delete cascade,
  target_player_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(), unique(match_id,voter_id), check(voter_id <> target_player_id)
);
create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(), match_id uuid not null references public.matches(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete cascade,
  target_player_id uuid references public.profiles(id) on delete cascade,
  body text not null check (char_length(body) between 1 and 1000), anonymous boolean not null default false,
  moderated boolean not null default false, deleted_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.goals (
  id uuid primary key default gen_random_uuid(), match_id uuid not null references public.matches(id) on delete cascade,
  scorer_id uuid references public.profiles(id) on delete set null, team public.team_side not null,
  quantity smallint not null default 1 check(quantity between 1 and 30), created_at timestamptz not null default now(),
  unique(match_id,scorer_id,team)
);
create table if not exists public.notification_preferences (
  player_id uuid primary key references public.profiles(id) on delete cascade,
  match_created boolean not null default true, reminders boolean not null default true,
  teams_generated boolean not null default true, voting boolean not null default true,
  results boolean not null default true, updated_at timestamptz not null default now()
);
create table if not exists public.notification_outbox (
  id uuid primary key default gen_random_uuid(), event public.notification_event not null,
  match_id uuid references public.matches(id) on delete cascade, recipient_id uuid references public.profiles(id) on delete cascade,
  payload jsonb not null default '{}', processed_at timestamptz, error text, created_at timestamptz not null default now()
);

create or replace function public.touch_updated_at() returns trigger language plpgsql as $$ begin new.updated_at=now(); return new; end $$;
do $$ declare table_name text; begin foreach table_name in array array['profiles','venues','matches','match_availability','ratings','comments','notification_preferences'] loop execute format('drop trigger if exists touch_updated_at on public.%I',table_name); execute format('create trigger touch_updated_at before update on public.%I for each row execute function public.touch_updated_at()',table_name); end loop; end $$;

create or replace function public.queue_match_notification() returns trigger language plpgsql security definer set search_path=public as $$
declare queued_event public.notification_event;
begin
  if tg_op='INSERT' and new.status='AVAILABILITY_OPEN' then queued_event='MATCH_CREATED';
  elsif tg_op='UPDATE' and new.status is distinct from old.status then
    queued_event := case new.status when 'TEAMS_GENERATED' then 'TEAMS_GENERATED'::public.notification_event when 'CANCELLED' then 'MATCH_CANCELLED'::public.notification_event when 'VOTING_OPEN' then 'VOTING_OPENED'::public.notification_event when 'FINALISED' then 'MATCH_FINALISED'::public.notification_event else null end;
  end if;
  if queued_event is not null then insert into public.notification_outbox(event,match_id,payload) values(queued_event,new.id,jsonb_build_object('title',new.title,'starts_at',new.starts_at)); end if;
  return new;
end $$;
drop trigger if exists queue_match_notification on public.matches;
create trigger queue_match_notification after insert or update of status on public.matches for each row execute function public.queue_match_notification();

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path=public as $$
begin insert into public.profiles(id,email,full_name) values(new.id,coalesce(new.email,''),coalesce(nullif(trim(new.raw_user_meta_data->>'full_name'),''),split_part(coalesce(new.email,'New player'),'@',1))) on conflict(id) do nothing; return new; end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

create or replace function public.is_admin() returns boolean language sql stable security definer set search_path=public as $$ select exists(select 1 from public.profiles where id=auth.uid() and role='ADMIN' and status='APPROVED') $$;
create or replace function public.is_approved() returns boolean language sql stable security definer set search_path=public as $$ select exists(select 1 from public.profiles where id=auth.uid() and status='APPROVED') $$;
create or replace function public.is_match_attendee(mid uuid) returns boolean language sql stable security definer set search_path=public as $$ select public.is_admin() or exists(select 1 from public.match_availability where match_id=mid and player_id=auth.uid() and status in ('PLAYING','WATCHING')) $$;
create or replace function public.is_match_player(target_match uuid,target_player uuid) returns boolean language sql stable security definer set search_path=public as $$ select exists(select 1 from public.match_availability where match_id=target_match and player_id=target_player and status='PLAYING') $$;
grant execute on function public.is_admin to authenticated;
grant execute on function public.is_approved to authenticated;

create or replace function public.prevent_profile_privilege_escalation() returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.id=auth.uid() and not public.is_admin() and (new.role<>old.role or new.status<>old.status or new.comment_restricted<>old.comment_restricted) then
    raise exception 'Only admins can change account access';
  end if;
  return new;
end $$;
drop trigger if exists prevent_profile_privilege_escalation on public.profiles;
create trigger prevent_profile_privilege_escalation before update on public.profiles for each row execute function public.prevent_profile_privilege_escalation();

-- Public-safe aggregates never expose voter IDs and stay hidden until finalisation.
create or replace view public.public_match_ratings as
select r.match_id,r.target_player_id as player_id,round(avg(r.score),1) as average_rating,count(*)::int as rating_count
from public.ratings r join public.matches m on m.id=r.match_id
where m.status='FINALISED' group by r.match_id,r.target_player_id having count(*)>=3;
create or replace view public.public_motm_results as
select v.match_id,v.target_player_id as player_id,count(*)::int as votes
from public.motm_votes v join public.matches m on m.id=v.match_id
where m.status='FINALISED' group by v.match_id,v.target_player_id;
create or replace view public.public_comments as
select c.id,c.match_id,c.target_player_id,c.body,c.anonymous,c.created_at,
  case when c.anonymous then null else jsonb_build_object('id',p.id,'full_name',p.full_name,'avatar_url',p.avatar_url) end as author
from public.comments c join public.profiles p on p.id=c.author_id where c.deleted_at is null and not c.moderated;
create or replace view public.player_stats as
with played as (
 select ta.player_id,m.id,m.starts_at,ta.side,m.bibs_score,m.non_bibs_score,
 case when m.bibs_score=m.non_bibs_score then 'D' when (ta.side='BIBS' and m.bibs_score>m.non_bibs_score) or (ta.side='NON_BIBS' and m.non_bibs_score>m.bibs_score) then 'W' else 'L' end result
 from public.team_assignments ta join public.matches m on m.id=ta.match_id where m.status='FINALISED'
), match_scores as (select match_id,player_id,average_rating,row_number() over(partition by player_id order by mt.starts_at desc) rn from public.public_match_ratings pr join public.matches mt on mt.id=pr.match_id),
motm_max as (select match_id,max(votes) votes from public.public_motm_results group by match_id), motm as (select r.player_id,count(*)::int awards from public.public_motm_results r join motm_max x on x.match_id=r.match_id and x.votes=r.votes group by r.player_id)
select p.id player_id,count(distinct pl.id)::int matches_played,count(distinct pl.id) filter(where pl.result='W')::int matches_won,count(distinct pl.id) filter(where pl.result='D')::int matches_drawn,count(distinct pl.id) filter(where pl.result='L')::int matches_lost,
 coalesce((select sum(g.quantity) from public.goals g join public.matches gm on gm.id=g.match_id where g.scorer_id=p.id and gm.status='FINALISED'),0)::int goals,coalesce(mo.awards,0)::int motm_awards,
 round(avg(ms.average_rating),1) overall_rating,round(avg(ms.average_rating) filter(where ms.rn<=5),1) recent_form,max(ms.average_rating) highest_rating,
 round(100.0 * (select count(*) from public.match_availability ma join public.matches am on am.id=ma.match_id where ma.player_id=p.id and ma.status in ('PLAYING','WATCHING') and am.status='FINALISED') / nullif((select count(*) from public.matches fm where fm.status='FINALISED'),0),1) attendance_percentage
from public.profiles p left join played pl on pl.player_id=p.id left join match_scores ms on ms.player_id=p.id left join motm mo on mo.player_id=p.id where p.status='APPROVED' group by p.id,mo.awards;

grant select on public.public_match_ratings,public.public_motm_results,public.public_comments,public.player_stats to authenticated;
revoke all on public.public_match_ratings,public.public_motm_results,public.public_comments,public.player_stats from anon;
revoke all on public.ratings,public.motm_votes,public.comments from anon;

alter table public.profiles enable row level security; alter table public.venues enable row level security; alter table public.matches enable row level security;
alter table public.match_availability enable row level security; alter table public.team_assignments enable row level security; alter table public.ratings enable row level security;
alter table public.motm_votes enable row level security; alter table public.comments enable row level security; alter table public.goals enable row level security;
alter table public.notification_preferences enable row level security; alter table public.notification_outbox enable row level security;

create policy "profiles visible safely" on public.profiles for select to authenticated using (public.is_admin() or id=auth.uid() or (public.is_approved() and status='APPROVED'));
create policy "players update own safe profile" on public.profiles for update to authenticated using(id=auth.uid()) with check(id=auth.uid());
create policy "admins manage profiles" on public.profiles for update to authenticated using(public.is_admin()) with check(public.is_admin());
create policy "approved read venues" on public.venues for select to authenticated using(public.is_approved()); create policy "admins manage venues" on public.venues for all to authenticated using(public.is_admin()) with check(public.is_admin());
create policy "approved read matches" on public.matches for select to authenticated using(public.is_approved() and (status<>'DRAFT' or public.is_admin())); create policy "admins manage matches" on public.matches for all to authenticated using(public.is_admin()) with check(public.is_admin());
create policy "approved read availability" on public.match_availability for select to authenticated using(public.is_approved());
create policy "players set availability" on public.match_availability for insert to authenticated with check(player_id=auth.uid() and exists(select 1 from public.matches m where m.id=match_id and m.status='AVAILABILITY_OPEN' and not m.availability_locked and (m.availability_deadline is null or now()<=m.availability_deadline)));
create policy "players update availability" on public.match_availability for update to authenticated using(player_id=auth.uid()) with check(player_id=auth.uid() and exists(select 1 from public.matches m where m.id=match_id and m.status='AVAILABILITY_OPEN' and not m.availability_locked and (m.availability_deadline is null or now()<=m.availability_deadline)));
create policy "admins manage availability" on public.match_availability for all to authenticated using(public.is_admin()) with check(public.is_admin());
create policy "approved read teams" on public.team_assignments for select to authenticated using(public.is_approved()); create policy "admins manage teams" on public.team_assignments for all to authenticated using(public.is_admin()) with check(public.is_admin());
create policy "voters read own ratings" on public.ratings for select to authenticated using(voter_id=auth.uid() or public.is_admin());
create policy "eligible voters rate" on public.ratings for insert to authenticated with check(voter_id=auth.uid() and voter_id<>target_player_id and public.is_match_attendee(match_id) and public.is_match_player(match_id,target_player_id) and exists(select 1 from public.matches m where m.id=match_id and m.status='VOTING_OPEN' and (m.voting_closes_at is null or now()<=m.voting_closes_at)));
create policy "eligible voters edit ratings" on public.ratings for update to authenticated using(voter_id=auth.uid()) with check(voter_id=auth.uid() and exists(select 1 from public.matches m where m.id=match_id and m.status='VOTING_OPEN' and (m.voting_closes_at is null or now()<=m.voting_closes_at)));
create policy "admins audit ratings" on public.ratings for all to authenticated using(public.is_admin()) with check(public.is_admin());
create policy "voters read own motm" on public.motm_votes for select to authenticated using(voter_id=auth.uid() or public.is_admin()); create policy "eligible voters choose motm" on public.motm_votes for insert to authenticated with check(voter_id=auth.uid() and voter_id<>target_player_id and public.is_match_attendee(match_id) and public.is_match_player(match_id,target_player_id) and exists(select 1 from public.matches m where m.id=match_id and m.status='VOTING_OPEN' and (m.voting_closes_at is null or now()<=m.voting_closes_at))); create policy "admins audit motm" on public.motm_votes for all to authenticated using(public.is_admin()) with check(public.is_admin());
create policy "authors read own comments" on public.comments for select to authenticated using(author_id=auth.uid() or public.is_admin()); create policy "attendees comment" on public.comments for insert to authenticated with check(author_id=auth.uid() and public.is_match_attendee(match_id) and not exists(select 1 from public.profiles p where p.id=auth.uid() and p.comment_restricted)); create policy "admins moderate comments" on public.comments for all to authenticated using(public.is_admin()) with check(public.is_admin());
create policy "approved read goals" on public.goals for select to authenticated using(public.is_approved()); create policy "admins manage goals" on public.goals for all to authenticated using(public.is_admin()) with check(public.is_admin());
create policy "players manage preferences" on public.notification_preferences for all to authenticated using(player_id=auth.uid()) with check(player_id=auth.uid()); create policy "admins read preferences" on public.notification_preferences for select to authenticated using(public.is_admin());
create policy "admins manage outbox" on public.notification_outbox for all to authenticated using(public.is_admin()) with check(public.is_admin());

-- Private avatar bucket. Public URLs are intentionally not assumed.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('avatars','avatars',true,5242880,array['image/jpeg','image/png','image/webp']) on conflict(id) do update set file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
create policy "avatar uploads use own folder" on storage.objects for insert to authenticated with check(bucket_id='avatars' and (storage.foldername(name))[1]=auth.uid()::text);
create policy "owners update avatars" on storage.objects for update to authenticated using(bucket_id='avatars' and owner_id=auth.uid()::text);
create policy "approved read avatars" on storage.objects for select to authenticated using(bucket_id='avatars' and public.is_approved());

create index if not exists matches_starts_at_idx on public.matches(starts_at); create index if not exists availability_match_status_idx on public.match_availability(match_id,status);
create index if not exists ratings_target_idx on public.ratings(match_id,target_player_id); create index if not exists comments_match_idx on public.comments(match_id,created_at desc);
create unique index if not exists profiles_email_unique_idx on public.profiles(lower(email));

-- Bootstrap the first admin manually after signup:
-- update public.profiles set role='ADMIN',status='APPROVED' where email='you@example.com';
