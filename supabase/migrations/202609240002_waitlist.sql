-- Capacity enforcement is transactional; direct player writes to availability
-- are removed so simultaneous replies cannot overfill a capped match.
create table if not exists public.match_waitlist (
  match_id uuid not null references public.matches(id) on delete cascade,
  player_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (match_id, player_id)
);
create index if not exists match_waitlist_order_idx on public.match_waitlist(match_id, joined_at, player_id);
alter table public.match_waitlist enable row level security;
grant select on public.match_waitlist to authenticated;
create policy "approved members see match waiting lists" on public.match_waitlist for select to authenticated
using (public.is_approved());

drop policy if exists "players set availability" on public.match_availability;
drop policy if exists "players update availability" on public.match_availability;

create or replace function public.set_player_availability(p_match uuid, p_status public.availability_status)
returns text language plpgsql security definer set search_path = public as $$
declare fixture public.matches%rowtype; me uuid := auth.uid(); current_playing int;
begin
  if me is null or not public.is_approved() then raise exception 'Approved member required'; end if;
  if p_status is null then raise exception 'Choose an availability response'; end if;
  select * into fixture from public.matches where id = p_match for update;
  if not found then raise exception 'Match not found'; end if;
  if fixture.status <> 'AVAILABILITY_OPEN' or fixture.availability_locked
     or (fixture.availability_deadline is not null and now() > fixture.availability_deadline) then
    raise exception 'Availability is closed';
  end if;
  if p_status = 'PLAYING' and fixture.max_players is not null then
    select count(*) into current_playing from public.match_availability
      where match_id = p_match and status = 'PLAYING' and player_id <> me;
    if current_playing >= fixture.max_players then
      delete from public.match_availability where match_id = p_match and player_id = me;
      insert into public.match_waitlist(match_id, player_id) values(p_match, me)
        on conflict (match_id, player_id) do nothing;
      return 'WAITING';
    end if;
  end if;
  delete from public.match_waitlist where match_id = p_match and player_id = me;
  insert into public.match_availability(match_id, player_id, status)
    values(p_match, me, p_status)
    on conflict (match_id, player_id) do update set status = excluded.status;
  return p_status::text;
end $$;
revoke all on function public.set_player_availability(uuid, public.availability_status) from public, anon;
grant execute on function public.set_player_availability(uuid, public.availability_status) to authenticated;

create or replace function public.promote_waitlisted(p_match uuid, p_player uuid)
returns void language plpgsql security definer set search_path = public as $$
declare fixture public.matches%rowtype; current_playing int;
begin
  if not public.is_admin() then raise exception 'Admin access required'; end if;
  select * into fixture from public.matches where id = p_match for update;
  if not found then raise exception 'Match not found'; end if;
  if fixture.status in ('FINALISED','CANCELLED') then raise exception 'Match is closed'; end if;
  if not exists (select 1 from public.match_waitlist where match_id = p_match and player_id = p_player) then
    raise exception 'Player is not on the waiting list';
  end if;
  if not exists (select 1 from public.profiles where id = p_player and status = 'APPROVED') then
    raise exception 'Only an approved player can be promoted';
  end if;
  select count(*) into current_playing from public.match_availability where match_id = p_match and status = 'PLAYING';
  if fixture.max_players is not null and current_playing >= fixture.max_players then
    raise exception 'Playing limit is still full';
  end if;
  insert into public.match_availability(match_id, player_id, status) values(p_match, p_player, 'PLAYING')
    on conflict (match_id, player_id) do update set status = 'PLAYING';
  delete from public.match_waitlist where match_id = p_match and player_id = p_player;
end $$;
revoke all on function public.promote_waitlisted(uuid, uuid) from public, anon;
grant execute on function public.promote_waitlisted(uuid, uuid) to authenticated;
