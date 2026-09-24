begin;

-- Existing objects and profile URLs stay in place. Only authenticated,
-- approved members can request short-lived links to profile photos.
update storage.buckets set public = false where id = 'avatars';

create table if not exists public.in_app_notifications (
  id bigint generated always as identity primary key,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  outbox_id uuid not null references public.notification_outbox(id) on delete cascade,
  event public.notification_event not null,
  match_id uuid references public.matches(id) on delete set null,
  title text not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  unique (outbox_id, recipient_id)
);
create index if not exists notifications_recipient_recent_idx
  on public.in_app_notifications(recipient_id, created_at desc);
create index if not exists notifications_unread_idx
  on public.in_app_notifications(recipient_id, created_at desc) where read_at is null;
alter table public.in_app_notifications enable row level security;
revoke all on public.in_app_notifications from anon, authenticated;
grant select, update(read_at) on public.in_app_notifications to authenticated;
create policy "members read own notifications" on public.in_app_notifications
  for select to authenticated using (recipient_id = auth.uid() and public.is_approved());
create policy "members mark own notifications read" on public.in_app_notifications
  for update to authenticated using (recipient_id = auth.uid() and public.is_approved())
  with check (recipient_id = auth.uid() and public.is_approved());

create or replace function public.deliver_in_app_notification() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.in_app_notifications(recipient_id, outbox_id, event, match_id, title)
  select p.id, new.id, new.event, new.match_id,
    coalesce(nullif(new.payload->>'title', ''), 'CAFF match update')
  from public.profiles p
  left join public.notification_preferences pref on pref.player_id = p.id
  where p.status = 'APPROVED'
    and (new.recipient_id is null or p.id = new.recipient_id)
    and case new.event
      when 'MATCH_CREATED' then coalesce(pref.match_created, true)
      when 'AVAILABILITY_REMINDER' then coalesce(pref.reminders, true)
      when 'TEAMS_GENERATED' then coalesce(pref.teams_generated, true)
      when 'VOTING_OPENED' then coalesce(pref.voting, true)
      when 'VOTING_REMINDER' then coalesce(pref.voting, true)
      when 'MATCH_FINALISED' then coalesce(pref.results, true)
      else true
    end
  on conflict (outbox_id, recipient_id) do nothing;
  return new;
end $$;
drop trigger if exists deliver_in_app_notification on public.notification_outbox;
create trigger deliver_in_app_notification after insert on public.notification_outbox
  for each row execute function public.deliver_in_app_notification();

-- Log meaningful admin edits without allowing browser clients to write logs.
create or replace function public.audit_match_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.is_admin() then return new; end if;
  if tg_op = 'INSERT' then
    insert into public.admin_audit_log(actor_id,target_id,action,details)
    values(auth.uid(),new.id,'MATCH_CREATED',jsonb_build_object('title',new.title));
  elsif tg_op = 'UPDATE' then
    if new.status is distinct from old.status then
      insert into public.admin_audit_log(actor_id,target_id,action,details)
      values(auth.uid(),new.id,'MATCH_STATUS_CHANGED',jsonb_build_object(
        'title',new.title,'before',old.status,'after',new.status));
    end if;
    if new.bibs_score is distinct from old.bibs_score
       or new.non_bibs_score is distinct from old.non_bibs_score then
      insert into public.admin_audit_log(actor_id,target_id,action,details)
      values(auth.uid(),new.id,'RESULT_CHANGED',jsonb_build_object(
        'title',new.title,'before_bibs',old.bibs_score,'before_non_bibs',old.non_bibs_score,
        'after_bibs',new.bibs_score,'after_non_bibs',new.non_bibs_score));
    end if;
  end if;
  return new;
end $$;
drop trigger if exists audit_match_change on public.matches;
create trigger audit_match_change after insert or update on public.matches
  for each row execute function public.audit_match_change();

create or replace function public.audit_team_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare item public.team_assignments%rowtype;
  prior_side public.team_side;
