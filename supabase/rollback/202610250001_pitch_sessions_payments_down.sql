-- Rollback for 202610250001_pitch_sessions_payments.sql. Removes ONLY the objects that
-- migration created; no existing CAFF table, row or policy is touched. Audit rows it
-- wrote to admin_audit_log are kept. Run only if the payments feature is abandoned:
-- it deletes any sessions and payment records entered since (export CSVs first).
begin;
drop table if exists public.stripe_events, public.payment_refunds, public.payments, public.payment_request_checkouts,
  public.payment_requests, public.session_attendees, public.pitch_sessions, public.payment_settings, public.admin_permissions;
drop function if exists
  public.stripe_apply_event(text, text, boolean, jsonb, jsonb), public.payment_set_actual_fee(text, text, text, integer),
  public.refund_attach(uuid, text, text, text), public.checkout_mark_expired(text), public.checkout_attach(uuid, integer, text, text, boolean),
  public.checkout_prepare(uuid), public.payment_request_public(uuid), public.my_payment_requests(), public.admin_fees_to_reconcile(uuid),
  public.admin_checkouts_to_expire(uuid), public.get_pitch_session(uuid), public.get_pitch_sessions(text), public.session_permission_view(),
  public.refund_begin(uuid, integer, text, uuid), public.record_manual_refund(uuid, integer, text, uuid), public.void_manual_payment(uuid, text),
  public.record_manual_payment(uuid, integer, text, date, text, text, uuid), public.cancel_payment_request(uuid, text),
  public.issue_payment_requests(uuid, integer, boolean), public.import_match_attendees(uuid, uuid),
  public.update_session_attendee(uuid, text, boolean, text, boolean), public.add_session_attendee(uuid, uuid, text, text, boolean),
  public.set_pitch_session_status(uuid, text, text),
  public.update_pitch_session(uuid, text, timestamptz, integer, uuid, text, text, text, integer, text, text, timestamptz, uuid, boolean),
  public.create_pitch_session(text, timestamptz, integer, uuid, text, text, text, integer, text, text, timestamptz, text, uuid),
  public.update_payment_settings(integer, integer, text, text), public.set_admin_permission(uuid, text, boolean), public.my_finance_permissions(),
  public.bump_calc_version(uuid), public.refresh_request_status(uuid), public.session_has_payment_activity(uuid), public.require_permission(text),
  public.fin_audit(text, uuid, jsonb), public.session_totals(uuid), public.session_balances(uuid), public.session_shares(uuid),
  public.session_allocation_total(integer, integer, text, integer, integer), public.split_net_after_fees(integer, integer, integer, integer),
  public.estimate_stripe_fee(integer, integer, integer), public.has_permission(text);
commit;
