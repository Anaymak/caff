// CAFF payments API: AWS Lambda (Node.js 22, Function URL behind CloudFront /api/*).
// No dependencies: Stripe's REST API via fetch, webhook signatures via node:crypto.
// All money logic lives in Postgres (supabase/migrations/202610250001_*); this
// only talks to Stripe and passes verified facts to the database.
//
// Routes
//   GET  /api/pay/request?id=<uuid>      public: what a pay link is for
//   POST /api/pay/checkout {id}          public: Stripe Checkout URL for that request
//   POST /api/stripe/webhook             Stripe only (signature verified)
//   POST /api/admin/refund               admin JWT + payments.refund
//   POST /api/admin/expire-checkouts     admin JWT + payments.request
//   POST /api/admin/reconcile-fees       admin JWT + finance.view
//
// Environment: SUPABASE_URL, SUPABASE_ANON_KEY, SITE_URL and SECRETS_PATH. The
// secrets (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SUPABASE_SERVICE_ROLE_KEY)
// are SecureString parameters under SECRETS_PATH in SSM Parameter Store, read at
// cold start and cached for five minutes. Values are never logged.
//
// Status codes avoid 403/404 for API answers: CloudFront's custom error pages
// would replace them with the site's 404 page.
import { createHmac, timingSafeEqual } from 'node:crypto'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const HANDLED_EVENTS = new Set([
  'checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed',
  'checkout.session.expired', 'payment_intent.payment_failed', 'charge.updated', 'charge.dispute.created',
  'refund.created', 'refund.updated', 'refund.failed',
])

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

/** Stripe-Signature check (https://docs.stripe.com/webhooks#verify-manually). Throws on failure. */
export function verifyStripeSignature(rawBody, header, secret, { toleranceSeconds = 300, now = Date.now() / 1000 } = {}) {
  if (!header || !secret) throw new HttpError(400, 'Missing signature')
  const parts = header.split(',').map((item) => item.split('='))
  const timestamp = Number(parts.find(([k]) => k === 't')?.[1])
  const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v)
  if (!Number.isFinite(timestamp) || signatures.length === 0) throw new HttpError(400, 'Malformed signature')
  if (Math.abs(now - timestamp) > toleranceSeconds) throw new HttpError(400, 'Signature timestamp outside tolerance')
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest()
  const ok = signatures.some((sig) => {
    const given = Buffer.from(sig, 'hex')
    return given.length === expected.length && timingSafeEqual(given, expected)
  })
  if (!ok) throw new HttpError(400, 'Invalid signature')
}

export const stripeMode = (key = '') => (/^(sk|rk)_live_/.test(key) ? 'live' : 'test')

/** Stripe's form encoding for nested params: { metadata: { a: 1 } } -> metadata[a]=1. */
export function formEncode(value, prefix = '', out = new URLSearchParams()) {
  for (const [key, item] of Object.entries(value)) {
    const name = prefix ? `${prefix}[${key}]` : key
    if (item === undefined || item === null) continue
    if (typeof item === 'object') formEncode(item, name, out)
    else out.append(name, String(item))
  }
  return out
}

