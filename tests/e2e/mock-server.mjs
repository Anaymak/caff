// Local end-to-end harness (development only, never deployed):
//   - serves the static export in out/ with the CloudFront routing function,
//   - /sb/*  a minimal Supabase stand-in (password sign-in, PostgREST selects and RPCs)
//            backed by PGlite running the real payments migration under RLS,
//   - /api/* the real payments Lambda handler,
//   - a fake Stripe (Checkout page, PaymentIntents, refunds) that sends signed webhooks.
// Build first with NEXT_PUBLIC_SUPABASE_URL=http://localhost:4310/sb NEXT_PUBLIC_SUPABASE_ANON_KEY=anon.
// Run: node --experimental-strip-types tests/e2e/mock-server.mjs   Sign in as owner@caff.test (any password).
import { createServer } from 'node:http'
import { createHmac, randomUUID } from 'node:crypto'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { createRequire } from 'node:module'
import { PGlite } from '@electric-sql/pglite'
import { createHandler } from '../../payments/handler.mjs'

const PORT = 4310
const ROOT = new URL('../../', import.meta.url).pathname
const BASE = `http://localhost:${PORT}`
const WHSEC = 'whsec_local_e2e'
const { handler: route } = createRequire(import.meta.url)('../../infra/viewer-request.js')

const people = [
  ['00000000-0000-4000-8000-000000000001', 'owner@caff.test', 'Anay Owner', 'ADMIN', true],
  ['00000000-0000-4000-8000-000000000002', 'admin@caff.test', 'Alex Admin', 'ADMIN', false],
  ['00000000-0000-4000-8000-000000000003', 'player@caff.test', 'Pat Player', 'PLAYER', false],
  ...['Sam Hughes', 'Jordan Reid', 'Chris Patel', 'Danny Okafor', 'Ellis Moore', 'Freddie Shaw', 'George Ali', 'Harry Kane-Smith', 'Isaac Lowe', 'Jamie Fox', 'Kai Turner']
    .map((name, i) => [`10000000-0000-4000-8000-${String(i).padStart(12, '0')}`, `m${i}@caff.test`, name, 'PLAYER', false]),
]

const db = new PGlite()
await db.exec(`
create role anon; create role authenticated; create role service_role bypassrls;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema public, auth to anon, authenticated, service_role;
create table public.profiles (id uuid primary key, email text not null, full_name text not null, nickname text, avatar_url text, bio text,
  preferred_position text, secondary_position text, role text not null default 'PLAYER', status text not null default 'APPROVED',
  is_owner boolean not null default false, goalkeeper_willing boolean not null default false, comment_restricted boolean not null default false,
  created_at timestamptz not null default now());
create table public.venues (id uuid primary key default gen_random_uuid(), name text not null, address text not null, pitch text, notes text, active boolean default true);
create table public.matches (id uuid primary key default gen_random_uuid(), title text, starts_at timestamptz default now(), status text default 'FINALISED',
  availability_deadline timestamptz, availability_locked boolean default false, max_players int, notes text, venue_id uuid, voting_closes_at timestamptz);
create table public.match_availability (match_id uuid, player_id uuid, status text, primary key(match_id, player_id));
create table public.in_app_notifications (id uuid primary key default gen_random_uuid(), recipient_id uuid, read_at timestamptz);
create table public.admin_audit_log (id bigint generated always as identity primary key, actor_id uuid, target_id uuid, action text not null, details jsonb not null default '{}', created_at timestamptz not null default now());
grant select on all tables in schema public to authenticated, service_role;
create function public.touch_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
create function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$ select exists(select 1 from public.profiles where id = auth.uid() and role = 'ADMIN' and status = 'APPROVED') $$;
create function public.is_owner() returns boolean language sql stable security definer set search_path = public as $$ select exists(select 1 from public.profiles where id = auth.uid() and is_owner and role = 'ADMIN' and status = 'APPROVED') $$;
create function public.is_approved() returns boolean language sql stable security definer set search_path = public as $$ select exists(select 1 from public.profiles where id = auth.uid() and status = 'APPROVED') $$;
insert into public.venues(name, address, pitch) values ('Powerleague Shoreditch', 'Braithwaite St, London', '5-a-side'), ('Goals Wembley', 'Wembley, London', '7-a-side');
`)
for (const [id, email, name, role, owner] of people) await db.query('insert into public.profiles(id, email, full_name, role, is_owner) values ($1,$2,$3,$4,$5)', [id, email, name, role, owner])
for (const m of ['202610250001_pitch_sessions_payments.sql', '202610250002_test_sessions_player_history.sql']) await db.exec(readFileSync(join(ROOT, 'supabase/migrations', m), 'utf8'))
const match = (await db.query(`insert into public.matches(title, starts_at) values ('Thursday Football', now() - interval '7 days') returning id`)).rows[0].id
for (const [id] of people.slice(3, 11)) await db.query(`insert into public.match_availability values ($1, $2, 'PLAYING')`, [match, id])

