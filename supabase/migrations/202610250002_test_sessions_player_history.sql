-- Test sessions and player payment history (prepared 25 Oct 2026). Additive only:
-- one new column, one data update on the single known test session, and
-- replacements of three read functions from 202610250001 with the same
-- signatures. No financial record is deleted or changed.
begin;

alter table public.pitch_sessions add column if not exists is_test boolean not null default false;

-- The Stripe test-mode check run on 25 Oct 2026 (title starts "TEST - Stripe test-mode check").
update public.pitch_sessions set is_test = true
where id = '68e3f37d-dc04-4185-a532-07cec6049783' and title like 'TEST - %';

-- Admins can mark a session as a test (kept, audited, excluded from normal lists and player views).
create or replace function public.set_pitch_session_test(p_session uuid, p_is_test boolean) returns void
language plpgsql security definer set search_path = public as $$
declare s public.pitch_sessions%rowtype;
begin
  perform public.require_permission('sessions.manage');
  select * into s from public.pitch_sessions where id = p_session for update;
  if not found then raise exception 'Session not found'; end if;
  if s.is_test = p_is_test then return; end if;
  if not p_is_test and exists (select 1 from public.payments where session_id = p_session and livemode is false) then
    raise exception 'This session holds Stripe test-mode payments and must stay marked as a test';
  end if;
  update public.pitch_sessions set is_test = p_is_test where id = p_session;
  perform public.fin_audit(case when p_is_test then 'SESSION_MARKED_TEST' else 'SESSION_UNMARKED_TEST' end, p_session, jsonb_build_object('title', s.title));
end $$;
revoke all on function public.set_pitch_session_test(uuid, boolean) from public, anon;
grant execute on function public.set_pitch_session_test(uuid, boolean) to authenticated;

-- Normal scopes exclude test sessions; the 'test' scope lists only them.
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
    where (p_scope = 'test') = s.is_test and case p_scope
      when 'upcoming' then s.status not in ('COMPLETED','CANCELLED') and s.starts_at >= now() - interval '1 day'
      when 'past' then s.status not in ('COMPLETED','CANCELLED') and s.starts_at < now() - interval '1 day'
      when 'completed' then s.status = 'COMPLETED'
      when 'cancelled' then s.status = 'CANCELLED'
      when 'outstanding' then s.status <> 'CANCELLED' and (public.session_totals(s.id)->>'outstanding_pence')::integer > 0
      else true end
    ) x), '[]'::jsonb);
end $$;

-- Player dashboard: open requests only, never from test sessions.
create or replace function public.my_payment_requests() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'amount_pence', r.amount_pence, 'status', r.status, 'due_at', r.due_at,
    'title', s.title, 'starts_at', s.starts_at) order by s.starts_at), '[]'::jsonb)
  from public.payment_requests r join public.session_attendees a on a.id = r.attendee_id join public.pitch_sessions s on s.id = r.session_id
  where a.profile_id = auth.uid() and public.is_approved() and r.status in ('PENDING','FAILED') and s.status <> 'CANCELLED' and not s.is_test
$$;

-- Player's own recent pitch sessions with their share, what they have paid and what is still owed.
create or replace function public.my_pitch_payments() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(item order by item->>'starts_at' desc), '[]'::jsonb) from (
    select jsonb_build_object('session_id', s.id, 'title', s.title, 'starts_at', s.starts_at, 'status', s.status,
      'venue', coalesce(v.name, s.venue_name), 'pitch', s.pitch_name, 'attendance', a.attendance,
      'share_pence', b.share_pence, 'paid_pence', b.paid_pence - b.refunded_pence, 'outstanding_pence', b.outstanding_pence,
      'request', (select jsonb_build_object('id', r.id, 'amount_pence', r.amount_pence, 'status', r.status, 'due_at', r.due_at)
                  from public.payment_requests r where r.attendee_id = a.id and r.status not in ('SUPERSEDED','CANCELLED')
                  order by r.issued_at desc limit 1)) item
    from public.session_attendees a
    join public.pitch_sessions s on s.id = a.session_id
    left join public.venues v on v.id = s.venue_id
    cross join lateral (select * from public.session_balances(s.id) bl where bl.attendee_id = a.id) b
    where a.profile_id = auth.uid() and public.is_approved() and not s.is_test
      and (s.starts_at > now() - interval '60 days' or b.outstanding_pence <> 0)
    order by s.starts_at desc limit 20) x
$$;
revoke all on function public.my_pitch_payments() from public, anon;
grant execute on function public.my_pitch_payments() to authenticated;

commit;
