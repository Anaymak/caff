// Runs the pitch-session/payments migration on an in-memory Postgres (PGlite)
// with a minimal stand-in for the Supabase objects it builds on, then exercises
// permissions, splits, payment requests, Stripe events, manual entries and refunds.
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import { allocationTotal } from '../lib/domain/payments.ts'

const OWNER = '00000000-0000-4000-8000-000000000001'
const ADMIN = '00000000-0000-4000-8000-000000000002'   // seeded with the default admin permissions
const PLAYER = '00000000-0000-4000-8000-000000000003'
const NEW_ADMIN = '00000000-0000-4000-8000-000000000004' // made admin after the migration: no grants
const MEMBERS = Array.from({ length: 14 }, (_, i) => `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`)

const STUB = `
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema public, auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
create table public.profiles (id uuid primary key, email text not null, full_name text not null, nickname text,
  role text not null default 'PLAYER', status text not null default 'APPROVED', is_owner boolean not null default false);
create table public.venues (id uuid primary key default gen_random_uuid(), name text not null, address text not null, pitch text, notes text, active boolean default true);
create table public.matches (id uuid primary key default gen_random_uuid(), title text);
create table public.match_availability (match_id uuid, player_id uuid, status text, primary key(match_id, player_id));
create table public.admin_audit_log (id bigint generated always as identity primary key, actor_id uuid, target_id uuid, action text not null, details jsonb not null default '{}', created_at timestamptz not null default now());
grant select on public.admin_audit_log to authenticated, service_role;
create function public.touch_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
create function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$ select exists(select 1 from public.profiles where id = auth.uid() and role = 'ADMIN' and status = 'APPROVED') $$;
create function public.is_owner() returns boolean language sql stable security definer set search_path = public as $$ select exists(select 1 from public.profiles where id = auth.uid() and is_owner and role = 'ADMIN' and status = 'APPROVED') $$;
create function public.is_approved() returns boolean language sql stable security definer set search_path = public as $$ select exists(select 1 from public.profiles where id = auth.uid() and status = 'APPROVED') $$;
insert into public.profiles(id, email, full_name, role, is_owner) values
  ('${OWNER}', 'owner@example.test', 'Olive Owner', 'ADMIN', true),
  ('${ADMIN}', 'admin@example.test', 'Adam Admin', 'ADMIN', false),
  ('${PLAYER}', 'player@example.test', 'Pat Player', 'PLAYER', false);
insert into public.profiles(id, email, full_name) select id::uuid, 'm' || ord || '@example.test', 'Member ' || ord
  from unnest(array[${MEMBERS.map((m) => `'${m}'`).join(',')}]) with ordinality as t(id, ord);
`

let db
before(async () => {
  db = new PGlite()
  await db.exec(STUB)
  await db.exec(readFileSync(new URL('../supabase/migrations/202610250001_pitch_sessions_payments.sql', import.meta.url), 'utf8'))
  await db.exec(`insert into public.profiles(id, email, full_name, role) values ('${NEW_ADMIN}', 'new@example.test', 'Nia New', 'ADMIN')`)
})