const jwtFor = (sub) => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 86400 })).toString('base64url')}.sig`
const subOf = (auth) => { try { return JSON.parse(Buffer.from((auth ?? '').split(' ')[1].split('.')[1], 'base64url')).sub } catch { return null } }

async function asRole(sub, role, sql, params) {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('role', $1, true), set_config('request.jwt.claim.sub', $2, true)`, [role, sub ?? ''])
    return (await tx.query(sql, params)).rows
  })
}

// Just enough PostgREST: column lists (embedded resources ignored), eq/neq/is/in/not.in/gt/gte/lt/lte, order, limit.
function selectSql(table, query) {
  const params = []; const where = []
  const columns = (query.get('select') ?? '*').split(',').map((c) => c.trim()).filter((c) => c && !c.includes('(')).map((c) => (c === '*' ? '*' : `"${c.replace(/"/g, '')}"`))
  for (const [key, value] of query) {
    if (['select', 'order', 'limit', 'offset'].includes(key)) continue
    const m = value.match(/^(not\.)?(eq|neq|is|in|gt|gte|lt|lte)\.(.*)$/)
    if (!m) continue
    const col = `"${key.replace(/"/g, '')}"`
    const [, not, op, raw] = m
    if (op === 'is') where.push(`${col} is ${not ? 'not ' : ''}${raw === 'null' ? 'null' : raw === 'true' ? 'true' : 'false'}`)
    else if (op === 'in') { const list = raw.replace(/^\(|\)$/g, '').split(',').map((v) => { params.push(v.replace(/^"|"$/g, '')); return `$${params.length}` }); where.push(`${not ? 'not ' : ''}${col}::text in (${list.join(',')})`) }
    else { params.push(raw); where.push(`${not ? 'not ' : ''}${col}::text ${{ eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[op]} $${params.length}`) }
  }
  const order = (query.get('order') ?? '').split(',').filter(Boolean).map((o) => { const [c, dir] = o.split('.'); return `"${c}" ${dir === 'desc' ? 'desc' : 'asc'}` })
  return { sql: `select ${columns.join(',') || '*'} from public."${table.replace(/"/g, '')}"${where.length ? ` where ${where.join(' and ')}` : ''}${order.length ? ` order by ${order.join(',')}` : ''}${query.get('limit') ? ` limit ${Number(query.get('limit'))}` : ''}`, params }
}

const stripeState = { sessions: new Map(), intents: new Map() }
const fee = (amount) => Math.round(amount * 0.015) + 20

async function sendWebhook(type, object) {
  const body = JSON.stringify({ id: `evt_${randomUUID().replace(/-/g, '')}`, type, livemode: false, data: { object } })
  const t = Math.floor(Date.now() / 1000)
  const signature = `t=${t},v1=${createHmac('sha256', WHSEC).update(`${t}.${body}`).digest('hex')}`
  const res = await payments({ requestContext: { http: { method: 'POST' } }, rawPath: '/api/stripe/webhook', headers: { 'stripe-signature': signature }, body })
  console.log(`webhook ${type} -> ${res.statusCode} ${res.body}`)
  return res
}

