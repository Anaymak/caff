// Payments Lambda with Stripe and Supabase replaced by an in-process fake fetch.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createHandler, formEncode, stripeMode, verifyStripeSignature } from '../payments/handler.mjs'

const SECRET = 'whsec_test_secret'
const env = { SUPABASE_URL: 'https://db.example.test', SUPABASE_ANON_KEY: 'anon-key', SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  STRIPE_SECRET_KEY: 'sk_test_123', STRIPE_WEBHOOK_SECRET: SECRET, SITE_URL: 'https://caff.example.test' }
const REQ = '6f1c2b0e-1d2a-4c3b-9f8e-0a1b2c3d4e5f'

function sign(body, t = Math.floor(Date.now() / 1000), secret = SECRET) {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`
}

function fake(routes) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, ...init })
    const key = `${init.method ?? 'GET'} ${url.split('?')[0]}`
    const route = routes[key]
    if (!route) throw new Error(`unexpected ${key}`)
    const { status = 200, json } = typeof route === 'function' ? route(init, url) : route
    return { ok: status < 400, status, json: async () => json, text: async () => (json === undefined ? '' : JSON.stringify(json)) }
  }
  return { calls, fetchImpl }
}
const silent = { error: () => {} }
const call = (handler, method, path, { body, headers = {}, query } = {}) => handler({ requestContext: { http: { method } }, rawPath: path, headers, body, queryStringParameters: query })

test('signature verification accepts Stripe signatures and rejects tampering, replays and wrong secrets', () => {
  const body = '{"id":"evt_1"}'
  verifyStripeSignature(body, sign(body), SECRET)
  assert.throws(() => verifyStripeSignature(body + ' ', sign(body), SECRET), /Invalid signature/)
  assert.throws(() => verifyStripeSignature(body, sign(body, Math.floor(Date.now() / 1000) - 3600), SECRET), /tolerance/)
  assert.throws(() => verifyStripeSignature(body, sign(body, undefined, 'whsec_other'), SECRET), /Invalid signature/)
  assert.throws(() => verifyStripeSignature(body, undefined, SECRET), /Missing/)
  assert.throws(() => verifyStripeSignature(body, 't=abc', SECRET), /Malformed/)
})

test('helpers: Stripe form encoding and key mode', () => {
  assert.equal(formEncode({ a: 1, m: { x: 'y' }, l: [{ q: 2 }], n: null }).toString(), 'a=1&m%5Bx%5D=y&l%5B0%5D%5Bq%5D=2')
  assert.equal(stripeMode('sk_test_x'), 'test'); assert.equal(stripeMode('sk_live_x'), 'live'); assert.equal(stripeMode('rk_live_x'), 'live'); assert.equal(stripeMode(''), 'test')
})

test('webhook: invalid signature is rejected before touching the database', async () => {
  const { calls, fetchImpl } = fake({})
  const handler = createHandler({ env, fetchImpl, log: silent })
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', livemode: false, data: { object: {} } })
  const res = await call(handler, 'POST', '/api/stripe/webhook', { body, headers: { 'Stripe-Signature': sign(body, undefined, 'whsec_wrong') } })
  assert.equal(res.statusCode, 400); assert.equal(calls.length, 0)
})

test('webhook: verified checkout completion fetches the actual fee and applies the event once', async () => {
  let applied
  const { calls, fetchImpl } = fake({
    'GET https://api.stripe.com/v1/payment_intents/pi_1': { json: { id: 'pi_1', latest_charge: { id: 'ch_1', balance_transaction: { id: 'txn_1', fee: 29 } } } },
    'POST https://db.example.test/rest/v1/rpc/stripe_apply_event': (init) => { applied = JSON.parse(init.body); return { json: 'paid' } },
  })
  const handler = createHandler({ env, fetchImpl, log: silent })
  const object = { id: 'cs_1', payment_status: 'paid', payment_intent: 'pi_1', amount_total: 600, metadata: { payment_request_id: REQ } }
  const body = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', livemode: false, data: { object } })
  const res = await call(handler, 'POST', '/api/stripe/webhook', { body: Buffer.from(body).toString('base64'), headers: { 'stripe-signature': sign(body) } })
  // Function URLs may base64-encode the body; isBase64Encoded is false here so it must fail verification...
  assert.equal(res.statusCode, 400)
  const ok = await handler({ requestContext: { http: { method: 'POST' } }, rawPath: '/api/stripe/webhook', headers: { 'stripe-signature': sign(body) }, body: Buffer.from(body).toString('base64'), isBase64Encoded: true })
  assert.equal(ok.statusCode, 200); assert.equal(JSON.parse(ok.body).result, 'paid')
  assert.deepEqual(applied.p_extra, { fee: 29, balance_transaction: 'txn_1', charge: 'ch_1' })
  assert.equal(applied.p_event_id, 'evt_1'); assert.equal(applied.p_object.id, 'cs_1')
  const dbCall = calls.find((c) => c.url.endsWith('stripe_apply_event'))
  assert.equal(dbCall.headers.Authorization, 'Bearer service-key')
  const modern = fake({ 'POST https://db.example.test/rest/v1/rpc/payment_request_public': { json: { id: REQ } } })
  await call(createHandler({ env: { ...env, SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_x' }, fetchImpl: modern.fetchImpl, log: silent }), 'GET', '/api/pay/request', { query: { id: REQ } })
  assert.equal(modern.calls[0].headers.apikey, 'sb_secret_x'); assert.equal(modern.calls[0].headers.Authorization, undefined, 'sb_secret keys are never sent as a Bearer token')
  assert.equal(calls.find((c) => c.url.includes('api.stripe.com')).headers.Authorization, 'Bearer sk_test_123')
})

test('webhook: live events are ignored by a test-mode deployment; unknown types are acknowledged', async () => {
  const { calls, fetchImpl } = fake({})
  const handler = createHandler({ env, fetchImpl, log: silent })
  for (const [livemode, type, expected] of [[true, 'checkout.session.completed', 'ignored_mode_mismatch'], [false, 'customer.created', 'ignored']]) {
    const body = JSON.stringify({ id: 'evt_2', type, livemode, data: { object: {} } })
    const res = await call(handler, 'POST', '/api/stripe/webhook', { body, headers: { 'stripe-signature': sign(body) } })
    assert.equal(res.statusCode, 200); assert.equal(JSON.parse(res.body).result, expected)
  }
  assert.equal(calls.length, 0)
})

test('webhook: a database failure returns 500 so Stripe retries', async () => {
  const { fetchImpl } = fake({ 'POST https://db.example.test/rest/v1/rpc/stripe_apply_event': { status: 503, json: { message: 'down' } } })
  const handler = createHandler({ env, fetchImpl, log: silent })
  const body = JSON.stringify({ id: 'evt_3', type: 'checkout.session.expired', livemode: false, data: { object: { id: 'cs_1' } } })
  const res = await call(handler, 'POST', '/api/stripe/webhook', { body, headers: { 'stripe-signature': sign(body) } })
  assert.ok(res.statusCode >= 400)
})

test('checkout: amount comes from the database, never the browser; idempotency key per attempt', async () => {
  let stripeBody, stripeHeaders, attached
  const { fetchImpl } = fake({
    'POST https://db.example.test/rest/v1/rpc/checkout_prepare': { json: { payable: true, attempt: 2, expires_at: 1900000000, amount_pence: 625, currency: 'gbp',
      request_id: REQ, session_id: 's1', attendee_id: 'a1', description: 'Thursday 5-a-side · Thu 30 Oct 2026 19:00', stripe_mode: 'test' } },
    'POST https://api.stripe.com/v1/checkout/sessions': (init) => { stripeBody = new URLSearchParams(init.body); stripeHeaders = init.headers
      return { json: { id: 'cs_9', url: 'https://checkout.stripe.com/c/pay/cs_9', livemode: false, amount_total: 625 } } },
    'POST https://db.example.test/rest/v1/rpc/checkout_attach': (init) => { attached = JSON.parse(init.body); return { status: 204 } },
  })
  const handler = createHandler({ env, fetchImpl, log: silent })
  const res = await call(handler, 'POST', '/api/pay/checkout', { body: JSON.stringify({ id: REQ, amount: 1 }) })
  assert.equal(res.statusCode, 200); assert.equal(JSON.parse(res.body).url, 'https://checkout.stripe.com/c/pay/cs_9')
  assert.equal(stripeBody.get('line_items[0][price_data][unit_amount]'), '625')
  assert.equal(stripeBody.get('metadata[payment_request_id]'), REQ); assert.equal(stripeBody.get('client_reference_id'), REQ)
  assert.equal(stripeBody.get('payment_intent_data[metadata][payment_request_id]'), REQ)
  assert.equal(stripeBody.get('mode'), 'payment'); assert.equal(stripeBody.get('payment_intent_data[setup_future_usage]'), null, 'cards are not saved')
  assert.equal(stripeBody.get('expires_at'), '1900000000')
  assert.equal(stripeHeaders['Idempotency-Key'], `caff-checkout-${REQ}-2`)
  assert.deepEqual(attached, { p_request: REQ, p_attempt: 2, p_checkout_id: 'cs_9', p_url: 'https://checkout.stripe.com/c/pay/cs_9', p_livemode: false })
})

test('checkout: unpayable requests, mode mismatch, reuse and invalid ids', async () => {
  const responses = [{ payable: false, reason: 'paid' }, { payable: true, stripe_mode: 'live', attempt: 1 }, { payable: true, reuse_url: 'https://checkout.stripe.com/c/pay/cs_open', stripe_mode: 'test' }]
  const { calls, fetchImpl } = fake({ 'POST https://db.example.test/rest/v1/rpc/checkout_prepare': () => ({ json: responses.shift() }) })
  const handler = createHandler({ env, fetchImpl, log: silent })
  const body = JSON.stringify({ id: REQ })
  const paid = await call(handler, 'POST', '/api/pay/checkout', { body })
  assert.equal(paid.statusCode, 409); assert.equal(JSON.parse(paid.body).reason, 'paid')
  assert.equal((await call(handler, 'POST', '/api/pay/checkout', { body })).statusCode, 503)
  assert.equal(JSON.parse((await call(handler, 'POST', '/api/pay/checkout', { body })).body).url, 'https://checkout.stripe.com/c/pay/cs_open')
  assert.equal((await call(handler, 'POST', '/api/pay/checkout', { body: JSON.stringify({ id: "1' or 1=1" }) })).statusCode, 400)
  assert.ok(!calls.some((c) => c.url.includes('api.stripe.com')), 'no Stripe call in any of these cases')
})

test('admin endpoints require a JWT and run permission checks as that user', async () => {
  let refundHeaders, stripeRefund
  const { fetchImpl } = fake({
    'POST https://db.example.test/rest/v1/rpc/refund_begin': (init) => { refundHeaders = init.headers
      return init.headers.Authorization === 'Bearer player-jwt' ? { status: 403, json: { message: 'PERMISSION_DENIED: payments.refund is required', code: '42501' } }
        : { json: { refund_id: 'r1', payment_intent: 'pi_1', amount_pence: 600, status: 'PENDING', livemode: false } } },
    'POST https://api.stripe.com/v1/refunds': (init) => { stripeRefund = { body: new URLSearchParams(init.body), key: init.headers['Idempotency-Key'] }; return { json: { id: 're_1', status: 'pending' } } },
    'POST https://db.example.test/rest/v1/rpc/refund_attach': { status: 204 },
  })
  const handler = createHandler({ env, fetchImpl, log: silent })
  const body = JSON.stringify({ paymentId: REQ, amountPence: 600, reason: 'Could not play', clientToken: REQ })
  assert.equal((await call(handler, 'POST', '/api/admin/refund', { body })).statusCode, 401)
  const denied = await call(handler, 'POST', '/api/admin/refund', { body, headers: { Authorization: 'Bearer player-jwt' } })
  assert.equal(denied.statusCode, 401)
  const ok = await call(handler, 'POST', '/api/admin/refund', { body, headers: { Authorization: 'Bearer owner-jwt' } })
  assert.equal(ok.statusCode, 200)
  assert.equal(refundHeaders.apikey, 'anon-key', 'user calls use the anon key plus the user JWT, not the service role')
  assert.equal(stripeRefund.key, 'caff-refund-r1'); assert.equal(stripeRefund.body.get('amount'), '600'); assert.equal(stripeRefund.body.get('metadata[refund_id]'), 'r1')
  assert.equal((await call(handler, 'POST', '/api/admin/refund', { body: JSON.stringify({ paymentId: REQ, amountPence: 6.5, clientToken: REQ }), headers: { Authorization: 'Bearer owner-jwt' } })).statusCode, 400)
})

test('public pay summary and unknown routes', async () => {
  const { fetchImpl } = fake({ 'POST https://db.example.test/rest/v1/rpc/payment_request_public': { json: { id: REQ, amount_pence: 600, payable: true } } })
  const handler = createHandler({ env, fetchImpl, log: silent })
  const res = await call(handler, 'GET', '/api/pay/request', { query: { id: REQ } })
  assert.equal(res.statusCode, 200); assert.equal(JSON.parse(res.body).mode, 'test')
  assert.equal(res.headers['Cache-Control'], 'no-store')
  assert.equal((await call(handler, 'GET', '/api/pay/request', { query: { id: 'x' } })).statusCode, 400)
  assert.equal((await call(handler, 'GET', '/api/nope')).statusCode, 404)
})

test('a deployment declared as test refuses a live key (and vice versa)', async () => {
  const { calls, fetchImpl } = fake({})
  for (const [mode, key] of [['test', 'sk_live_x'], ['live', 'rk_test_x']]) {
    const handler = createHandler({ env: { ...env, STRIPE_MODE: mode, STRIPE_SECRET_KEY: key }, fetchImpl, log: silent })
    const res = await call(handler, 'POST', '/api/pay/checkout', { body: JSON.stringify({ id: REQ }) })
    assert.equal(res.statusCode, 503)
  }
  assert.equal(calls.length, 0, 'nothing reaches Stripe or the database')
})

test('health: Owner only, reports mode and readiness without secret values', async () => {
  const { fetchImpl } = fake({
    'POST https://db.example.test/rest/v1/rpc/my_finance_permissions': (init) => ({ json: init.headers.Authorization === 'Bearer owner-jwt' ? ['owner'] : ['finance.view'] }),
    'GET https://api.stripe.com/v1/balance': { json: { object: 'balance', livemode: false } },
    'POST https://db.example.test/rest/v1/rpc/payment_request_public': { json: null },
  })
  const handler = createHandler({ env: { ...env, STRIPE_MODE: 'test', SECRETS_PATH: '/caff/payments/' }, fetchImpl, log: silent })
  assert.equal((await call(handler, 'POST', '/api/admin/health', { body: '{}', headers: { Authorization: 'Bearer admin-jwt' } })).statusCode, 401)
  const res = await call(handler, 'POST', '/api/admin/health', { body: '{}', headers: { Authorization: 'Bearer owner-jwt' } })
  const report = JSON.parse(res.body)
  assert.equal(report.ready, true); assert.equal(report.key_mode, 'test'); assert.equal(report.stripe_livemode, false); assert.equal(report.key_type, 'sk_')
  assert.ok(!res.body.includes('sk_test_123') && !res.body.includes(SECRET) && !res.body.includes('service-key'), 'no secret values in the report')
})