/** Runs SQL as a Supabase role; user null = the role without a JWT subject. */
async function as(user, sql, params = [], role = 'authenticated') {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('role', $1, true), set_config('request.jwt.claim.sub', $2, true)`, [role, user ?? ''])
    const result = await tx.query(sql, params)
    return result.rows
  })
}
const rpc = async (user, fn, args = []) => (await as(user, `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as v`, args))[0].v
const service = async (fn, args = []) => (await as(null, `select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as v`, args, 'service_role'))[0].v

async function newSession(user, pitchPence, { mode = 'ABSORB', status = 'OPEN', title = 'Thursday 5-a-side' } = {}) {
  return rpc(user, 'create_pitch_session', [title, new Date(Date.now() + 86400000).toISOString(), 60, null, 'Powerleague', 'Pitch 3', '5-a-side',
    pitchPence, mode, '', null, status, null])
}
async function addConfirmed(sessionId, members, confirm = false) {
  const ids = []
  for (const m of members) ids.push(await rpc(ADMIN, 'add_session_attendee', [sessionId, m, null, 'CONFIRMED', confirm]))
  return ids
}
const detail = (sessionId, user = OWNER) => rpc(user, 'get_pitch_session', [sessionId])
const shares = async (sessionId) => (await detail(sessionId)).attendees.filter((a) => a.share_pence > 0).map((a) => a.share_pence)

test('equal split: £60 / 10 = £6.00 and £75 / 12 = £6.25', async () => {
  const a = await newSession(ADMIN, 6000); await addConfirmed(a, MEMBERS.slice(0, 10))
  assert.deepEqual(await shares(a), Array(10).fill(600))
  const b = await newSession(ADMIN, 7500); await addConfirmed(b, MEMBERS.slice(0, 12))
  assert.deepEqual(await shares(b), Array(12).fill(625))
  const t = (await detail(b)).totals
  assert.equal(t.chargeable_count, 12); assert.equal(t.base_share_pence, 625); assert.equal(t.allocation_total_pence, 7500)
})

test('penny rounding: shares always sum to the exact total, extra pennies deterministic', async () => {
  const s = await newSession(ADMIN, 5000); await addConfirmed(s, MEMBERS.slice(0, 3))
  const first = await shares(s)
  assert.equal(first.reduce((x, y) => x + y, 0), 5000)
  assert.deepEqual([...first].sort(), [1666, 1667, 1667])
  assert.deepEqual(await shares(s), first, 'same inputs give the same allocation')
  for (const [pitch, n] of [[7001, 7], [9999, 14], [101, 13], [6000, 11]]) {
    const id = await newSession(ADMIN, pitch); await addConfirmed(id, MEMBERS.slice(0, n))
    const got = await shares(id)
    assert.equal(got.reduce((x, y) => x + y, 0), pitch)
    assert.ok(Math.max(...got) - Math.min(...got) <= 1)
  }
})

test('unconfirmed, cancelled and non-chargeable attendees are excluded; recalculates on change', async () => {
  const s = await newSession(ADMIN, 6000)
  const [a1] = await addConfirmed(s, MEMBERS.slice(0, 10))
  await rpc(ADMIN, 'add_session_attendee', [s, null, 'Guest Gary', 'UNCONFIRMED', false])
  assert.deepEqual(await shares(s), Array(10).fill(600))
  await rpc(ADMIN, 'update_session_attendee', [a1, 'CANCELLED', true, '', false])
  const after = await shares(s)
  assert.equal(after.length, 9); assert.equal(after.reduce((x, y) => x + y, 0), 6000)
  const d = await detail(s)
  const v = d.session.calc_version
  await rpc(ADMIN, 'update_pitch_session', [s, 'Thursday 5-a-side', d.session.starts_at, 60, null, 'Goals', 'Pitch 1', '7-a-side', 7200, 'ABSORB', '', null, null, false])
  const d2 = await detail(s)
  assert.equal(d2.totals.allocation_total_pence, 7200); assert.equal(d2.session.calc_version, v + 1)
  await assert.rejects(rpc(ADMIN, 'add_session_attendee', [s, MEMBERS[1], null, 'CONFIRMED', false]), /already on this session/)
})

test('cover-in-price mode matches the TypeScript calculation and covers the pitch after fees', async () => {
  for (const [pitch, n] of [[6000, 10], [7500, 12], [4000, 7], [12345, 13]]) {
    const s = await newSession(ADMIN, pitch, { mode: 'COVER_IN_PRICE' }); await addConfirmed(s, MEMBERS.slice(0, n))
    const t = (await detail(s)).totals
    assert.equal(t.allocation_total_pence, allocationTotal(pitch, n, 'COVER_IN_PRICE', { percentBps: 150, fixedPence: 20 }))
    assert.ok(t.expected_net_all_stripe_pence >= pitch, 'net after estimated fees covers the pitch')
    assert.ok(t.fee_cover_pence > 0)
  }
  const s = await newSession(ADMIN, 6000); await addConfirmed(s, MEMBERS.slice(0, 10))
  const t = (await detail(s)).totals
  assert.equal(t.estimated_fees_all_stripe_pence, 10 * (9 + 20), '1.5% of £6 = 9p plus 20p, for each of 10 separate payments')
  assert.equal(t.expected_net_all_stripe_pence, 6000 - 290)
})

test('permissions: players and ungranted admins cannot manage sessions or read finance', async () => {
  await assert.rejects(newSession(PLAYER, 6000), /PERMISSION_DENIED/)
  await assert.rejects(newSession(NEW_ADMIN, 6000), /PERMISSION_DENIED/)
  const s = await newSession(ADMIN, 6000)
  const [attendee] = await addConfirmed(s, [PLAYER, ...MEMBERS.slice(0, 4)])
  await assert.rejects(rpc(PLAYER, 'get_pitch_session', [s]), /PERMISSION_DENIED/)
  await assert.rejects(rpc(PLAYER, 'record_manual_payment', [attendee, 1200, 'CASH', '2026-10-25', '', '', randomUUID()]), /PERMISSION_DENIED/)
  await assert.rejects(as(PLAYER, `insert into public.payments(session_id, attendee_id, method, amount_pence) values ($1, $2, 'CASH', 100)`, [s, attendee]), /permission denied/)
  await assert.rejects(as(PLAYER, `update public.payment_requests set status = 'PAID'`), /permission denied/)
  await assert.rejects(as(ADMIN, `update public.payments set status = 'VOID'`), /permission denied/)
  assert.equal((await as(PLAYER, 'select * from public.payments')).length, 0)
  await assert.rejects(rpc(PLAYER, 'stripe_apply_event', ['evt_x', 'checkout.session.completed', false, {}, {}]), /permission denied/)
  await assert.rejects(rpc(ADMIN, 'checkout_prepare', [randomUUID()]), /permission denied/)
  await assert.rejects(as(null, 'select public.get_pitch_sessions($1)', ['all'], 'anon'), /permission denied/)
  // Refunds and settings are Owner-only until granted.
  await assert.rejects(rpc(ADMIN, 'update_payment_settings', [150, 20, 'ABSORB', 'test']), /PERMISSION_DENIED/)
  await assert.rejects(rpc(ADMIN, 'set_admin_permission', [NEW_ADMIN, 'finance.view', true]), /only the Owner/)
  await rpc(OWNER, 'set_admin_permission', [NEW_ADMIN, 'finance.view', true])
  assert.ok((await rpc(NEW_ADMIN, 'my_finance_permissions')).includes('finance.view'))
  assert.deepEqual(await rpc(PLAYER, 'my_finance_permissions'), [])
})

test('payment requests: issued once, version-guarded, and changes need confirmation', async () => {
  const s = await newSession(ADMIN, 6000)
  await addConfirmed(s, MEMBERS.slice(0, 10))
  const v = (await detail(s)).session.calc_version
  await assert.rejects(rpc(ADMIN, 'issue_payment_requests', [s, v - 1, false]), /STALE/)
  assert.equal((await rpc(ADMIN, 'issue_payment_requests', [s, v, false])).created, 10)
  const again = await rpc(ADMIN, 'issue_payment_requests', [s, v, false])
  assert.equal(again.created, 0); assert.equal(again.unchanged, 10)
  // Adding a confirmed player after requests exist needs explicit confirmation.
  await assert.rejects(rpc(ADMIN, 'add_session_attendee', [s, MEMBERS[10], null, 'CONFIRMED', false]), /CONFIRM_REQUIRED/)
  await rpc(ADMIN, 'add_session_attendee', [s, MEMBERS[10], null, 'CONFIRMED', true])
  const d = await detail(s)
  assert.equal(d.totals.stale_request_count, 10, 'issued amounts are not silently changed')
  assert.ok(d.requests.every((r) => r.amount_pence === 600))
  await assert.rejects(rpc(ADMIN, 'issue_payment_requests', [s, d.session.calc_version, false]), /CONFIRM_REQUIRED: 10/)
  const result = await rpc(ADMIN, 'issue_payment_requests', [s, d.session.calc_version, true])
  assert.equal(result.replaced, 10); assert.equal(result.created, 1)
  const d2 = await detail(s)
  const active = d2.requests.filter((r) => r.status === 'PENDING')
  assert.equal(active.length, 11)
  assert.equal(active.reduce((sum, r) => sum + r.amount_pence, 0), 6000)
  assert.equal(d2.requests.filter((r) => r.status === 'SUPERSEDED').length, 10)
  assert.equal(d2.requests.find((r) => r.status === 'PENDING').calculation.chargeable_count, 11)
  // Price edit with live requests requires confirmation too.
  await assert.rejects(rpc(ADMIN, 'update_pitch_session', [s, 'x', d2.session.starts_at, 60, null, '', '', '', 6600, 'ABSORB', '', null, null, false]), /CONFIRM_REQUIRED/)
  // Unique index: a second active request for the same attendee is impossible.
  const one = active[0]
  await assert.rejects(as(null, `insert into public.payment_requests(session_id, attendee_id, amount_pence, calc_version, calculation) values ($1, $2, 600, 1, '{}')`, [s, one.attendee_id], 'service_role'), /payment_request_one_active/)
  // Planning sessions cannot request payment.
  const planning = await newSession(ADMIN, 6000, { status: 'PLANNING' }); await addConfirmed(planning, MEMBERS.slice(0, 2))
  await assert.rejects(rpc(ADMIN, 'issue_payment_requests', [planning, 2, false]), /Open or confirm/)
})

async function issuedSession(pitch = 6000, n = 10) {
  const s = await newSession(ADMIN, pitch); await addConfirmed(s, MEMBERS.slice(0, n))
  await rpc(ADMIN, 'issue_payment_requests', [s, (await detail(s)).session.calc_version, false])
  const d = await detail(s)
  return { s, requests: d.requests.filter((r) => r.status === 'PENDING') }
}

let eventSeq = 0
const evt = () => `evt_test_${++eventSeq}`
async function checkout(requestId) {
  const prep = await service('checkout_prepare', [requestId])
  assert.equal(prep.payable, true)
  if (prep.reuse_url) return { prep, cs: null }
  const cs = `cs_test_${requestId.slice(0, 8)}_${prep.attempt}`
  await service('checkout_attach', [requestId, prep.attempt, cs, `https://checkout.stripe.com/c/pay/${cs}`, false])
  return { prep, cs }
}
const completed = (cs, request, amount, extra = {}) => ({ id: cs, object: 'checkout.session', payment_status: 'paid', amount_total: amount, currency: 'gbp',
  client_reference_id: request, metadata: { payment_request_id: request }, payment_intent: `pi_${cs}`, ...extra })