const SECRET_NAMES = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'SUPABASE_SERVICE_ROLE_KEY']
let cached = { at: 0, values: null }
async function loadSecrets(path) {
  if (cached.values && Date.now() - cached.at < 300000) return cached.values
  const { SSMClient, GetParametersByPathCommand } = await import('@aws-sdk/client-ssm')   // bundled in the Lambda runtime
  const result = await new SSMClient({}).send(new GetParametersByPathCommand({ Path: path, WithDecryption: true }))
  const values = Object.fromEntries((result.Parameters ?? []).map((item) => [item.Name.slice(path.length).replace(/^\//, ''), item.Value]))
  for (const name of SECRET_NAMES) if (!values[name]) throw new Error(`Missing parameter ${path}${name}`)
  cached = { at: Date.now(), values }
  return values
}

export function createHandler({ env: baseEnv = process.env, fetchImpl = globalThis.fetch, log = console } = {}) {
  let env = baseEnv
  let keyMode = stripeMode(env.STRIPE_SECRET_KEY)

  async function stripe(method, path, params, idempotencyKey) {
    const headers = { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Stripe-Version': '2024-06-20' }
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey
    let url = `https://api.stripe.com${path}`
    let body
    if (method === 'GET') { if (params) url += `?${formEncode(params)}` } else { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = formEncode(params ?? {}).toString() }
    const response = await fetchImpl(url, { method, headers, body })
    const json = await response.json().catch(() => ({}))
    if (!response.ok) {
      const error = new HttpError(502, json?.error?.message ?? `Stripe error ${response.status}`)
      error.stripeCode = json?.error?.code
      throw error
    }
    return json
  }

  // jwt: the signed-in admin's Supabase access token (permission checks run as them);
  // omitted: service role (Stripe-facing functions only).
  async function rpc(fn, args, jwt) {
    const key = jwt ? env.SUPABASE_ANON_KEY : env.SUPABASE_SERVICE_ROLE_KEY
    const headers = { apikey: key, 'Content-Type': 'application/json' }
    // New-style sb_publishable_/sb_secret_ keys go in apikey only; legacy JWT keys also as Bearer.
    if (jwt) headers.Authorization = `Bearer ${jwt}`
    else if (!key.startsWith('sb_')) headers.Authorization = `Bearer ${key}`
    const response = await fetchImpl(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(args),
    })
    const text = await response.text()
    const json = text ? JSON.parse(text) : null
    if (!response.ok) {
      const denied = response.status === 401 || response.status === 403 || json?.code === '42501'
      throw new HttpError(denied ? 401 : 400, json?.message ?? 'Database request failed')
    }
    return json
  }

  async function paymentIntentFee(paymentIntentId) {
    const pi = await stripe('GET', `/v1/payment_intents/${encodeURIComponent(paymentIntentId)}`, { 'expand[]': 'latest_charge.balance_transaction' })
    const charge = pi.latest_charge
    const txn = charge && typeof charge === 'object' ? charge.balance_transaction : null
    if (!txn || typeof txn !== 'object') return {}
    return { fee: txn.fee, balance_transaction: txn.id, charge: charge.id }
  }

  async function createCheckout(body) {
    const id = String(body?.id ?? '')
    if (!UUID.test(id)) throw new HttpError(400, 'Invalid payment link')
    const prep = await rpc('checkout_prepare', { p_request: id })
    if (!prep?.payable) return { status: 409, body: { reason: prep?.reason ?? 'not_found' } }
    if (prep.stripe_mode !== keyMode) {
      log.error('checkout refused: Stripe key mode does not match CAFF payment settings')
      throw new HttpError(503, 'Card payments are not available right now')
    }
    if (prep.reuse_url) return { status: 200, body: { url: prep.reuse_url } }
    const back = `${env.SITE_URL}/pay/?r=${id}`
    const metadata = { payment_request_id: id, session_id: prep.session_id, attendee_id: prep.attendee_id }
    const session = await stripe('POST', '/v1/checkout/sessions', {
      mode: 'payment',
      submit_type: 'pay',
      payment_method_types: ['card'],          // cards incl. Apple Pay / Google Pay; keeps fee estimates meaningful
      line_items: [{ quantity: 1, price_data: { currency: prep.currency, unit_amount: prep.amount_pence,
        product_data: { name: `CAFF pitch share: ${prep.description}`.slice(0, 250) } } }],
      client_reference_id: id,
      metadata,
      payment_intent_data: { metadata, description: `CAFF pitch share ${id}` },
      expires_at: prep.expires_at,
      success_url: `${back}&result=success`,
      cancel_url: `${back}&result=cancelled`,
    }, `caff-checkout-${id}-${prep.attempt}`)
    if (session.livemode !== (keyMode === 'live') || session.amount_total !== prep.amount_pence) throw new HttpError(502, 'Unexpected checkout from Stripe')
    await rpc('checkout_attach', { p_request: id, p_attempt: prep.attempt, p_checkout_id: session.id, p_url: session.url, p_livemode: session.livemode })
    return { status: 200, body: { url: session.url } }
  }

  async function webhook(rawBody, signature) {
    verifyStripeSignature(rawBody, signature, env.STRIPE_WEBHOOK_SECRET)
    const event = JSON.parse(rawBody)
    if (event.livemode !== (keyMode === 'live')) return { status: 200, body: { received: true, result: 'ignored_mode_mismatch' } }
    if (!HANDLED_EVENTS.has(event.type)) return { status: 200, body: { received: true, result: 'ignored' } }
    const object = event.data?.object ?? {}
    let extra = {}
    if (event.type.startsWith('checkout.session.') && object.payment_status === 'paid' && object.payment_intent) {
      extra = await paymentIntentFee(object.payment_intent).catch(() => ({}))   // fee can be reconciled later
    } else if (event.type === 'charge.updated' && typeof object.balance_transaction === 'string') {
      const txn = await stripe('GET', `/v1/balance_transactions/${encodeURIComponent(object.balance_transaction)}`)
      extra = { fee: txn.fee, balance_transaction: txn.id }
    }
    const result = await rpc('stripe_apply_event', { p_event_id: event.id, p_type: event.type, p_livemode: event.livemode, p_object: object, p_extra: extra })
    return { status: 200, body: { received: true, result } }
  }

  async function refund(body, jwt) {
    const begun = await rpc('refund_begin', { p_payment: body.paymentId, p_amount_pence: body.amountPence, p_reason: body.reason, p_client_token: body.clientToken }, jwt)
    if (begun.status !== 'PENDING') return { status: 200, body: { status: begun.status } }
    if (Boolean(begun.livemode) !== (keyMode === 'live')) throw new HttpError(409, 'This payment was taken in a different Stripe mode')
    try {
      const re = await stripe('POST', '/v1/refunds', { payment_intent: begun.payment_intent, amount: begun.amount_pence, reason: 'requested_by_customer',
        metadata: { refund_id: begun.refund_id } }, `caff-refund-${begun.refund_id}`)
      await rpc('refund_attach', { p_refund: begun.refund_id, p_stripe_refund_id: re.id, p_status: re.status, p_error: re.failure_reason ?? null })
      return { status: 200, body: { status: re.status } }
    } catch (error) {
      if (error instanceof HttpError && error.status === 502) {
        await rpc('refund_attach', { p_refund: begun.refund_id, p_stripe_refund_id: null, p_status: 'failed', p_error: error.message })
      }
      throw error
    }
  }

  async function expireCheckouts(body, jwt) {
    const ids = await rpc('admin_checkouts_to_expire', { p_session: body.sessionId }, jwt)
    let expired = 0
    for (const id of ids ?? []) {
      await stripe('POST', `/v1/checkout/sessions/${encodeURIComponent(id)}/expire`, {}).catch((error) => {
        if (error.stripeCode !== 'checkout_session_not_open' && !/expired|complete/i.test(error.message)) throw error
      })
      await rpc('checkout_mark_expired', { p_checkout_id: id })
      expired++
    }
    return { status: 200, body: { expired } }
  }

  async function reconcileFees(body, jwt) {
    const intents = (await rpc('admin_fees_to_reconcile', { p_session: body.sessionId }, jwt)) ?? []
    let updated = 0
    for (const pi of intents.slice(0, 50)) {
      const fee = await paymentIntentFee(pi)
      if (fee.fee !== undefined && await rpc('payment_set_actual_fee', { p_payment_intent: pi, p_charge: fee.charge, p_balance_txn: fee.balance_transaction, p_fee: fee.fee })) updated++
    }
    return { status: 200, body: { updated, checked: Math.min(intents.length, 50) } }
  }

  return async function handler(event) {
    const method = event.requestContext?.http?.method ?? 'GET'
    const path = (event.rawPath ?? '/').replace(/\/+$/, '')
    const headers = Object.fromEntries(Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
    if (baseEnv.SECRETS_PATH && !baseEnv.STRIPE_SECRET_KEY) {
      try { env = { ...baseEnv, ...(await loadSecrets(baseEnv.SECRETS_PATH)) }; keyMode = stripeMode(env.STRIPE_SECRET_KEY) }
      catch (error) { log.error(`payments config: ${error instanceof Error ? error.message : 'error'}`); return { statusCode: 503, headers: { 'Content-Type': 'application/json' }, body: '{"error":"Payments are not configured"}' } }
    }
    // The deployment declares its Stripe mode; a key of the other mode is never used.
    if (baseEnv.STRIPE_MODE && keyMode !== baseEnv.STRIPE_MODE) {
      log.error('payments config: Stripe key mode does not match the deployment STRIPE_MODE')
      return { statusCode: 503, headers: { 'Content-Type': 'application/json' }, body: '{"error":"Payments are not configured"}' }
    }
    const raw = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : ''
    try {
      let result
      if (method === 'POST' && path === '/api/stripe/webhook') result = await webhook(raw, headers['stripe-signature'])
      else if (method === 'GET' && path === '/api/pay/request') {
        const id = event.queryStringParameters?.id ?? ''
        if (!UUID.test(id)) throw new HttpError(400, 'Invalid payment link')
        const summary = await rpc('payment_request_public', { p_request: id })
        result = summary ? { status: 200, body: { ...summary, mode: keyMode } } : { status: 400, body: { error: 'Payment link not found' } }
      } else if (method === 'POST' && path === '/api/pay/checkout') result = await createCheckout(JSON.parse(raw || '{}'))
      else if (method === 'POST' && path.startsWith('/api/admin/')) {
        const jwt = (headers.authorization ?? '').replace(/^Bearer\s+/i, '')
        if (!jwt) throw new HttpError(401, 'Sign in again')
        const body = JSON.parse(raw || '{}')
        if (body.sessionId !== undefined && !UUID.test(String(body.sessionId))) throw new HttpError(400, 'Invalid session')
        if (path === '/api/admin/refund') {
          if (!UUID.test(String(body.paymentId)) || !UUID.test(String(body.clientToken)) || !Number.isInteger(body.amountPence)) throw new HttpError(400, 'Invalid refund')
          result = await refund(body, jwt)
        } else if (path === '/api/admin/expire-checkouts') result = await expireCheckouts(body, jwt)
        else if (path === '/api/admin/reconcile-fees') result = await reconcileFees(body, jwt)
      }
      if (!result) result = { status: 404, body: { error: 'Not found' } }
      return { statusCode: result.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(result.body) }
    } catch (error) {
      const status = error instanceof HttpError ? error.status : error instanceof SyntaxError ? 400 : 500
      // Message only: never the request body, headers or keys.
      log.error(`payments ${method} ${path} -> ${status}: ${error instanceof Error ? error.message : 'error'}`)
      const message = status >= 500 && !(error instanceof HttpError) ? 'Something went wrong. Please try again.' : error.message
      return { statusCode: status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify({ error: message }) }
    }
  }
}

export const handler = createHandler()