begin
  if tg_op = 'DELETE' then item := old; else item := new; end if;
  if tg_op = 'UPDATE' then
    if new.side is not distinct from old.side then return new; end if;
    prior_side := old.side;
  end if;
  if auth.uid() is not null and public.is_admin() then
    insert into public.admin_audit_log(actor_id,target_id,action,details)
    values(auth.uid(),item.player_id,
      case tg_op when 'INSERT' then 'TEAM_PLAYER_ASSIGNED'
        when 'DELETE' then 'TEAM_PLAYER_REMOVED' else 'TEAM_PLAYER_MOVED' end,
      jsonb_build_object('match_id',item.match_id,'side',item.side,
        'previous_side',prior_side));
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists audit_team_change on public.team_assignments;
create trigger audit_team_change after insert or update or delete on public.team_assignments
  for each row execute function public.audit_team_change();

create or replace function public.audit_goal_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare item public.goals%rowtype;
begin
  if tg_op = 'DELETE' then item := old; else item := new; end if;
  if auth.uid() is not null and public.is_admin() then
    insert into public.admin_audit_log(actor_id,target_id,action,details)
    values(auth.uid(),coalesce(item.scorer_id,item.match_id),'GOALS_CHANGED',
      jsonb_build_object('match_id',item.match_id,'operation',tg_op,
        'team',item.team,'quantity',item.quantity));
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists audit_goal_change on public.goals;
create trigger audit_goal_change after insert or update or delete on public.goals
  for each row execute function public.audit_goal_change();

create or replace function public.audit_availability_override() returns trigger
language plpgsql security definer set search_path = public as $$
declare item public.match_availability%rowtype;
begin
  if tg_op = 'DELETE' then item := old; else item := new; end if;
  if tg_op = 'UPDATE' then
    if new.status is not distinct from old.status then return new; end if;
  end if;
  if auth.uid() is not null and public.is_admin() and auth.uid() <> item.player_id then
    insert into public.admin_audit_log(actor_id,target_id,action,details)
    values(auth.uid(),item.player_id,'AVAILABILITY_OVERRIDDEN',
      jsonb_build_object('match_id',item.match_id,'operation',tg_op,
        'status',item.status));
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
drop trigger if exists audit_availability_override on public.match_availability;
create trigger audit_availability_override after insert or update or delete on public.match_availability
  for each row execute function public.audit_availability_override();

create or replace function public.audit_comment_moderation() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and public.is_admin()
     and (new.moderated is distinct from old.moderated
       or new.deleted_at is distinct from old.deleted_at) then
    insert into public.admin_audit_log(actor_id,target_id,action,details)
    values(auth.uid(),new.author_id,'COMMENT_MODERATED',
      jsonb_build_object('match_id',new.match_id,'comment_id',new.id,
        'moderated',new.moderated));
  end if;
  return new;
end $$;
drop trigger if exists audit_comment_moderation on public.comments;
create trigger audit_comment_moderation after update on public.comments
  for each row execute function public.audit_comment_moderation();

create or replace function public.audit_poll_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.is_admin() then return new; end if;
  if tg_op = 'INSERT' then
    insert into public.admin_audit_log(actor_id,target_id,action,details)
    values(auth.uid(),new.id,'DATE_POLL_CREATED',
      jsonb_build_object('title',new.title,'status',new.status));
  elsif new.status is distinct from old.status then
    insert into public.admin_audit_log(actor_id,target_id,action,details)
    values(auth.uid(),new.id,'DATE_POLL_STATUS_CHANGED',
      jsonb_build_object('title',new.title,'status',new.status));
  end if;
  return new;
end $$;
drop trigger if exists audit_poll_change on public.game_date_polls;
create trigger audit_poll_change after insert or update on public.game_date_polls
  for each row execute function public.audit_poll_change();

create or replace function public.audit_venue_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and public.is_admin() then
    insert into public.admin_audit_log(actor_id,target_id,action,details)
    values(auth.uid(),new.id,
      case when tg_op = 'INSERT' then 'VENUE_CREATED' else 'VENUE_CHANGED' end,
      jsonb_build_object('title',new.name));
  end if;
  return new;
end $$;
drop trigger if exists audit_venue_change on public.venues;
create trigger audit_venue_change after insert or update on public.venues
  for each row execute function public.audit_venue_change();

commit;