test('checkout: concurrent prepares share one attempt; open sessions are reused', async () => {
  const { requests } = await issuedSession()
  const r = requests[0].id
  const p1 = await service('checkout_prepare', [r]); const p2 = await service('checkout_prepare', [r])
  assert.equal(p1.attempt, 1); assert.equal(p2.attempt, 1); assert.equal(p1.expires_at, p2.expires_at, 'identical Stripe parameters for the idempotency key')
  assert.equal(p1.amount_pence, 600); assert.equal(p1.stripe_mode, 'test')
  await service('checkout_attach', [r, 1, 'cs_test_reuse', 'https://checkout.stripe.com/c/pay/cs_test_reuse', false])
  assert.equal((await service('checkout_prepare', [r])).reuse_url, 'https://checkout.stripe.com/c/pay/cs_test_reuse')
  await service('stripe_apply_event', [evt(), 'checkout.session.expired', false, { id: 'cs_test_reuse' }, {}])
  assert.equal((await service('checkout_prepare', [r])).attempt, 2, 'an expired link is replaced by a new attempt')
  const pub = await service('payment_request_public', [r])
  assert.equal(pub.amount_pence, 600); assert.equal(pub.payable, true); assert.equal(pub.player, 'Member'); assert.equal(pub.email, undefined)
})