// Fake Stripe API used by the real handler through fetchImpl.
async function fakeStripe(url, init) {
  const u = new URL(url); const form = new URLSearchParams(init.body ?? '')
  const reply = (json, status = 200) => ({ ok: status < 400, status, json: async () => json, text: async () => JSON.stringify(json) })
  if (init.method === 'POST' && u.pathname === '/v1/checkout/sessions') {
    const key = init.headers['Idempotency-Key']
    const existing = [...stripeState.sessions.values()].find((s) => s.key === key)
    if (existing) return reply(existing.session)
    const id = `cs_test_${randomUUID().replace(/-/g, '').slice(0, 20)}`
    const session = { id, object: 'checkout.session', url: `${BASE}/__stripe/checkout?cs=${id}`, livemode: false, amount_total: Number(form.get('line_items[0][price_data][unit_amount]')),
      currency: form.get('line_items[0][price_data][currency]'), client_reference_id: form.get('client_reference_id'), metadata: { payment_request_id: form.get('metadata[payment_request_id]') },
      success_url: form.get('success_url'), cancel_url: form.get('cancel_url'), payment_status: 'unpaid', name: form.get('line_items[0][price_data][product_data][name]') }
    stripeState.sessions.set(id, { key, session })
    return reply(session)
  }
  const expire = u.pathname.match(/^\/v1\/checkout\/sessions\/(.+)\/expire$/)
  if (expire) return reply({ id: expire[1], status: 'expired' })
  const pi = u.pathname.match(/^\/v1\/payment_intents\/(.+)$/)
  if (pi) { const intent = stripeState.intents.get(pi[1]); return reply({ id: pi[1], latest_charge: { id: `ch_${pi[1]}`, balance_transaction: { id: `txn_${pi[1]}`, fee: fee(intent?.amount ?? 0) } } }) }
  if (init.method === 'POST' && u.pathname === '/v1/refunds') {
    const refund = { id: `re_${randomUUID().slice(0, 8)}`, object: 'refund', amount: Number(form.get('amount')), status: 'succeeded', payment_intent: form.get('payment_intent'), metadata: { refund_id: form.get('metadata[refund_id]') } }
    setTimeout(() => void sendWebhook('refund.updated', refund), 500)
    return reply({ ...refund, status: 'pending' })
  }
  return reply({ error: { message: `fake stripe: ${u.pathname} not implemented` } }, 400)
}

const payments = createHandler({
  env: { SUPABASE_URL: `${BASE}/sb`, SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'service', STRIPE_SECRET_KEY: 'sk_test_local', STRIPE_WEBHOOK_SECRET: WHSEC, SITE_URL: BASE },
  fetchImpl: (url, init) => (String(url).startsWith('https://api.stripe.com') ? fakeStripe(url, init) : fetch(url, init)),
})

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.txt': 'text/plain', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json' }

