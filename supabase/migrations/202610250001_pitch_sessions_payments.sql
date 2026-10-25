-- Pitch bookings, cost sharing and payment collection (prepared 25 Oct 2026).
--
-- Additive only: no existing table, row or policy is changed or removed.
-- Money is integer pence. Every write goes through a SECURITY DEFINER function
-- that checks permissions, locks the session row and writes the audit log, so
-- the browser never supplies an amount that is charged. Stripe-facing functions
-- (checkout_*, stripe_*, refund_attach, payment_set_actual_fee) are executable by
-- service_role only and are called by the payments Lambda (payments/handler.mjs).
begin;

-- ---------------------------------------------------------------- permissions
create table if not exists public.admin_permissions (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  permission text not null check (permission in (
    'sessions.manage','attendance.manage','payments.request','finance.view',
    'payments.record_manual','payments.refund','settings.manage')),
  granted_by uuid references public.profiles(id) on delete set null,
  granted_at timestamptz not null default now(),
  primary key (profile_id, permission)
);
alter table public.admin_permissions enable row level security;

-- The Owner holds every permission. Other approved Admins need an explicit grant.
create or replace function public.has_permission(p_permission text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_owner() or (public.is_admin() and exists (
    select 1 from public.admin_permissions where profile_id = auth.uid() and permission = p_permission))
$$;
revoke all on function public.has_permission(text) from public, anon;
grant execute on function public.has_permission(text) to authenticated;

-- Existing Admins keep day-to-day session and payment work; refunds and
-- settings stay Owner-only until the Owner grants them.
insert into public.admin_permissions (profile_id, permission)
select p.id, perm from public.profiles p
cross join unnest(array['sessions.manage','attendance.manage','payments.request','finance.view','payments.record_manual']) perm
where p.role = 'ADMIN' and p.status = 'APPROVED' and not p.is_owner
on conflict do nothing;

create policy "own or owner reads permissions" on public.admin_permissions for select to authenticated
using (profile_id = auth.uid() or public.is_owner());

-- ------------------------------------------------------------------- settings
create table if not exists public.payment_settings (
  id smallint primary key default 1 check (id = 1),
  fee_percent_bps integer not null default 150 check (fee_percent_bps between 0 and 1000),
  fee_fixed_pence integer not null default 20 check (fee_fixed_pence between 0 and 500),
  default_fee_mode text not null default 'ABSORB' check (default_fee_mode in ('ABSORB','COVER_IN_PRICE')),
  stripe_mode text not null default 'test' check (stripe_mode in ('test','live')),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);
insert into public.payment_settings (id) values (1) on conflict do nothing;
alter table public.payment_settings enable row level security;
create policy "finance reads settings" on public.payment_settings for select to authenticated
using (public.has_permission('finance.view') or public.has_permission('settings.manage') or public.has_permission('sessions.manage'));

-- ------------------------------------------------------------------- sessions
create table if not exists public.pitch_sessions (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(trim(title)) between 1 and 120),
  starts_at timestamptz not null,
  duration_minutes smallint not null default 60 check (duration_minutes between 15 and 300),
  venue_id uuid references public.venues(id) on delete set null,
  venue_name text check (venue_name is null or char_length(venue_name) <= 120),
  pitch_name text check (pitch_name is null or char_length(pitch_name) <= 120),
  pitch_type text check (pitch_type is null or char_length(pitch_type) <= 60),
  pitch_cost_pence integer not null check (pitch_cost_pence between 0 and 1000000),
  fee_mode text not null default 'ABSORB' check (fee_mode in ('ABSORB','COVER_IN_PRICE')),
  notes text check (notes is null or char_length(notes) <= 2000),
  payment_deadline timestamptz,
  status text not null default 'PLANNING' check (status in ('PLANNING','OPEN','CONFIRMED','COMPLETED','CANCELLED')),
  match_id uuid references public.matches(id) on delete set null,
  calc_version integer not null default 1,
  cancelled_reason text check (cancelled_reason is null or char_length(cancelled_reason) <= 500),
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists pitch_sessions_starts_idx on public.pitch_sessions(starts_at desc);
create trigger touch_updated_at before update on public.pitch_sessions for each row execute function public.touch_updated_at();
alter table public.pitch_sessions enable row level security;

create table if not exists public.session_attendees (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.pitch_sessions(id) on delete restrict,
  profile_id uuid references public.profiles(id) on delete set null,
  display_name text not null check (char_length(trim(display_name)) between 1 and 80),
  attendance text not null default 'UNCONFIRMED' check (attendance in ('CONFIRMED','UNCONFIRMED','CANCELLED')),
  chargeable boolean not null default true,
  note text check (note is null or char_length(note) <= 300),
  added_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists session_attendee_profile_uq on public.session_attendees(session_id, profile_id) where profile_id is not null;
create unique index if not exists session_attendee_guest_uq on public.session_attendees(session_id, lower(trim(display_name))) where profile_id is null;
create index if not exists session_attendees_session_idx on public.session_attendees(session_id);
create trigger touch_updated_at before update on public.session_attendees for each row execute function public.touch_updated_at();
alter table public.session_attendees enable row level security;

-- ---------------------------------------------------------- payment requests
create table if not exists public.payment_requests (
  id uuid primary key default gen_random_uuid(),   -- random v4: also the unguessable pay-link id
  session_id uuid not null references public.pitch_sessions(id) on delete restrict,
  attendee_id uuid not null references public.session_attendees(id) on delete restrict,
  amount_pence integer not null check (amount_pence between 30 and 1000000), -- Stripe GBP minimum is 30p
  status text not null default 'PENDING' check (status in
    ('PENDING','FAILED','PAID','MANUALLY_PAID','REFUNDED','CANCELLED','SUPERSEDED')),
  calc_version integer not null,
  calculation jsonb not null,                       -- snapshot of the split at issue time
  due_at timestamptz,
  issued_by uuid references public.profiles(id) on delete set null,
  issued_at timestamptz not null default now(),
  superseded_by uuid references public.payment_requests(id),
  paid_at timestamptz,
  closed_reason text check (closed_reason is null or char_length(closed_reason) <= 300),
  last_error text check (last_error is null or char_length(last_error) <= 300),
  updated_at timestamptz not null default now()
);
-- At most one payable request per attendee: prevents duplicate requests.
create unique index if not exists payment_request_one_active on public.payment_requests(attendee_id) where status in ('PENDING','FAILED');
create index if not exists payment_requests_session_idx on public.payment_requests(session_id);
create trigger touch_updated_at before update on public.payment_requests for each row execute function public.touch_updated_at();
alter table public.payment_requests enable row level security;

create table if not exists public.payment_request_checkouts (
  request_id uuid not null references public.payment_requests(id) on delete restrict,
  attempt integer not null check (attempt > 0),
  amount_pence integer not null,
  status text not null default 'CREATING' check (status in ('CREATING','OPEN','COMPLETED','EXPIRED','FAILED')),
  checkout_session_id text unique,
  checkout_url text,
  livemode boolean,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (request_id, attempt)
);
alter table public.payment_request_checkouts enable row level security;

-- ------------------------------------------------------------------ payments
create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.pitch_sessions(id) on delete restrict,
  attendee_id uuid not null references public.session_attendees(id) on delete restrict,
  payment_request_id uuid references public.payment_requests(id) on delete restrict,
  method text not null check (method in ('STRIPE','BANK_TRANSFER','CASH','OTHER')),
  amount_pence integer not null check (amount_pence > 0 and amount_pence <= 1000000),
  refunded_pence integer not null default 0 check (refunded_pence >= 0),
  status text not null default 'SUCCEEDED' check (status in ('SUCCEEDED','VOID')),
  received_at timestamptz not null default now(),
  fee_estimated_pence integer not null default 0 check (fee_estimated_pence >= 0),
  fee_actual_pence integer check (fee_actual_pence >= 0),
  stripe_payment_intent_id text unique,
  stripe_checkout_session_id text unique,
  stripe_charge_id text,
  stripe_balance_transaction_id text,
  livemode boolean,
  reference text check (reference is null or char_length(reference) <= 120),
  notes text check (notes is null or char_length(notes) <= 500),
  client_token uuid unique,                         -- browser idempotency key for manual entries
  recorded_by uuid references public.profiles(id) on delete set null,
  needs_review boolean not null default false,
  review_note text check (review_note is null or char_length(review_note) <= 300),
  voided_at timestamptz,
  voided_by uuid references public.profiles(id) on delete set null,
  void_reason text check (void_reason is null or char_length(void_reason) <= 300),
  created_at timestamptz not null default now(),
  check (refunded_pence <= amount_pence),
  check ((method = 'STRIPE') = (stripe_payment_intent_id is not null)),
  check (status <> 'VOID' or (voided_at is not null and void_reason is not null))
);
create index if not exists payments_session_idx on public.payments(session_id);
create index if not exists payments_attendee_idx on public.payments(attendee_id);
alter table public.payments enable row level security;

create table if not exists public.payment_refunds (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments(id) on delete restrict,
  amount_pence integer not null check (amount_pence > 0),
  method text not null check (method in ('STRIPE','MANUAL')),
  status text not null default 'PENDING' check (status in ('PENDING','SUCCEEDED','FAILED')),
  stripe_refund_id text unique,
  reason text not null check (char_length(trim(reason)) between 1 and 300),
  error text check (error is null or char_length(error) <= 300),
  client_token uuid unique,
  requested_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists payment_refunds_payment_idx on public.payment_refunds(payment_id);
alter table public.payment_refunds enable row level security;

-- Processed Stripe webhook events. The primary key makes replays no-ops.
-- Only identifiers are kept (no customer names, emails or card data).
create table if not exists public.stripe_events (
  id text primary key check (id like 'evt_%'),
  type text not null,
  livemode boolean not null,
  object_id text,
  result text not null,
  received_at timestamptz not null default now()
);
alter table public.stripe_events enable row level security;

-- --------------------------------------------------------------- read access
create policy "session staff or attendee reads sessions" on public.pitch_sessions for select to authenticated
using (public.has_permission('sessions.manage') or public.has_permission('attendance.manage') or public.has_permission('finance.view')
  or (public.is_approved() and exists (select 1 from public.session_attendees a where a.session_id = pitch_sessions.id and a.profile_id = auth.uid())));
create policy "session staff or self reads attendees" on public.session_attendees for select to authenticated
using (public.has_permission('sessions.manage') or public.has_permission('attendance.manage') or public.has_permission('finance.view')
  or (public.is_approved() and profile_id = auth.uid()));
create policy "finance or payer reads requests" on public.payment_requests for select to authenticated
using (public.has_permission('finance.view')
  or (public.is_approved() and exists (select 1 from public.session_attendees a where a.id = attendee_id and a.profile_id = auth.uid())));
create policy "finance reads checkouts" on public.payment_request_checkouts for select to authenticated using (public.has_permission('finance.view'));
create policy "finance reads payments" on public.payments for select to authenticated using (public.has_permission('finance.view'));
create policy "finance reads refunds" on public.payment_refunds for select to authenticated using (public.has_permission('finance.view'));
create policy "finance reads stripe events" on public.stripe_events for select to authenticated using (public.has_permission('finance.view'));

-- Read-only for the browser: there are no insert/update/delete policies or grants.
revoke all on public.admin_permissions, public.payment_settings, public.pitch_sessions, public.session_attendees,
  public.payment_requests, public.payment_request_checkouts, public.payments, public.payment_refunds,
  public.stripe_events from anon, authenticated;
grant select on public.admin_permissions, public.payment_settings, public.pitch_sessions, public.session_attendees,
  public.payment_requests, public.payment_request_checkouts, public.payments, public.payment_refunds,
  public.stripe_events to authenticated;
grant select, insert, update, delete on public.admin_permissions, public.payment_settings, public.pitch_sessions,
  public.session_attendees, public.payment_requests, public.payment_request_checkouts, public.payments,
  public.payment_refunds, public.stripe_events to service_role;

-- ----------------------------------------------------------------- arithmetic
-- Estimated Stripe fee for one payment: percentage (basis points, half-up) + fixed.
create or replace function public.estimate_stripe_fee(p_amount integer, p_bps integer, p_fixed integer)
returns integer language sql immutable as $$
  select case when p_amount <= 0 then 0 else round(p_amount::numeric * p_bps / 10000)::integer + p_fixed end
$$;

-- Net of n equal shares of p_total (remainder pennies on the first shares) after estimated fees.
create or replace function public.split_net_after_fees(p_total integer, p_count integer, p_bps integer, p_fixed integer)
returns integer language sql immutable as $$
  select (p_count - p_total % p_count) * ((p_total / p_count) - public.estimate_stripe_fee(p_total / p_count, p_bps, p_fixed))
       + (p_total % p_count) * ((p_total / p_count + 1) - public.estimate_stripe_fee(p_total / p_count + 1, p_bps, p_fixed))
$$;

-- Amount to divide between chargeable attendees. ABSORB: the pitch cost.
-- COVER_IN_PRICE: the smallest total whose shares still cover the pitch after
-- estimated per-payment fees. Every player is charged the same all-in price
-- whatever the payment method (no card surcharge).
create or replace function public.session_allocation_total(p_pitch integer, p_count integer, p_mode text, p_bps integer, p_fixed integer)
returns integer language plpgsql immutable as $$
declare a integer;
begin
  if p_count <= 0 or p_pitch <= 0 or p_mode = 'ABSORB' then return greatest(p_pitch, 0); end if;
  a := greatest(p_pitch, ceil((p_pitch + p_count * p_fixed)::numeric / (1 - p_bps / 10000.0))::integer - p_count);
  while a > p_pitch and public.split_net_after_fees(a - 1, p_count, p_bps, p_fixed) >= p_pitch loop a := a - 1; end loop;
  while public.split_net_after_fees(a, p_count, p_bps, p_fixed) < p_pitch loop a := a + 1; end loop;
  return a;
end $$;

-- Each confirmed, chargeable attendee's share. Leftover pennies go one each to
-- the attendees first in a per-session hash order: deterministic, and over
-- many sessions not always the same people.
create or replace function public.session_shares(p_session uuid)
returns table (attendee_id uuid, share_pence integer, extra_penny boolean)
language plpgsql stable security definer set search_path = public as $$
declare s public.pitch_sessions%rowtype; cfg public.payment_settings%rowtype; n integer; total integer; base integer; rem integer;
begin
  select * into s from public.pitch_sessions where id = p_session;
  if not found then return; end if;
  select * into cfg from public.payment_settings where id = 1;
  select count(*) into n from public.session_attendees a where a.session_id = p_session and a.attendance = 'CONFIRMED' and a.chargeable;
  if n = 0 then return; end if;
  total := public.session_allocation_total(s.pitch_cost_pence, n, s.fee_mode, cfg.fee_percent_bps, cfg.fee_fixed_pence);
  base := total / n; rem := total % n;
  return query
    select x.id, base + (x.rn <= rem)::integer, x.rn <= rem
    from (select a.id, row_number() over (order by md5(p_session::text || a.id::text), a.id) rn
          from public.session_attendees a
          where a.session_id = p_session and a.attendance = 'CONFIRMED' and a.chargeable) x;
end $$;

-- Per-attendee position: current share, money kept (paid minus refunded) and the open request.
create or replace function public.session_balances(p_session uuid)
returns table (attendee_id uuid, share_pence integer, extra_penny boolean, paid_pence integer, refunded_pence integer,
  outstanding_pence integer, active_request_id uuid, active_request_pence integer)
language sql stable security definer set search_path = public as $$
  select a.id, coalesce(sh.share_pence, 0), coalesce(sh.extra_penny, false),
    coalesce(p.paid, 0), coalesce(p.refunded, 0),
    coalesce(sh.share_pence, 0) - coalesce(p.paid, 0) + coalesce(p.refunded, 0),
    r.id, r.amount_pence
  from public.session_attendees a
  left join public.session_shares(p_session) sh on sh.attendee_id = a.id
  left join lateral (select sum(amount_pence)::integer paid, sum(refunded_pence)::integer refunded
    from public.payments where attendee_id = a.id and status = 'SUCCEEDED') p on true
  left join public.payment_requests r on r.attendee_id = a.id and r.status in ('PENDING','FAILED')
  where a.session_id = p_session
$$;

create or replace function public.session_totals(p_session uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s public.pitch_sessions%rowtype; cfg public.payment_settings%rowtype; result jsonb;
begin
  select * into s from public.pitch_sessions where id = p_session;
  select * into cfg from public.payment_settings where id = 1;
  with b as (select * from public.session_balances(p_session)),
  pay as (select * from public.payments where session_id = p_session and status = 'SUCCEEDED'),
  calc as (select count(*) filter (where share_pence > 0)::integer n, coalesce(sum(share_pence), 0)::integer total,
    coalesce(min(share_pence) filter (where share_pence > 0), 0) base,
    count(*) filter (where extra_penny)::integer extra,
    coalesce(sum(public.estimate_stripe_fee(share_pence, cfg.fee_percent_bps, cfg.fee_fixed_pence)) filter (where share_pence > 0), 0)::integer est_fees,
    coalesce(sum(greatest(outstanding_pence, 0)), 0)::integer outstanding,
    coalesce(sum(public.estimate_stripe_fee(greatest(outstanding_pence, 0), cfg.fee_percent_bps, cfg.fee_fixed_pence)), 0)::integer outstanding_fees,
    coalesce(sum(-least(outstanding_pence, 0)), 0)::integer credit,
    count(*) filter (where share_pence > 0 and outstanding_pence <= 0)::integer paid_n,
    count(*) filter (where share_pence > 0 and outstanding_pence > 0)::integer unpaid_n,
    count(*) filter (where active_request_id is not null and active_request_pence is distinct from greatest(outstanding_pence, 0))::integer stale
    from b),
  money as (select coalesce(sum(amount_pence), 0)::integer gross, coalesce(sum(refunded_pence), 0)::integer refunded,
    coalesce(sum(fee_actual_pence), 0)::integer fees_actual,
    coalesce(sum(fee_estimated_pence) filter (where method = 'STRIPE' and fee_actual_pence is null), 0)::integer fees_pending,
    count(*) filter (where method = 'STRIPE')::integer stripe_n, count(*) filter (where method <> 'STRIPE')::integer manual_n,
    count(*) filter (where needs_review)::integer review_n from pay)
  select jsonb_build_object(
    'pitch_cost_pence', s.pitch_cost_pence, 'fee_mode', s.fee_mode, 'calc_version', s.calc_version,
    'fee_percent_bps', cfg.fee_percent_bps, 'fee_fixed_pence', cfg.fee_fixed_pence,
    'chargeable_count', calc.n, 'allocation_total_pence', calc.total, 'base_share_pence', calc.base,
    'extra_penny_count', calc.extra, 'fee_cover_pence', calc.total - s.pitch_cost_pence,
    'estimated_fees_all_stripe_pence', calc.est_fees,
    'expected_net_all_stripe_pence', calc.total - calc.est_fees,
    'gross_received_pence', money.gross, 'refunded_pence', money.refunded,
    'fees_actual_pence', money.fees_actual, 'fees_estimated_unconfirmed_pence', money.fees_pending,
    'net_received_pence', money.gross - money.refunded - money.fees_actual - money.fees_pending,
    'fees_include_estimates', money.fees_pending > 0,
    'outstanding_pence', calc.outstanding, 'credit_pence', calc.credit,
    'projected_net_pence', money.gross - money.refunded - money.fees_actual - money.fees_pending + calc.outstanding - calc.outstanding_fees,
    'shortfall_pence', greatest(s.pitch_cost_pence - (money.gross - money.refunded - money.fees_actual - money.fees_pending), 0),
    'covered', money.gross - money.refunded - money.fees_actual - money.fees_pending >= s.pitch_cost_pence,
    'paid_count', calc.paid_n, 'unpaid_count', calc.unpaid_n, 'stale_request_count', calc.stale,
    'stripe_payment_count', money.stripe_n, 'manual_payment_count', money.manual_n, 'needs_review_count', money.review_n)
  into result from calc, money;
  return result;
end $$;

revoke all on function public.session_shares(uuid), public.session_balances(uuid), public.session_totals(uuid) from public, anon, authenticated;
grant execute on function public.estimate_stripe_fee(integer, integer, integer), public.split_net_after_fees(integer, integer, integer, integer),
  public.session_allocation_total(integer, integer, text, integer, integer) to authenticated, service_role;

-- ------------------------------------------------------------------- helpers
create or replace function public.fin_audit(p_action text, p_target uuid, p_details jsonb) returns void
language sql security definer set search_path = public as $$
  insert into public.admin_audit_log(actor_id, target_id, action, details) values (auth.uid(), p_target, p_action, p_details)
$$;
revoke all on function public.fin_audit(text, uuid, jsonb) from public, anon, authenticated;

create or replace function public.require_permission(p_permission text) returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.has_permission(p_permission) then
    raise exception 'PERMISSION_DENIED: % is required', p_permission using errcode = '42501';
  end if;
end $$;
revoke all on function public.require_permission(text) from public, anon, authenticated;

-- True when money or a payment request already depends on this session's numbers.
create or replace function public.session_has_payment_activity(p_session uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.payment_requests where session_id = p_session and status not in ('CANCELLED','SUPERSEDED'))
      or exists (select 1 from public.payments where session_id = p_session and status = 'SUCCEEDED')
$$;
revoke all on function public.session_has_payment_activity(uuid) from public, anon, authenticated;

-- Re-derive a request's status after manual payments, voids or refunds.
create or replace function public.refresh_request_status(p_attendee uuid) returns void
language plpgsql security definer set search_path = public as $$
declare a public.session_attendees%rowtype; outstanding integer; req public.payment_requests%rowtype; has_active boolean;
begin
  select * into a from public.session_attendees where id = p_attendee;
  select b.outstanding_pence into outstanding from public.session_balances(a.session_id) b where b.attendee_id = p_attendee;
  select * into req from public.payment_requests where attendee_id = p_attendee and status in ('PENDING','FAILED') for update;
  has_active := found;
  if has_active and outstanding <= 0 then
    update public.payment_requests set status = case when exists (
        select 1 from public.payments where payment_request_id = req.id and status = 'SUCCEEDED' and method = 'STRIPE')
      then 'PAID' else 'MANUALLY_PAID' end, paid_at = now() where id = req.id;
  end if;
  -- A voided manual payment re-opens the most recent manually-settled request.
  if not has_active and outstanding > 0 then
    update public.payment_requests set status = 'PENDING', paid_at = null
    where id = (select id from public.payment_requests where attendee_id = p_attendee and status = 'MANUALLY_PAID'
                order by issued_at desc limit 1)
      and amount_pence = outstanding
      and (select status from public.pitch_sessions where id = a.session_id) <> 'CANCELLED';
  end if;
end $$;
revoke all on function public.refresh_request_status(uuid) from public, anon, authenticated;

create or replace function public.bump_calc_version(p_session uuid) returns void
language sql security definer set search_path = public as $$
  update public.pitch_sessions set calc_version = calc_version + 1 where id = p_session
$$;
revoke all on function public.bump_calc_version(uuid) from public, anon, authenticated;

-- -------------------------------------------------------- admin: permissions
create or replace function public.my_finance_permissions() returns text[]
language sql stable security definer set search_path = public as $$
  select case when auth.uid() is null then '{}'::text[]
    when public.is_owner() then array['sessions.manage','attendance.manage','payments.request','finance.view','payments.record_manual','payments.refund','settings.manage','owner']
    when public.is_admin() then coalesce((select array_agg(permission order by permission) from public.admin_permissions where profile_id = auth.uid()), '{}')
    else '{}'::text[] end
$$;

create or replace function public.set_admin_permission(p_target uuid, p_permission text, p_granted boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'PERMISSION_DENIED: only the Owner can change admin permissions' using errcode = '42501'; end if;
  if not exists (select 1 from public.profiles where id = p_target and role = 'ADMIN' and status = 'APPROVED' and not is_owner) then
    raise exception 'Permissions can only be given to approved Admins';
  end if;
  if p_granted then
    insert into public.admin_permissions(profile_id, permission, granted_by) values (p_target, p_permission, auth.uid()) on conflict do nothing;
  else
    delete from public.admin_permissions where profile_id = p_target and permission = p_permission;
  end if;
  perform public.fin_audit(case when p_granted then 'PERMISSION_GRANTED' else 'PERMISSION_REVOKED' end, p_target, jsonb_build_object('permission', p_permission));
end $$;

create or replace function public.update_payment_settings(p_fee_percent_bps integer, p_fee_fixed_pence integer, p_default_fee_mode text, p_stripe_mode text) returns void
language plpgsql security definer set search_path = public as $$
declare before public.payment_settings%rowtype;
begin
  perform public.require_permission('settings.manage');
  select * into before from public.payment_settings where id = 1 for update;
  if p_stripe_mode is distinct from before.stripe_mode and not public.is_owner() then
    raise exception 'PERMISSION_DENIED: only the Owner can switch Stripe between test and live' using errcode = '42501';
  end if;
  update public.payment_settings set fee_percent_bps = p_fee_percent_bps, fee_fixed_pence = p_fee_fixed_pence,
    default_fee_mode = p_default_fee_mode, stripe_mode = p_stripe_mode, updated_by = auth.uid(), updated_at = now() where id = 1;
  -- Shares in COVER_IN_PRICE sessions depend on the fee assumptions.
  update public.pitch_sessions set calc_version = calc_version + 1 where fee_mode = 'COVER_IN_PRICE' and status <> 'CANCELLED';
  perform public.fin_audit('PAYMENT_SETTINGS_CHANGED', null, jsonb_build_object(
    'before', jsonb_build_object('fee_percent_bps', before.fee_percent_bps, 'fee_fixed_pence', before.fee_fixed_pence, 'default_fee_mode', before.default_fee_mode, 'stripe_mode', before.stripe_mode),
    'after', jsonb_build_object('fee_percent_bps', p_fee_percent_bps, 'fee_fixed_pence', p_fee_fixed_pence, 'default_fee_mode', p_default_fee_mode, 'stripe_mode', p_stripe_mode)));
end $$;

-- ----------------------------------------------------------- admin: sessions
create or replace function public.create_pitch_session(p_title text, p_starts_at timestamptz, p_duration_minutes integer,
  p_venue_id uuid, p_venue_name text, p_pitch_name text, p_pitch_type text, p_pitch_cost_pence integer, p_fee_mode text,
  p_notes text, p_payment_deadline timestamptz, p_status text, p_match_id uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare new_id uuid;
begin
  perform public.require_permission('sessions.manage');
  if p_status not in ('PLANNING','OPEN','CONFIRMED') then raise exception 'A new session starts as planning, open or confirmed'; end if;
  -- Serialise creates so a double submit cannot make two identical sessions.
  perform pg_advisory_xact_lock(hashtext('pitch_session:' || p_starts_at::text));
  if exists (select 1 from public.pitch_sessions where starts_at = p_starts_at and status <> 'CANCELLED'
             and lower(trim(title)) = lower(trim(p_title)) and venue_id is not distinct from p_venue_id
             and lower(coalesce(pitch_name, '')) = lower(coalesce(nullif(trim(p_pitch_name), ''), ''))) then
    raise exception 'A session with this name, kick-off, venue and pitch already exists';
  end if;
  insert into public.pitch_sessions(title, starts_at, duration_minutes, venue_id, venue_name, pitch_name, pitch_type,
    pitch_cost_pence, fee_mode, notes, payment_deadline, status, match_id, created_by)
  values (trim(p_title), p_starts_at, p_duration_minutes, p_venue_id, nullif(trim(p_venue_name), ''), nullif(trim(p_pitch_name), ''),
    nullif(trim(p_pitch_type), ''), p_pitch_cost_pence, coalesce(p_fee_mode, (select default_fee_mode from public.payment_settings where id = 1)),
    nullif(trim(p_notes), ''), p_payment_deadline, p_status, p_match_id, auth.uid())
  returning id into new_id;
  perform public.fin_audit('SESSION_CREATED', new_id, jsonb_build_object('title', trim(p_title), 'pitch_cost_pence', p_pitch_cost_pence, 'fee_mode', p_fee_mode));
  return new_id;
end $$;

create or replace function public.update_pitch_session(p_session uuid, p_title text, p_starts_at timestamptz, p_duration_minutes integer,
  p_venue_id uuid, p_venue_name text, p_pitch_name text, p_pitch_type text, p_pitch_cost_pence integer, p_fee_mode text,
  p_notes text, p_payment_deadline timestamptz, p_match_id uuid, p_confirm_payment_impact boolean default false) returns void
language plpgsql security definer set search_path = public as $$
declare s public.pitch_sessions%rowtype; money_changed boolean;
begin
  perform public.require_permission('sessions.manage');
  select * into s from public.pitch_sessions where id = p_session for update;
  if not found then raise exception 'Session not found'; end if;
  if s.status = 'CANCELLED' then raise exception 'A cancelled session cannot be edited'; end if;
  money_changed := p_pitch_cost_pence is distinct from s.pitch_cost_pence or p_fee_mode is distinct from s.fee_mode;
  if money_changed and public.session_has_payment_activity(p_session) and not p_confirm_payment_impact then
    raise exception 'CONFIRM_REQUIRED: payment requests or payments already exist for this session. Issued amounts will not change automatically; you will need to review and reissue them.';
  end if;
  update public.pitch_sessions set title = trim(p_title), starts_at = p_starts_at, duration_minutes = p_duration_minutes,
    venue_id = p_venue_id, venue_name = nullif(trim(p_venue_name), ''), pitch_name = nullif(trim(p_pitch_name), ''),
    pitch_type = nullif(trim(p_pitch_type), ''), pitch_cost_pence = p_pitch_cost_pence, fee_mode = p_fee_mode,
    notes = nullif(trim(p_notes), ''), payment_deadline = p_payment_deadline, match_id = p_match_id,
    calc_version = calc_version + money_changed::integer
  where id = p_session;
  if p_payment_deadline is distinct from s.payment_deadline then
    update public.payment_requests set due_at = p_payment_deadline where session_id = p_session and status in ('PENDING','FAILED');
  end if;
  if money_changed then
    perform public.fin_audit('SESSION_PRICE_CHANGED', p_session, jsonb_build_object('title', s.title,
      'before_pence', s.pitch_cost_pence, 'after_pence', p_pitch_cost_pence, 'before_fee_mode', s.fee_mode, 'after_fee_mode', p_fee_mode,
      'confirmed_with_payments', p_confirm_payment_impact));
  else
    perform public.fin_audit('SESSION_UPDATED', p_session, jsonb_build_object('title', trim(p_title)));
  end if;
end $$;

create or replace function public.set_pitch_session_status(p_session uuid, p_status text, p_reason text default null) returns void
language plpgsql security definer set search_path = public as $$
declare s public.pitch_sessions%rowtype; closed integer;
begin
  perform public.require_permission('sessions.manage');
  select * into s from public.pitch_sessions where id = p_session for update;
  if not found then raise exception 'Session not found'; end if;
  if s.status = 'CANCELLED' then raise exception 'A cancelled session cannot be reopened'; end if;
  if p_status not in ('PLANNING','OPEN','CONFIRMED','COMPLETED','CANCELLED') then raise exception 'Unknown session status'; end if;
  if p_status = 'CANCELLED' and char_length(trim(coalesce(p_reason, ''))) = 0 then raise exception 'Give a reason for cancelling'; end if;
  update public.pitch_sessions set status = p_status, cancelled_reason = case when p_status = 'CANCELLED' then trim(p_reason) end where id = p_session;
  if p_status = 'CANCELLED' then
    -- Unpaid requests can no longer be paid. Money already received stays recorded and shows as refund due.
    update public.payment_requests set status = 'CANCELLED', closed_reason = 'Session cancelled'
    where session_id = p_session and status in ('PENDING','FAILED');
    get diagnostics closed = row_count;
  end if;
  perform public.fin_audit('SESSION_STATUS_CHANGED', p_session, jsonb_build_object('title', s.title, 'before', s.status, 'after', p_status,
    'reason', p_reason, 'requests_cancelled', coalesce(closed, 0)));
end $$;

-- --------------------------------------------------------- admin: attendance
create or replace function public.add_session_attendee(p_session uuid, p_profile uuid, p_guest_name text, p_attendance text,
  p_confirm_payment_impact boolean default false) returns uuid
language plpgsql security definer set search_path = public as $$
declare s public.pitch_sessions%rowtype; name text; new_id uuid;
begin
  perform public.require_permission('attendance.manage');
  select * into s from public.pitch_sessions where id = p_session for update;
  if not found then raise exception 'Session not found'; end if;
  if s.status in ('CANCELLED','COMPLETED') then raise exception 'Attendance is closed for this session'; end if;
  if p_attendance not in ('CONFIRMED','UNCONFIRMED') then raise exception 'New attendees are confirmed or unconfirmed'; end if;
  if p_profile is not null then
    select coalesce(nullif(trim(nickname), ''), full_name) into name from public.profiles where id = p_profile and status = 'APPROVED';
    if name is null then raise exception 'Only approved members can be added'; end if;
  else
    name := trim(coalesce(p_guest_name, ''));
    if name = '' then raise exception 'Enter a guest name'; end if;
  end if;
  if p_attendance = 'CONFIRMED' and public.session_has_payment_activity(p_session) and not p_confirm_payment_impact then
    raise exception 'CONFIRM_REQUIRED: payments have started for this session. Adding a confirmed player changes everyone''s share; existing requests keep their amounts until you reissue them.';
  end if;
  begin
    insert into public.session_attendees(session_id, profile_id, display_name, attendance, added_by)
    values (p_session, p_profile, name, p_attendance, auth.uid()) returning id into new_id;
  exception when unique_violation then
    raise exception 'That person is already on this session';
  end;
  if p_attendance = 'CONFIRMED' then perform public.bump_calc_version(p_session); end if;
  perform public.fin_audit('ATTENDEE_ADDED', p_session, jsonb_build_object('title', s.title, 'attendee', name, 'attendance', p_attendance));
  return new_id;
end $$;

create or replace function public.update_session_attendee(p_attendee uuid, p_attendance text, p_chargeable boolean, p_note text,
  p_confirm_payment_impact boolean default false) returns void
language plpgsql security definer set search_path = public as $$
declare a public.session_attendees%rowtype; s public.pitch_sessions%rowtype; was_counted boolean; now_counted boolean;
begin
  perform public.require_permission('attendance.manage');
  select * into a from public.session_attendees where id = p_attendee;
  if not found then raise exception 'Attendee not found'; end if;
  select * into s from public.pitch_sessions where id = a.session_id for update;
  if s.status = 'CANCELLED' then raise exception 'This session is cancelled'; end if;
  if p_attendance not in ('CONFIRMED','UNCONFIRMED','CANCELLED') then raise exception 'Unknown attendance status'; end if;
  was_counted := a.attendance = 'CONFIRMED' and a.chargeable;
  now_counted := p_attendance = 'CONFIRMED' and p_chargeable;
  if was_counted <> now_counted and public.session_has_payment_activity(a.session_id) and not p_confirm_payment_impact then
    raise exception 'CONFIRM_REQUIRED: payments have started for this session. This changes who shares the cost; issued amounts stay as they are until you review and reissue.';
  end if;
  update public.session_attendees set attendance = p_attendance, chargeable = p_chargeable, note = nullif(trim(p_note), '') where id = p_attendee;
  if was_counted <> now_counted then perform public.bump_calc_version(a.session_id); end if;
  perform public.fin_audit('ATTENDANCE_CHANGED', a.session_id, jsonb_build_object('title', s.title, 'attendee', a.display_name,
    'before', a.attendance, 'after', p_attendance, 'chargeable_before', a.chargeable, 'chargeable_after', p_chargeable));
end $$;

-- Copy the Playing list from an existing CAFF match as confirmed attendees.
create or replace function public.import_match_attendees(p_session uuid, p_match uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare s public.pitch_sessions%rowtype; added integer;
begin
  perform public.require_permission('attendance.manage');
  select * into s from public.pitch_sessions where id = p_session for update;
  if not found or s.status in ('CANCELLED','COMPLETED') then raise exception 'Attendance is closed for this session'; end if;
  if public.session_has_payment_activity(p_session) then raise exception 'Payments have started; add players individually instead'; end if;
  insert into public.session_attendees(session_id, profile_id, display_name, attendance, added_by)
  select p_session, p.id, coalesce(nullif(trim(p.nickname), ''), p.full_name), 'CONFIRMED', auth.uid()
  from public.match_availability ma join public.profiles p on p.id = ma.player_id
  where ma.match_id = p_match and ma.status = 'PLAYING' and p.status = 'APPROVED'
  on conflict do nothing;
  get diagnostics added = row_count;
  if added > 0 then perform public.bump_calc_version(p_session); end if;
  update public.pitch_sessions set match_id = coalesce(match_id, p_match) where id = p_session;
  perform public.fin_audit('ATTENDEES_IMPORTED', p_session, jsonb_build_object('title', s.title, 'match_id', p_match, 'added', added));
  return added;
end $$;

-- ----------------------------------------------------- admin: payment requests
-- Creates one request per confirmed attendee for what they still owe, using the
-- server's own calculation. p_expected_version must match the version the admin
-- reviewed, so a stale screen cannot issue amounts nobody looked at. Existing
-- requests whose amount would change are only replaced with p_confirm_changes.
create or replace function public.issue_payment_requests(p_session uuid, p_expected_version integer, p_confirm_changes boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.pitch_sessions%rowtype; t jsonb; b record; created integer := 0; replaced integer := 0; closed integer := 0;
  unchanged integer := 0; pending_changes integer := 0; too_small integer := 0; new_id uuid; snapshot jsonb;
begin
  perform public.require_permission('payments.request');
  select * into s from public.pitch_sessions where id = p_session for update;
  if not found then raise exception 'Session not found'; end if;
  if s.status not in ('OPEN','CONFIRMED','COMPLETED') then raise exception 'Open or confirm the session before requesting payment'; end if;
  if s.calc_version <> p_expected_version then raise exception 'STALE: the session changed since you loaded it. Refresh and review the amounts again.'; end if;
  t := public.session_totals(p_session);
  for b in select bl.*, a.display_name from public.session_balances(p_session) bl join public.session_attendees a on a.id = bl.attendee_id order by a.display_name loop
    if b.active_request_id is not null and b.active_request_pence = b.outstanding_pence then unchanged := unchanged + 1; continue; end if;
    if b.active_request_id is null and b.outstanding_pence <= 0 then continue; end if;
    if b.outstanding_pence > 0 and b.outstanding_pence < 30 then too_small := too_small + 1; continue; end if;
    if b.active_request_id is not null then
      if not p_confirm_changes then pending_changes := pending_changes + 1; continue; end if;
      update public.payment_requests set status = case when b.outstanding_pence > 0 then 'SUPERSEDED' else 'CANCELLED' end,
        closed_reason = case when b.outstanding_pence > 0 then 'Amount changed after attendance or price change' else 'No longer owed' end
      where id = b.active_request_id;
      if b.outstanding_pence <= 0 then closed := closed + 1; continue; end if;
    end if;
    snapshot := jsonb_build_object('pitch_cost_pence', t->'pitch_cost_pence', 'allocation_total_pence', t->'allocation_total_pence',
      'chargeable_count', t->'chargeable_count', 'base_share_pence', t->'base_share_pence', 'fee_mode', t->'fee_mode',
      'share_pence', b.share_pence, 'extra_penny', b.extra_penny, 'already_paid_pence', b.paid_pence - b.refunded_pence,
      'fee_percent_bps', t->'fee_percent_bps', 'fee_fixed_pence', t->'fee_fixed_pence');
    insert into public.payment_requests(session_id, attendee_id, amount_pence, calc_version, calculation, due_at, issued_by)
    values (p_session, b.attendee_id, b.outstanding_pence, s.calc_version, snapshot, s.payment_deadline, auth.uid()) returning id into new_id;
    if b.active_request_id is not null then
      update public.payment_requests set superseded_by = new_id where id = b.active_request_id;
      replaced := replaced + 1;
    else created := created + 1; end if;
  end loop;
  if pending_changes > 0 then
    raise exception 'CONFIRM_REQUIRED: % existing payment request(s) would change amount. The old links will stop working and the new amounts will be issued.', pending_changes;
  end if;
  perform public.fin_audit('PAYMENT_REQUESTS_ISSUED', p_session, jsonb_build_object('title', s.title, 'created', created,
    'replaced', replaced, 'closed', closed, 'unchanged', unchanged, 'below_minimum', too_small, 'calc_version', s.calc_version,
    'allocation_total_pence', t->'allocation_total_pence', 'chargeable_count', t->'chargeable_count'));
  return jsonb_build_object('created', created, 'replaced', replaced, 'closed', closed, 'unchanged', unchanged, 'below_minimum', too_small);
end $$;

create or replace function public.cancel_payment_request(p_request uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare r public.payment_requests%rowtype;
begin
  perform public.require_permission('payments.request');
  select * into r from public.payment_requests where id = p_request for update;
  if not found or r.status not in ('PENDING','FAILED') then raise exception 'Only an unpaid request can be cancelled'; end if;
  if char_length(trim(coalesce(p_reason, ''))) = 0 then raise exception 'Give a reason'; end if;
  update public.payment_requests set status = 'CANCELLED', closed_reason = trim(p_reason) where id = p_request;
  perform public.fin_audit('PAYMENT_REQUEST_CANCELLED', r.session_id, jsonb_build_object('request_id', p_request, 'amount_pence', r.amount_pence, 'reason', trim(p_reason)));
end $$;

-- ---------------------------------------------------------- admin: manual money
create or replace function public.record_manual_payment(p_attendee uuid, p_amount_pence integer, p_method text, p_received_on date,
  p_reference text, p_notes text, p_client_token uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare a public.session_attendees%rowtype; s public.pitch_sessions%rowtype; existing uuid; new_id uuid; req uuid;
begin
  perform public.require_permission('payments.record_manual');
  select id into existing from public.payments where client_token = p_client_token;
  if existing is not null then return existing; end if;   -- double submit: same record
  if p_method not in ('BANK_TRANSFER','CASH','OTHER') then raise exception 'Choose bank transfer, cash or other'; end if;
  if p_amount_pence is null or p_amount_pence <= 0 then raise exception 'Enter an amount above zero'; end if;
  if p_received_on is null or p_received_on > current_date + 1 then raise exception 'Enter the date the money was received'; end if;
  select * into a from public.session_attendees where id = p_attendee;
  if not found then raise exception 'Attendee not found'; end if;
  select * into s from public.pitch_sessions where id = a.session_id for update;
  select id into req from public.payment_requests where attendee_id = p_attendee and status in ('PENDING','FAILED');
  insert into public.payments(session_id, attendee_id, payment_request_id, method, amount_pence, received_at, reference, notes, client_token, recorded_by)
  values (a.session_id, p_attendee, req, p_method, p_amount_pence, p_received_on::timestamptz, nullif(trim(p_reference), ''), nullif(trim(p_notes), ''), p_client_token, auth.uid())
  returning id into new_id;
  perform public.refresh_request_status(p_attendee);
  perform public.fin_audit('MANUAL_PAYMENT_RECORDED', a.session_id, jsonb_build_object('title', s.title, 'payment_id', new_id,
    'attendee', a.display_name, 'amount_pence', p_amount_pence, 'method', p_method, 'received_on', p_received_on, 'reference', nullif(trim(p_reference), '')));
  return new_id;
end $$;

-- Corrections never delete: the original row is kept and marked VOID with a reason.
create or replace function public.void_manual_payment(p_payment uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare p public.payments%rowtype;
begin
  perform public.require_permission('payments.record_manual');
  select * into p from public.payments where id = p_payment for update;
  if not found or p.status <> 'SUCCEEDED' then raise exception 'Payment not found or already voided'; end if;
  if p.method = 'STRIPE' then raise exception 'Stripe payments are corrected by refunding them'; end if;
  if p.refunded_pence > 0 then raise exception 'This payment has refunds recorded against it'; end if;
  if char_length(trim(coalesce(p_reason, ''))) = 0 then raise exception 'Give a reason for the correction'; end if;
  update public.payments set status = 'VOID', voided_at = now(), voided_by = auth.uid(), void_reason = trim(p_reason) where id = p_payment;
  perform public.refresh_request_status(p.attendee_id);
  perform public.fin_audit('MANUAL_PAYMENT_VOIDED', p.session_id, jsonb_build_object('payment_id', p_payment, 'amount_pence', p.amount_pence,
    'method', p.method, 'reason', trim(p_reason)));
end $$;

-- Money handed back outside Stripe (cash or bank transfer), against any payment.
create or replace function public.record_manual_refund(p_payment uuid, p_amount_pence integer, p_reason text, p_client_token uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare p public.payments%rowtype; pending integer; existing uuid; new_id uuid;
begin
  perform public.require_permission('payments.refund');
  select id into existing from public.payment_refunds where client_token = p_client_token;
  if existing is not null then return existing; end if;
  select * into p from public.payments where id = p_payment for update;
  if not found or p.status <> 'SUCCEEDED' then raise exception 'Payment not found'; end if;
  if p.method = 'STRIPE' then raise exception 'Refund card payments through Stripe so the player gets their money back on the card'; end if;
  select coalesce(sum(amount_pence), 0) into pending from public.payment_refunds where payment_id = p_payment and status = 'PENDING';
  if p_amount_pence <= 0 or p_amount_pence > p.amount_pence - p.refunded_pence - pending then raise exception 'Refund is more than the amount left on this payment'; end if;
  insert into public.payment_refunds(payment_id, amount_pence, method, status, reason, client_token, requested_by, completed_at)
  values (p_payment, p_amount_pence, 'MANUAL', 'SUCCEEDED', trim(p_reason), p_client_token, auth.uid(), now()) returning id into new_id;
  update public.payments set refunded_pence = refunded_pence + p_amount_pence where id = p_payment;
  perform public.refresh_request_status(p.attendee_id);
  perform public.fin_audit('MANUAL_REFUND_RECORDED', p.session_id, jsonb_build_object('payment_id', p_payment, 'refund_id', new_id,
    'amount_pence', p_amount_pence, 'reason', trim(p_reason)));
  return new_id;
end $$;

-- Step 1 of a Stripe refund, called by the payments Lambda with the admin's own
-- JWT (so permission checks use auth.uid()). The Lambda then calls Stripe with
-- the returned refund id as idempotency key and finishes with refund_attach.
create or replace function public.refund_begin(p_payment uuid, p_amount_pence integer, p_reason text, p_client_token uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p public.payments%rowtype; pending integer; r public.payment_refunds%rowtype;
begin
  perform public.require_permission('payments.refund');
  select * into r from public.payment_refunds where client_token = p_client_token;
  if found then
    select * into p from public.payments where id = r.payment_id;
    return jsonb_build_object('refund_id', r.id, 'payment_intent', p.stripe_payment_intent_id, 'amount_pence', r.amount_pence, 'status', r.status, 'livemode', p.livemode);
  end if;
  select * into p from public.payments where id = p_payment for update;
  if not found or p.status <> 'SUCCEEDED' or p.method <> 'STRIPE' then raise exception 'Only a successful Stripe payment can be refunded through Stripe'; end if;
  if char_length(trim(coalesce(p_reason, ''))) = 0 then raise exception 'Give a reason for the refund'; end if;
  select coalesce(sum(amount_pence), 0) into pending from public.payment_refunds where payment_id = p_payment and status = 'PENDING';
  if p_amount_pence is null or p_amount_pence <= 0 or p_amount_pence > p.amount_pence - p.refunded_pence - pending then
    raise exception 'Refund is more than the amount left on this payment';
  end if;
  insert into public.payment_refunds(payment_id, amount_pence, method, reason, client_token, requested_by)
  values (p_payment, p_amount_pence, 'STRIPE', trim(p_reason), p_client_token, auth.uid()) returning * into r;
  perform public.fin_audit('STRIPE_REFUND_REQUESTED', p.session_id, jsonb_build_object('payment_id', p_payment, 'refund_id', r.id,
    'amount_pence', p_amount_pence, 'reason', trim(p_reason)));
  return jsonb_build_object('refund_id', r.id, 'payment_intent', p.stripe_payment_intent_id, 'amount_pence', r.amount_pence, 'status', r.status, 'livemode', p.livemode);
end $$;

-- ------------------------------------------------------------- admin: reads
create or replace function public.session_permission_view() returns boolean
language sql stable security definer set search_path = public as $$
  select public.has_permission('sessions.manage') or public.has_permission('attendance.manage') or public.has_permission('finance.view')
$$;
revoke all on function public.session_permission_view() from public, anon, authenticated;

create or replace function public.get_pitch_sessions(p_scope text default 'upcoming') returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare finance boolean := public.has_permission('finance.view');
begin
  if not public.session_permission_view() then raise exception 'PERMISSION_DENIED' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(item order by (item->>'starts_at') desc) from (
    select to_jsonb(s) - 'created_by'
      || jsonb_build_object('venue', (select jsonb_build_object('name', v.name, 'address', v.address, 'pitch', v.pitch) from public.venues v where v.id = s.venue_id),
         'confirmed_count', (select count(*) from public.session_attendees a where a.session_id = s.id and a.attendance = 'CONFIRMED'),
         'totals', case when finance then public.session_totals(s.id)
           else public.session_totals(s.id) - array['gross_received_pence','refunded_pence','fees_actual_pence','fees_estimated_unconfirmed_pence',
             'net_received_pence','outstanding_pence','credit_pence','projected_net_pence','shortfall_pence','covered','paid_count','unpaid_count',
             'stripe_payment_count','manual_payment_count','needs_review_count'] end) item
    from public.pitch_sessions s
    where case p_scope
      when 'upcoming' then s.status not in ('COMPLETED','CANCELLED') and s.starts_at >= now() - interval '1 day'
      when 'past' then s.status not in ('COMPLETED','CANCELLED') and s.starts_at < now() - interval '1 day'
      when 'completed' then s.status = 'COMPLETED'
      when 'cancelled' then s.status = 'CANCELLED'
      when 'outstanding' then s.status <> 'CANCELLED' and (public.session_totals(s.id)->>'outstanding_pence')::integer > 0
      else true end
    ) x), '[]'::jsonb);
end $$;

create or replace function public.get_pitch_session(p_session uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare finance boolean := public.has_permission('finance.view'); s public.pitch_sessions%rowtype;
begin
  if not public.session_permission_view() then raise exception 'PERMISSION_DENIED' using errcode = '42501'; end if;
  select * into s from public.pitch_sessions where id = p_session;
  if not found then return null; end if;
  return jsonb_build_object(
    'session', to_jsonb(s) || jsonb_build_object('venue', (select to_jsonb(v) from public.venues v where v.id = s.venue_id)),
    'totals', public.session_totals(p_session),
    'attendees', coalesce((select jsonb_agg(to_jsonb(a) || jsonb_build_object('share_pence', b.share_pence, 'extra_penny', b.extra_penny,
        'paid_pence', case when finance then b.paid_pence end, 'refunded_pence', case when finance then b.refunded_pence end,
        'outstanding_pence', case when finance then b.outstanding_pence end,
        'active_request_id', case when finance then b.active_request_id end, 'active_request_pence', case when finance then b.active_request_pence end)
      order by a.attendance, lower(a.display_name))
      from public.session_attendees a join public.session_balances(p_session) b on b.attendee_id = a.id where a.session_id = p_session), '[]'::jsonb),
    'requests', case when finance then coalesce((select jsonb_agg(to_jsonb(r) || jsonb_build_object('checkouts',
        (select coalesce(jsonb_agg(jsonb_build_object('attempt', c.attempt, 'status', c.status, 'expires_at', c.expires_at, 'created_at', c.created_at) order by c.attempt), '[]'::jsonb)
         from public.payment_request_checkouts c where c.request_id = r.id)) order by r.issued_at desc)
      from public.payment_requests r where r.session_id = p_session), '[]'::jsonb) end,
    'payments', case when finance then coalesce((select jsonb_agg(to_jsonb(p) - 'client_token' || jsonb_build_object(
        'recorded_by_name', (select full_name from public.profiles where id = p.recorded_by),
        'refunds', (select coalesce(jsonb_agg(to_jsonb(rf) - 'client_token' order by rf.created_at), '[]'::jsonb) from public.payment_refunds rf where rf.payment_id = p.id))
      order by p.received_at desc) from public.payments p where p.session_id = p_session), '[]'::jsonb) end,
    'audit', case when finance then coalesce((select jsonb_agg(jsonb_build_object('action', l.action, 'details', l.details, 'created_at', l.created_at,
        'actor', (select full_name from public.profiles where id = l.actor_id)) order by l.created_at desc)
      from (select * from public.admin_audit_log where target_id = p_session order by created_at desc limit 100) l), '[]'::jsonb) end,
    'can', jsonb_build_object('finance', finance, 'sessions', public.has_permission('sessions.manage'),
      'attendance', public.has_permission('attendance.manage'), 'request', public.has_permission('payments.request'),
      'manual', public.has_permission('payments.record_manual'), 'refund', public.has_permission('payments.refund')));
end $$;

-- Open Stripe Checkout sessions whose request can no longer be paid (Lambda expires them).
create or replace function public.admin_checkouts_to_expire(p_session uuid) returns text[]
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_permission('payments.request');
  return coalesce((select array_agg(c.checkout_session_id) from public.payment_request_checkouts c
    join public.payment_requests r on r.id = c.request_id
    where r.session_id = p_session and c.status = 'OPEN' and c.expires_at > now() and r.status not in ('PENDING','FAILED')), '{}');
end $$;

create or replace function public.admin_fees_to_reconcile(p_session uuid) returns text[]
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_permission('finance.view');
  return coalesce((select array_agg(stripe_payment_intent_id) from public.payments
    where session_id = p_session and method = 'STRIPE' and status = 'SUCCEEDED' and fee_actual_pence is null), '{}');
end $$;

-- Signed-in player's own open requests (dashboard card).
create or replace function public.my_payment_requests() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'amount_pence', r.amount_pence, 'status', r.status, 'due_at', r.due_at,
    'title', s.title, 'starts_at', s.starts_at) order by s.starts_at), '[]'::jsonb)
  from public.payment_requests r join public.session_attendees a on a.id = r.attendee_id join public.pitch_sessions s on s.id = r.session_id
  where a.profile_id = auth.uid() and public.is_approved() and r.status in ('PENDING','FAILED') and s.status <> 'CANCELLED'
$$;

-- ------------------------------------------------------ service_role: Stripe
-- Limited, non-personal summary for the public pay page (first name only).
create or replace function public.payment_request_public(p_request uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', r.id, 'status', r.status, 'amount_pence', r.amount_pence, 'currency', 'gbp', 'due_at', r.due_at,
    'payable', r.status in ('PENDING','FAILED') and s.status <> 'CANCELLED',
    'player', split_part(a.display_name, ' ', 1), 'title', s.title, 'starts_at', s.starts_at, 'duration_minutes', s.duration_minutes,
    'venue', coalesce(v.name, s.venue_name), 'pitch', s.pitch_name, 'session_status', s.status,
    'superseded_by', case when r.status = 'SUPERSEDED' then r.superseded_by end)
  from public.payment_requests r join public.session_attendees a on a.id = r.attendee_id
  join public.pitch_sessions s on s.id = r.session_id left join public.venues v on v.id = s.venue_id
  where r.id = p_request
$$;

-- Serialises checkout creation per request. Returns an open Checkout URL to reuse,
-- or a reserved attempt (with fixed expiry) whose Stripe idempotency key and
-- parameters are identical for concurrent callers, so only one session is made.
create or replace function public.checkout_prepare(p_request uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.payment_requests%rowtype; s public.pitch_sessions%rowtype; c public.payment_request_checkouts%rowtype; next_attempt integer; v_exp timestamptz; owed integer;
begin
  select * into r from public.payment_requests where id = p_request for update;
  if not found then return jsonb_build_object('payable', false, 'reason', 'not_found'); end if;
  select * into s from public.pitch_sessions where id = r.session_id;
  if r.status not in ('PENDING','FAILED') or s.status = 'CANCELLED' then
    return jsonb_build_object('payable', false, 'reason', lower(case when s.status = 'CANCELLED' then 'session_cancelled' else r.status end));
  end if;
  -- Never take more than is currently owed (e.g. after a cash part-payment or a
  -- cheaper split): the admin must review and reissue first.
  select b.outstanding_pence into owed from public.session_balances(r.session_id) b where b.attendee_id = r.attendee_id;
  if r.amount_pence > coalesce(owed, 0) then return jsonb_build_object('payable', false, 'reason', 'needs_review'); end if;
  select * into c from public.payment_request_checkouts where request_id = p_request order by attempt desc limit 1;
  if found and c.status = 'OPEN' and c.expires_at > now() + interval '5 minutes' and c.amount_pence = r.amount_pence then
    return jsonb_build_object('payable', true, 'reuse_url', c.checkout_url, 'stripe_mode', (select stripe_mode from public.payment_settings where id = 1));
  end if;
  if found and c.status = 'CREATING' and c.created_at > now() - interval '2 minutes' then
    next_attempt := c.attempt; v_exp := c.expires_at;
  else
    next_attempt := coalesce(c.attempt, 0) + 1;
    v_exp := date_trunc('second', now()) + interval '60 minutes';
    insert into public.payment_request_checkouts(request_id, attempt, amount_pence, expires_at) values (p_request, next_attempt, r.amount_pence, v_exp);
  end if;
  return jsonb_build_object('payable', true, 'attempt', next_attempt, 'expires_at', extract(epoch from v_exp)::bigint,
    'amount_pence', r.amount_pence, 'currency', 'gbp', 'request_id', r.id, 'session_id', r.session_id, 'attendee_id', r.attendee_id,
    'description', s.title || ' · ' || to_char(s.starts_at at time zone 'Europe/London', 'Dy DD Mon YYYY HH24:MI'),
    'stripe_mode', (select stripe_mode from public.payment_settings where id = 1));
end $$;

create or replace function public.checkout_attach(p_request uuid, p_attempt integer, p_checkout_id text, p_url text, p_livemode boolean) returns void
language sql security definer set search_path = public as $$
  update public.payment_request_checkouts set status = 'OPEN', checkout_session_id = p_checkout_id, checkout_url = p_url, livemode = p_livemode
  where request_id = p_request and attempt = p_attempt and status in ('CREATING','OPEN')
$$;

create or replace function public.checkout_mark_expired(p_checkout_id text) returns void
language sql security definer set search_path = public as $$
  update public.payment_request_checkouts set status = 'EXPIRED' where checkout_session_id = p_checkout_id and status in ('CREATING','OPEN')
$$;

create or replace function public.refund_attach(p_refund uuid, p_stripe_refund_id text, p_status text, p_error text) returns void
language plpgsql security definer set search_path = public as $$
declare r public.payment_refunds%rowtype;
begin
  select * into r from public.payment_refunds where id = p_refund for update;
  if not found or r.status <> 'PENDING' then return; end if;
  update public.payment_refunds set stripe_refund_id = coalesce(p_stripe_refund_id, stripe_refund_id),
    status = case p_status when 'succeeded' then 'SUCCEEDED' when 'failed' then 'FAILED' when 'canceled' then 'FAILED' else 'PENDING' end,
    error = left(p_error, 300), completed_at = case when p_status in ('succeeded','failed','canceled') then now() end
  where id = p_refund;
  if p_status = 'succeeded' then
    update public.payments set refunded_pence = least(amount_pence, (select coalesce(sum(amount_pence), 0) from public.payment_refunds where payment_id = r.payment_id and status = 'SUCCEEDED'))
    where id = r.payment_id;
    update public.payment_requests set status = 'REFUNDED' where id = (select payment_request_id from public.payments where id = r.payment_id)
      and status = 'PAID' and (select refunded_pence = amount_pence from public.payments where id = r.payment_id);
  end if;
end $$;

create or replace function public.payment_set_actual_fee(p_payment_intent text, p_charge text, p_balance_txn text, p_fee integer) returns boolean
language sql security definer set search_path = public as $$
  with u as (update public.payments set fee_actual_pence = p_fee, stripe_charge_id = coalesce(p_charge, stripe_charge_id),
    stripe_balance_transaction_id = p_balance_txn where stripe_payment_intent_id = p_payment_intent and fee_actual_pence is null returning 1)
  select exists (select 1 from u)
$$;

-- Applies one verified Stripe event exactly once. p_extra carries the actual fee
-- details the Lambda fetched from Stripe: {fee, balance_transaction, charge}.
create or replace function public.stripe_apply_event(p_event_id text, p_type text, p_livemode boolean, p_object jsonb, p_extra jsonb default '{}')
returns text language plpgsql security definer set search_path = public as $$
declare v_result text; mode text; c public.payment_request_checkouts%rowtype; r public.payment_requests%rowtype;
  amount integer; pay_id uuid; review text; p public.payments%rowtype; cfg public.payment_settings%rowtype; rf_status text; rf_id uuid;
begin
  begin
    insert into public.stripe_events(id, type, livemode, object_id, result) values (p_event_id, p_type, p_livemode, p_object->>'id', 'processing');
  exception when unique_violation then
    return 'duplicate';
  end;
  select * into cfg from public.payment_settings where id = 1;
  mode := case when p_livemode then 'live' else 'test' end;
  if mode <> cfg.stripe_mode then
    update public.stripe_events set result = 'ignored_mode_mismatch' where id = p_event_id; return 'ignored_mode_mismatch';
  end if;

  if p_type in ('checkout.session.completed','checkout.session.async_payment_succeeded') then
    if p_object->>'payment_status' <> 'paid' then v_result := 'awaiting_payment';
    else
      select * into c from public.payment_request_checkouts where checkout_session_id = p_object->>'id' for update;
      if not found then v_result := 'unmatched_checkout';
      else
        select * into r from public.payment_requests where id = c.request_id for update;
        amount := (p_object->>'amount_total')::integer;
        review := case
          when p_object->'metadata'->>'payment_request_id' is distinct from r.id::text or p_object->>'client_reference_id' is distinct from r.id::text then 'Stripe metadata did not match the request'
          when lower(p_object->>'currency') <> 'gbp' then 'Paid in an unexpected currency'
          when amount <> c.amount_pence or amount <> r.amount_pence then 'Amount paid differs from the request'
          when r.status not in ('PENDING','FAILED') then 'Paid after the request was ' || lower(r.status) end;
        insert into public.payments(session_id, attendee_id, payment_request_id, method, amount_pence, received_at, fee_estimated_pence,
          fee_actual_pence, stripe_payment_intent_id, stripe_checkout_session_id, stripe_charge_id, stripe_balance_transaction_id,
          livemode, needs_review, review_note)
        values (r.session_id, r.attendee_id, r.id, 'STRIPE', amount, now(),
          public.estimate_stripe_fee(amount, cfg.fee_percent_bps, cfg.fee_fixed_pence), (p_extra->>'fee')::integer,
          p_object->>'payment_intent', p_object->>'id', p_extra->>'charge', p_extra->>'balance_transaction', p_livemode, review is not null, review)
        on conflict do nothing returning id into pay_id;
        update public.payment_request_checkouts set status = 'COMPLETED' where request_id = c.request_id and attempt = c.attempt;
        if pay_id is null then v_result := 'payment_already_recorded';
        elsif review is null then
          update public.payment_requests set status = 'PAID', paid_at = now(), last_error = null where id = r.id;
          v_result := 'paid';
        else v_result := 'paid_needs_review'; end if;
      end if;
    end if;

  elsif p_type = 'checkout.session.expired' then
    perform public.checkout_mark_expired(p_object->>'id'); v_result := 'checkout_expired';

  elsif p_type in ('checkout.session.async_payment_failed','payment_intent.payment_failed') then
    update public.payment_requests set status = 'FAILED',
      last_error = left(coalesce(p_object->'last_payment_error'->>'message', 'Payment failed'), 300)
    where id::text = coalesce(p_object->'metadata'->>'payment_request_id', '') and status in ('PENDING','FAILED');
    v_result := case when found then 'marked_failed' else 'failed_unmatched' end;
    if p_type = 'checkout.session.async_payment_failed' then
      update public.payment_request_checkouts set status = 'FAILED' where checkout_session_id = p_object->>'id';
    end if;

  elsif p_type in ('refund.created','refund.updated','refund.failed') then
    select * into p from public.payments where stripe_payment_intent_id = p_object->>'payment_intent' for update;
    if not found then v_result := 'unmatched_refund';
    else
      rf_status := case p_object->>'status' when 'succeeded' then 'SUCCEEDED' when 'failed' then 'FAILED' when 'canceled' then 'FAILED' else 'PENDING' end;
      update public.payment_refunds set stripe_refund_id = p_object->>'id', status = rf_status,
        completed_at = case when rf_status <> 'PENDING' then now() end, error = left(p_object->>'failure_reason', 300)
      where payment_id = p.id and (stripe_refund_id = p_object->>'id' or (stripe_refund_id is null and id::text = coalesce(p_object->'metadata'->>'refund_id', '')))
      returning id into rf_id;
      if rf_id is null then  -- refund made directly in the Stripe dashboard
        insert into public.payment_refunds(payment_id, amount_pence, method, status, stripe_refund_id, reason, completed_at)
        values (p.id, (p_object->>'amount')::integer, 'STRIPE', rf_status, p_object->>'id', 'Refunded in the Stripe dashboard', case when rf_status <> 'PENDING' then now() end)
        on conflict (stripe_refund_id) do update set status = excluded.status, completed_at = excluded.completed_at;
      end if;
      update public.payments set refunded_pence = least(amount_pence, (select coalesce(sum(amount_pence), 0) from public.payment_refunds where payment_id = p.id and status = 'SUCCEEDED'))
      where id = p.id returning * into p;
      update public.payment_requests set status = 'REFUNDED' where id = p.payment_request_id and status = 'PAID' and p.refunded_pence = p.amount_pence;
      v_result := 'refund_' || lower(rf_status);
    end if;

  elsif p_type = 'charge.updated' then
    if p_extra ? 'fee' then
      v_result := case when public.payment_set_actual_fee(p_object->>'payment_intent', p_object->>'id', p_extra->>'balance_transaction', (p_extra->>'fee')::integer)
        then 'fee_recorded' else 'fee_already_known' end;
    else v_result := 'ignored'; end if;

  elsif p_type = 'charge.dispute.created' then
    update public.payments set needs_review = true, review_note = 'Card payment disputed: check the Stripe dashboard'
    where stripe_payment_intent_id = p_object->>'payment_intent';
    v_result := case when found then 'dispute_flagged' else 'dispute_unmatched' end;
  else
    v_result := 'ignored';
  end if;

  update public.stripe_events set result = v_result where id = p_event_id;
  return v_result;
end $$;

-- Execute grants. Every function defaults to PUBLIC execute, so revoke first.
revoke all on function public.my_finance_permissions(), public.set_admin_permission(uuid, text, boolean),
  public.update_payment_settings(integer, integer, text, text),
  public.create_pitch_session(text, timestamptz, integer, uuid, text, text, text, integer, text, text, timestamptz, text, uuid),
  public.update_pitch_session(uuid, text, timestamptz, integer, uuid, text, text, text, integer, text, text, timestamptz, uuid, boolean),
  public.set_pitch_session_status(uuid, text, text), public.add_session_attendee(uuid, uuid, text, text, boolean),
  public.update_session_attendee(uuid, text, boolean, text, boolean), public.import_match_attendees(uuid, uuid),
  public.issue_payment_requests(uuid, integer, boolean), public.cancel_payment_request(uuid, text),
  public.record_manual_payment(uuid, integer, text, date, text, text, uuid), public.void_manual_payment(uuid, text),
  public.record_manual_refund(uuid, integer, text, uuid), public.refund_begin(uuid, integer, text, uuid),
  public.get_pitch_sessions(text), public.get_pitch_session(uuid), public.admin_checkouts_to_expire(uuid),
  public.admin_fees_to_reconcile(uuid), public.my_payment_requests(),
  public.payment_request_public(uuid), public.checkout_prepare(uuid), public.checkout_attach(uuid, integer, text, text, boolean),
  public.checkout_mark_expired(text), public.refund_attach(uuid, text, text, text), public.payment_set_actual_fee(text, text, text, integer),
  public.stripe_apply_event(text, text, boolean, jsonb, jsonb)
from public, anon;

grant execute on function public.my_finance_permissions(), public.set_admin_permission(uuid, text, boolean),
  public.update_payment_settings(integer, integer, text, text),
  public.create_pitch_session(text, timestamptz, integer, uuid, text, text, text, integer, text, text, timestamptz, text, uuid),
  public.update_pitch_session(uuid, text, timestamptz, integer, uuid, text, text, text, integer, text, text, timestamptz, uuid, boolean),
  public.set_pitch_session_status(uuid, text, text), public.add_session_attendee(uuid, uuid, text, text, boolean),
  public.update_session_attendee(uuid, text, boolean, text, boolean), public.import_match_attendees(uuid, uuid),
  public.issue_payment_requests(uuid, integer, boolean), public.cancel_payment_request(uuid, text),
  public.record_manual_payment(uuid, integer, text, date, text, text, uuid), public.void_manual_payment(uuid, text),
  public.record_manual_refund(uuid, integer, text, uuid), public.refund_begin(uuid, integer, text, uuid),
  public.get_pitch_sessions(text), public.get_pitch_session(uuid), public.admin_checkouts_to_expire(uuid),
  public.admin_fees_to_reconcile(uuid), public.my_payment_requests()
to authenticated;

-- Stripe-facing functions: payments Lambda (service_role) only.
revoke execute on function public.payment_request_public(uuid), public.checkout_prepare(uuid), public.checkout_attach(uuid, integer, text, text, boolean),
  public.checkout_mark_expired(text), public.refund_attach(uuid, text, text, text), public.payment_set_actual_fee(text, text, text, integer),
  public.stripe_apply_event(text, text, boolean, jsonb, jsonb) from authenticated;
grant execute on function public.payment_request_public(uuid), public.checkout_prepare(uuid), public.checkout_attach(uuid, integer, text, text, boolean),
  public.checkout_mark_expired(text), public.refund_attach(uuid, text, text, text), public.payment_set_actual_fee(text, text, text, integer),
  public.stripe_apply_event(text, text, boolean, jsonb, jsonb), public.session_totals(uuid) to service_role;

commit;