test('webhook: successful payment marks only that player paid, replays are no-ops', async () => {
  const { s, requests } = await issuedSession()
  const [r1, r2] = requests
  const { cs } = await checkout(r1.id)
  const id = evt()
  const event = completed(cs, r1.id, 600)
  assert.equal(await service('stripe_apply_event', [id, 'checkout.session.completed', false, event, { fee: 29, balance_transaction: 'txn_1', charge: 'ch_1' }]), 'paid')
  assert.equal(await service('stripe_apply_event', [id, 'checkout.session.completed', false, event, {}]), 'duplicate')
  assert.equal(await service('stripe_apply_event', [evt(), 'checkout.session.async_payment_succeeded', false, event, {}]), 'payment_already_recorded')
  const d = await detail(s)
  assert.equal(d.payments.length, 1)
  assert.equal(d.requests.find((r) => r.id === r1.id).status, 'PAID')
  assert.equal(d.requests.find((r) => r.id === r2.id).status, 'PENDING')
  assert.equal(d.totals.gross_received_pence, 600); assert.equal(d.totals.fees_actual_pence, 29)
  assert.equal(d.totals.net_received_pence, 571); assert.equal(d.totals.paid_count, 1); assert.equal(d.totals.unpaid_count, 9)
  assert.equal(d.totals.outstanding_pence, 5400); assert.equal(d.totals.covered, false)
  assert.equal((await service('checkout_prepare', [r1.id])).reason, 'paid', 'a paid request cannot be paid twice')
})