createServer(async (req, res) => {
  const url = new URL(req.url, BASE)
  const chunks = []; for await (const c of req) chunks.push(c)
  const body = Buffer.concat(chunks).toString('utf8')
  const send = (status, data, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', ...headers }); res.end(typeof data === 'string' ? data : JSON.stringify(data)) }
  try {
    if (req.method === 'OPTIONS') return send(204, '', { 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' })
    if (url.pathname.startsWith('/sb/auth/v1/')) {
      if (url.pathname.endsWith('/token')) {
        const { email } = JSON.parse(body || '{}')
        const person = people.find((p) => p[1] === email)
        if (!person) return send(400, { error: 'invalid_grant', error_description: 'Invalid login credentials', code: 'invalid_credentials' })
        const user = { id: person[0], aud: 'authenticated', role: 'authenticated', email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() }
        return send(200, { access_token: jwtFor(person[0]), token_type: 'bearer', expires_in: 86400, expires_at: Math.floor(Date.now() / 1000) + 86400, refresh_token: 'r', user })
      }
      if (url.pathname.endsWith('/user')) { const sub = subOf(req.headers.authorization); const p = people.find((x) => x[0] === sub); return p ? send(200, { id: p[0], email: p[1], aud: 'authenticated', role: 'authenticated' }) : send(401, {}) }
      return send(204, '')
    }
    if (url.pathname.startsWith('/sb/rest/v1/')) {
      const service = req.headers.apikey === 'service'
      const sub = service ? null : subOf(req.headers.authorization)
      const role = service ? 'service_role' : sub ? 'authenticated' : 'anon'
      const name = url.pathname.slice('/sb/rest/v1/'.length)
      if (name.startsWith('rpc/')) {
        const args = JSON.parse(body || '{}'); const keys = Object.keys(args)
        try {
          const rows = await asRole(sub, role, `select public."${name.slice(4)}"(${keys.map((k, i) => `"${k}" => $${i + 1}`).join(', ')}) as v`, keys.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k])))
          const v = rows[0]?.v
          return v === null || v === undefined ? send(200, 'null') : send(200, JSON.stringify(v))
        } catch (error) { return send(error.code === '42501' ? 403 : 400, { message: error.message, code: error.code }) }
      }
      try {
        const { sql, params } = selectSql(name, url.searchParams)
        const rows = await asRole(sub, role, sql, params)
        const single = String(req.headers.accept ?? '').includes('vnd.pgrst.object')
        if (req.method === 'HEAD') return send(200, '', { 'Content-Range': `0-0/${rows.length}` })
        return send(200, single ? (rows[0] ?? null) : rows, { 'Content-Range': `0-${Math.max(rows.length - 1, 0)}/${rows.length}` })
      } catch { return send(200, []) }
    }
    if (url.pathname.startsWith('/api/')) {
      const result = await payments({ requestContext: { http: { method: req.method } }, rawPath: url.pathname, headers: req.headers, body, queryStringParameters: Object.fromEntries(url.searchParams) })
      return send(result.statusCode, result.body)
    }
    if (url.pathname === '/__stripe/checkout') {
      const s = stripeState.sessions.get(url.searchParams.get('cs'))?.session
      if (!s) return send(404, 'unknown session', { 'Content-Type': 'text/plain' })
      return send(200, `<!doctype html><meta name=viewport content="width=device-width"><title>Fake Stripe Checkout</title><body style="font-family:system-ui;max-width:420px;margin:3rem auto;padding:1rem">
        <p style="background:#fff3cd;padding:.5rem">LOCAL FAKE STRIPE (test harness)</p><h1>£${(s.amount_total / 100).toFixed(2)}</h1><p>${s.name}</p>
        <form method=post action="/__stripe/pay?cs=${s.id}"><button name=outcome value=paid style="font-size:1.1rem;padding:.8rem 1.4rem">Pay with test card 4242</button>
        <button name=outcome value=decline>Decline card</button></form><p><a href="${s.cancel_url}">Back to CAFF</a></p>`, { 'Content-Type': 'text/html' })
    }
    if (url.pathname === '/__stripe/pay') {
      const entry = stripeState.sessions.get(url.searchParams.get('cs')); const s = entry.session
      const pi = `pi_${s.id.slice(8)}`
      if (new URLSearchParams(body).get('outcome') === 'decline') {
        await sendWebhook('payment_intent.payment_failed', { id: pi, metadata: s.metadata, last_payment_error: { message: 'Your card was declined.' } })
        res.writeHead(303, { Location: `/__stripe/checkout?cs=${s.id}` }); return res.end()
      }
      stripeState.intents.set(pi, { amount: s.amount_total })
      setTimeout(() => void sendWebhook('checkout.session.completed', { ...s, payment_status: 'paid', status: 'complete', payment_intent: pi }), 1500)
      res.writeHead(303, { Location: s.success_url }); return res.end()
    }
    // Static site through the same routing function CloudFront runs.
    const routed = route({ request: { uri: url.pathname, querystring: {}, headers: {} } })
    if (routed.statusCode) { res.writeHead(routed.statusCode, { Location: routed.headers.location.value + url.search }); return res.end() }
    let file = join(ROOT, 'out', decodeURIComponent(routed.uri))
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(ROOT, 'out', '404.html')
    res.writeHead(file.endsWith('404.html') ? 404 : 200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
    res.end(readFileSync(file))
  } catch (error) { console.error(error); send(500, { message: String(error) }) }
}).listen(PORT, () => console.log(`CAFF e2e harness on ${BASE}`))
