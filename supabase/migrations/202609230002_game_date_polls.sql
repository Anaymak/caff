-- Admin-created future match date polls with private voter identities and public totals.
create table if not exists public.game_date_polls (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 120),
  notes text check (notes is null or char_length(notes) <= 500),
  venue_id uuid references public.venues(id) on delete set null,
  closes_at timestamptz,
  status text not null default 'OPEN' check (status in ('OPEN','CLOSED')),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.game_date_options (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references public.game_date_polls(id) on delete cascade,
  starts_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (poll_id, starts_at),
  unique (id, poll_id)
);

create table if not exists public.game_date_votes (
  poll_id uuid not null references public.game_date_polls(id) on delete cascade,
  option_id uuid not null,
  player_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (option_id, player_id),
  foreign key (option_id, poll_id) references public.game_date_options(id, poll_id) on delete cascade
);

drop trigger if exists touch_updated_at on public.game_date_polls;
create trigger touch_updated_at before update on public.game_date_polls
for each row execute function public.touch_updated_at();

alter table public.game_date_polls enable row level security;
alter table public.game_date_options enable row level security;
alter table public.game_date_votes enable row level security;

create policy "approved read date polls" on public.game_date_polls for select to authenticated
using (public.is_approved());
create policy "admins manage date polls" on public.game_date_polls for all to authenticated
using (public.is_admin()) with check (public.is_admin());

create policy "approved read date options" on public.game_date_options for select to authenticated
using (public.is_approved());
create policy "admins manage date options" on public.game_date_options for all to authenticated
using (public.is_admin()) with check (public.is_admin());

create policy "players read own date votes" on public.game_date_votes for select to authenticated
using (player_id = auth.uid() or public.is_admin());
create policy "players add date votes" on public.game_date_votes for insert to authenticated
with check (
  player_id = auth.uid()
  and public.is_approved()
  and exists (
    select 1 from public.game_date_polls poll
    where poll.id = poll_id and poll.status = 'OPEN'
      and (poll.closes_at is null or now() <= poll.closes_at)
  )
);
create policy "players remove own date votes" on public.game_date_votes for delete to authenticated
using (
  player_id = auth.uid()
  and exists (
    select 1 from public.game_date_polls poll
    where poll.id = poll_id and poll.status = 'OPEN'
      and (poll.closes_at is null or now() <= poll.closes_at)
  )
);
create policy "admins manage date votes" on public.game_date_votes for all to authenticated
using (public.is_admin()) with check (public.is_admin());

create or replace view public.game_date_poll_counts as
select option_id, poll_id, count(*)::int as vote_count
from public.game_date_votes
group by option_id, poll_id;

grant select on public.game_date_poll_counts to authenticated;
revoke all on public.game_date_poll_counts from anon;

create or replace function public.create_game_date_poll(
  p_title text,
  p_notes text,
  p_venue_id uuid,
  p_closes_at timestamptz,
  p_options timestamptz[]
) returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare new_poll_id uuid;
begin
  if not public.is_admin() then raise exception 'Admin access required'; end if;
  if coalesce(array_length(p_options, 1), 0) < 2 or array_length(p_options, 1) > 6 then
    raise exception 'Choose between two and six dates';
  end if;
  if exists (select 1 from unnest(p_options) option_time where option_time <= now()) then
    raise exception 'Poll options must be in the future';
  end if;
  if (select count(distinct option_time) from unnest(p_options) option_time) <> array_length(p_options, 1) then
    raise exception 'Poll options must be unique';
  end if;

  insert into public.game_date_polls(title, notes, venue_id, closes_at, created_by)
  values(trim(p_title), nullif(trim(p_notes), ''), p_venue_id, p_closes_at, auth.uid())
  returning id into new_poll_id;

  insert into public.game_date_options(poll_id, starts_at)
  select new_poll_id, option_time from unnest(p_options) option_time;
  return new_poll_id;
end;
$$;

grant execute on function public.create_game_date_poll(text,text,uuid,timestamptz,timestamptz[]) to authenticated;
create index if not exists game_date_polls_status_idx on public.game_date_polls(status, created_at desc);
create index if not exists game_date_options_poll_idx on public.game_date_options(poll_id, starts_at);
create index if not exists game_date_votes_poll_idx on public.game_date_votes(poll_id);