test('webhook: wrong mode, unknown checkout, tampered amount and failures', async () => {
  const { s, requests } = await issuedSession()
  const [r1, r2, r3] = requests
  const { cs } = await checkout(r1.id)
  assert.equal(await service('stripe_apply_event', [evt(), 'checkout.session.completed', true, completed(cs, r1.id, 600), {}]), 'ignored_mode_mismatch')
  assert.equal(await service('stripe_apply_event', [evt(), 'checkout.session.completed', false, completed('cs_unknown', r1.id, 600), {}]), 'unmatched_checkout')
  assert.equal(await service('stripe_apply_event', [evt(), 'checkout.session.completed', false, { ...completed(cs, r1.id, 600), payment_status: 'unpaid' }, {}]), 'awaiting_payment')
  // Metadata pointing at another player's request does not mark that player paid.
  assert.equal(await service('stripe_apply_event', [evt(), 'checkout.session.completed', false, completed(cs, r2.id, 600), {}]), 'paid_needs_review')
  const d = await detail(s)
  assert.equal(d.requests.find((r) => r.id === r2.id).status, 'PENDING')
  assert.equal(d.requests.find((r) => r.id === r1.id).status, 'PENDING')
  assert.equal(d.payments[0].needs_review, true)
  assert.equal(d.payments[0].attendee_id, r1.attendee_id, 'money is attributed via the checkout we created, not the metadata')
  const { cs: cs3 } = await checkout(r3.id)
  assert.equal(await service('stripe_apply_event', [evt(), 'checkout.session.completed', false, completed(cs3, r3.id, 500), {}]), 'paid_needs_review')
  assert.equal(await service('stripe_apply_event', [evt(), 'payment_intent.payment_failed', false,
    { id: 'pi_fail', metadata: { payment_request_id: requests[3].id }, last_payment_error: { message: 'Your card was declined.' } }, {}]), 'marked_failed')
  const failed = (await detail(s)).requests.find((r) => r.id === requests[3].id)
  assert.equal(failed.status, 'FAILED'); assert.equal(failed.last_error, 'Your card was declined.')
  assert.equal((await service('checkout_prepare', [failed.id])).payable, true, 'a failed payment can be retried')
})

