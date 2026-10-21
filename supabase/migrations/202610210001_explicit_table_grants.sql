-- Explicit Data API grants for the tables created before 24 Sep 2026.
--
-- From 30 Oct 2026 Supabase stops granting anon/authenticated/service_role
-- privileges on new tables in "public" automatically. Production keeps its
-- existing grants (this migration is a no-op there), but a new project, a
-- preview branch or `supabase db reset` would otherwise leave these tables
-- unreachable through supabase-js.
--
-- Least privilege, matched to the RLS policies: every policy on these tables
-- is "to authenticated", so anon gets nothing; profiles only has select and
-- update policies. service_role is server-side only (dashboard, scripts).
-- Every new table must carry its own grants in the migration that creates it
-- (see supabase/MIGRATION_TEMPLATE.sql).

grant select, update on public.profiles to authenticated;

grant select, insert, update, delete on
  public.venues,
  public.matches,
  public.match_availability,
  public.team_assignments,
  public.ratings,
  public.motm_votes,
  public.comments,
  public.goals,
  public.notification_preferences,
  public.notification_outbox,
  public.game_date_polls,
  public.game_date_options,
  public.game_date_votes
to authenticated;

grant select, insert, update, delete on
  public.profiles,
  public.venues,
  public.matches,
  public.match_availability,
  public.team_assignments,
  public.ratings,
  public.motm_votes,
  public.comments,
  public.goals,
  public.notification_preferences,
  public.notification_outbox,
  public.game_date_polls,
  public.game_date_options,
  public.game_date_votes,
  public.admin_audit_log,
  public.feedback_reports,
  public.account_deletion_requests,
  public.match_waitlist,
  public.in_app_notifications
to service_role;
