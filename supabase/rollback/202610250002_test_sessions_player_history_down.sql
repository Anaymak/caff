-- Rollback for 202610250002_test_sessions_player_history.sql. Restores the
-- 202610250001 versions of get_pitch_sessions and my_payment_requests, drops the
-- two functions 002 added and the is_test flag. No payment, request or audit row is
-- touched (audit entries for test-flag changes stay). ASCII only.
begin;
drop function if exists public.set_pitch_session_test(uuid, boolean);
drop function if exists public.my_pitch_payments();
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

create or replace function public.my_payment_requests() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'amount_pence', r.amount_pence, 'status', r.status, 'due_at', r.due_at,
    'title', s.title, 'starts_at', s.starts_at) order by s.starts_at), '[]'::jsonb)
  from public.payment_requests r join public.session_attendees a on a.id = r.attendee_id join public.pitch_sessions s on s.id = r.session_id
  where a.profile_id = auth.uid() and public.is_approved() and r.status in ('PENDING','FAILED') and s.status <> 'CANCELLED'
$$;

alter table public.pitch_sessions drop column if exists is_test;
commit;