test('refunds: Stripe refund through the app, dashboard refunds, actual fees', async () => {
  const { s, requests } = await issuedSession()
  const r1 = requests[0]
  const { cs } = await checkout(r1.id)
  await service('stripe_apply_event', [evt(), 'checkout.session.completed', false, completed(cs, r1.id, 600), {}])
  let d = await detail(s)
  const pay = d.payments[0]
  assert.equal(pay.fee_actual_pence, null); assert.equal(d.totals.fees_estimated_unconfirmed_pence, 29); assert.equal(d.totals.fees_include_estimates, true)
  assert.equal(await service('stripe_apply_event', [evt(), 'charge.updated', false, { id: 'ch_9', payment_intent: pay.stripe_payment_intent_id }, { fee: 30, balance_transaction: 'txn_9' }]), 'fee_recorded')
  d = await detail(s)
  assert.equal(d.totals.fees_actual_pence, 30); assert.equal(d.totals.fees_include_estimates, false)
  await assert.rejects(rpc(ADMIN, 'refund_begin', [pay.id, 600, 'Session cancelled', randomUUID()]), /PERMISSION_DENIED/)
  const token = randomUUID()
  await assert.rejects(rpc(OWNER, 'refund_begin', [pay.id, 601, 'Too much', token]), /more than the amount left/)
  const begun = await rpc(OWNER, 'refund_begin', [pay.id, 600, 'Could not play', token])
  assert.equal((await rpc(OWNER, 'refund_begin', [pay.id, 600, 'Could not play', token])).refund_id, begun.refund_id, 'retry returns the same refund')
  assert.equal(begun.payment_intent, pay.stripe_payment_intent_id)
  await assert.rejects(rpc(OWNER, 'refund_begin', [pay.id, 1, 'Second', randomUUID()]), /more than the amount left/, 'pending refunds are reserved')
  await service('refund_attach', [begun.refund_id, 're_1', 'pending', null])
  assert.equal(await service('stripe_apply_event', [evt(), 'refund.updated', false, { id: 're_1', amount: 600, status: 'succeeded', payment_intent: pay.stripe_payment_intent_id, metadata: { refund_id: begun.refund_id } }, {}]), 'refund_succeeded')
  d = await detail(s)
  assert.equal(d.payments[0].refunded_pence, 600)
  assert.equal(d.requests.find((r) => r.id === r1.id).status, 'REFUNDED')
  assert.equal(d.totals.net_received_pence, -30, 'Stripe keeps its fee on refunds')
  // A refund made in the Stripe dashboard is recorded once even if events repeat.
  const r2 = requests[1]; const { cs: cs2 } = await checkout(r2.id)
  await service('stripe_apply_event', [evt(), 'checkout.session.completed', false, completed(cs2, r2.id, 600), {}])
  const refundEvent = { id: 're_dash', amount: 200, status: 'succeeded', payment_intent: `pi_${cs2}`, metadata: {} }
  await service('stripe_apply_event', [evt(), 'refund.created', false, refundEvent, {}])
  await service('stripe_apply_event', [evt(), 'refund.updated', false, refundEvent, {}])
  d = await detail(s)
  const p2 = d.payments.find((p) => p.payment_request_id === r2.id)
  assert.equal(p2.refunded_pence, 200); assert.equal(p2.refunds.length, 1)
  assert.equal(d.attendees.find((a) => a.id === r2.attendee_id).outstanding_pence, 200, 'partial refund leaves the player owing again')
})

test('manual payments: idempotent, auditable corrections, and overpayment guard at checkout', async () => {
  const { s, requests } = await issuedSession()
  const [r1, r2] = requests
  const token = randomUUID()
  const p1 = await rpc(ADMIN, 'record_manual_payment', [r1.attendee_id, 600, 'BANK_TRANSFER', '2026-10-24', 'CAFF-123', 'Monzo', token])
  assert.equal(await rpc(ADMIN, 'record_manual_payment', [r1.attendee_id, 600, 'BANK_TRANSFER', '2026-10-24', 'CAFF-123', 'Monzo', token]), p1, 'double submit records once')
  let d = await detail(s)
  assert.equal(d.payments.length, 1); assert.equal(d.payments[0].recorded_by_name, 'Adam Admin')
  assert.equal(d.requests.find((r) => r.id === r1.id).status, 'MANUALLY_PAID')
  assert.equal((await service('checkout_prepare', [r1.id])).payable, false)
  await assert.rejects(rpc(ADMIN, 'void_manual_payment', [p1, '']), /reason/)
  await rpc(ADMIN, 'void_manual_payment', [p1, 'Entered against the wrong player'])
  d = await detail(s)
  assert.equal(d.payments[0].status, 'VOID'); assert.equal(d.payments[0].amount_pence, 600, 'original kept')
  assert.equal(d.requests.find((r) => r.id === r1.id).status, 'PENDING', 'request re-opens')
  assert.ok(d.audit.some((a) => a.action === 'MANUAL_PAYMENT_VOIDED' && a.actor === 'Adam Admin'))
  // £2 cash against a £6 request: the £6 card link is blocked until reissued for £4.
  await rpc(ADMIN, 'record_manual_payment', [r2.attendee_id, 200, 'CASH', '2026-10-24', '', '', randomUUID()])
  assert.equal((await service('checkout_prepare', [r2.id])).reason, 'needs_review')
  const v = (await detail(s)).session.calc_version
  await rpc(ADMIN, 'issue_payment_requests', [s, v, true])
  const reissued = (await detail(s)).requests.find((r) => r.attendee_id === r2.attendee_id && r.status === 'PENDING')
  assert.equal(reissued.amount_pence, 400); assert.equal(reissued.calculation.already_paid_pence, 200)
  await assert.rejects(rpc(ADMIN, 'record_manual_refund', [p1, 100, 'x', randomUUID()]), /PERMISSION_DENIED/)
})

test('cancelling a session closes unpaid requests and keeps money for refund', async () => {
  const { s, requests } = await issuedSession()
  const { cs } = await checkout(requests[0].id)
  await service('stripe_apply_event', [evt(), 'checkout.session.completed', false, completed(cs, requests[0].id, 600), {}])
  await assert.rejects(rpc(ADMIN, 'set_pitch_session_status', [s, 'CANCELLED', '']), /reason/)
  await rpc(ADMIN, 'set_pitch_session_status', [s, 'CANCELLED', 'Pitch waterlogged'])
  const d = await detail(s)
  assert.equal(d.requests.filter((r) => r.status === 'CANCELLED').length, 9)
  assert.equal(d.payments.length, 1); assert.equal(d.payments[0].status, 'SUCCEEDED')
  assert.equal((await service('checkout_prepare', [requests[1].id])).reason, 'session_cancelled')
  assert.equal((await service('payment_request_public', [requests[1].id])).payable, false)
  // Paying an old checkout after cancellation is recorded but flagged, not lost.
  const late = completed('cs_late', requests[1].id, 600)
  await as(null, `insert into public.payment_request_checkouts(request_id, attempt, amount_pence, status, checkout_session_id, expires_at) values ($1, 1, 600, 'OPEN', 'cs_late', now() + interval '1 hour')`, [requests[1].id], 'service_role')
  assert.equal(await service('stripe_apply_event', [evt(), 'checkout.session.completed', false, late, {}]), 'paid_needs_review')
  assert.deepEqual(await rpc(ADMIN, 'admin_checkouts_to_expire', [s]), [])
  await assert.rejects(rpc(ADMIN, 'update_session_attendee', [requests[2].attendee_id, 'CANCELLED', true, '', true]), /cancelled/)
  const list = await rpc(ADMIN, 'get_pitch_sessions', ['cancelled'])
  assert.ok(list.some((row) => row.id === s && row.totals.needs_review_count === 1))
})

test('audit log records who changed prices, issued requests and recorded payments', async () => {
  const rows = await as(null, `select action, actor_id from public.admin_audit_log`, [], 'service_role')
  for (const action of ['SESSION_CREATED', 'SESSION_PRICE_CHANGED', 'PAYMENT_REQUESTS_ISSUED', 'MANUAL_PAYMENT_RECORDED', 'STRIPE_REFUND_REQUESTED', 'PERMISSION_GRANTED', 'SESSION_STATUS_CHANGED']) {
    assert.ok(rows.some((r) => r.action === action && r.actor_id), `${action} audited with an actor`)
  }
})

test('settings: only the Owner switches live mode; fee assumptions feed the estimates', async () => {
  await rpc(OWNER, 'set_admin_permission', [ADMIN, 'settings.manage', true])
  await assert.rejects(rpc(ADMIN, 'update_payment_settings', [150, 20, 'ABSORB', 'live']), /only the Owner/)
  await rpc(ADMIN, 'update_payment_settings', [250, 25, 'ABSORB', 'test'])
  const s = await newSession(ADMIN, 1000); await addConfirmed(s, MEMBERS.slice(0, 1))
  assert.equal((await detail(s)).totals.estimated_fees_all_stripe_pence, 25 + 25)
  await assert.rejects(rpc(OWNER, 'update_payment_settings', [5000, 20, 'ABSORB', 'test']), /check/)
  await rpc(OWNER, 'update_payment_settings', [150, 20, 'ABSORB', 'test'])
})
