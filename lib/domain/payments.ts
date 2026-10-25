// Pitch cost sharing arithmetic in integer pence. The database
// (supabase/migrations/202610250001_pitch_sessions_payments.sql) is the
// authority for amounts that are charged; this mirrors it for previews and
// explanations, and tests/payments-sql.test.mjs checks the two agree.

export type FeeMode = 'ABSORB' | 'COVER_IN_PRICE'
export interface FeeAssumption { percentBps: number; fixedPence: number }

export const DEFAULT_FEES: FeeAssumption = { percentBps: 150, fixedPence: 20 }

/** Estimated Stripe fee for one payment: percentage (half-up) plus the fixed per-transaction fee. */
export function estimateFee(amountPence: number, fees: FeeAssumption): number {
  if (amountPence <= 0) return 0
  return Math.round((amountPence * fees.percentBps) / 10000) + fees.fixedPence
}

/** Splits a total into `count` shares; the first `remainder` shares carry one extra penny. */
export function splitPence(totalPence: number, count: number) {
  if (count <= 0) return { base: 0, remainder: 0, shares: [] as number[] }
  const base = Math.floor(totalPence / count)
  const remainder = totalPence - base * count
  return { base, remainder, shares: Array.from({ length: count }, (_, i) => base + (i < remainder ? 1 : 0)) }
}

function netAfterFees(total: number, count: number, fees: FeeAssumption) {
  return splitPence(total, count).shares.reduce((sum, share) => sum + share - estimateFee(share, fees), 0)
}

/**
 * The amount divided between players. ABSORB: the pitch cost (CAFF pays the
 * card fees). COVER_IN_PRICE: the smallest total whose equal shares still cover
 * the pitch after estimated fees. Every player pays the same price whatever the
 * payment method, so this is pricing, not a card surcharge.
 */
export function allocationTotal(pitchPence: number, count: number, mode: FeeMode, fees: FeeAssumption): number {
  if (count <= 0 || pitchPence <= 0 || mode === 'ABSORB') return Math.max(pitchPence, 0)
  let total = Math.max(pitchPence, Math.ceil((pitchPence + count * fees.fixedPence) / (1 - fees.percentBps / 10000)) - count)
  while (total > pitchPence && netAfterFees(total - 1, count, fees) >= pitchPence) total--
  while (netAfterFees(total, count, fees) < pitchPence) total++
  return total
}

export function previewSplit(pitchPence: number, count: number, mode: FeeMode, fees: FeeAssumption) {
  const total = allocationTotal(pitchPence, count, mode, fees)
  const { base, remainder, shares } = splitPence(total, count)
  const estimatedFees = shares.reduce((sum, share) => sum + estimateFee(share, fees), 0)
  return { total, base, remainder, estimatedFees, expectedNet: total - estimatedFees, feeCover: total - pitchPence }
}

/** "£6.25". Pence in, pounds out, never via floating-point arithmetic on the stored value. */
export function formatPence(pence: number | null | undefined): string {
  if (pence === null || pence === undefined) return '—'
  const sign = pence < 0 ? '−' : ''
  const abs = Math.abs(Math.trunc(pence))
  return `${sign}£${Math.floor(abs / 100).toLocaleString('en-GB')}.${String(abs % 100).padStart(2, '0')}`
}

/** Parses "75", "75.5", "£75.50" into pence; null for anything else (no rounding of extra digits). */
export function parsePounds(input: string): number | null {
  const match = input.trim().replace(/^£/, '').replace(/,/g, '').match(/^(\d{1,6})(?:\.(\d{1,2}))?$/)
  if (!match) return null
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
}

export function explainSplit(total: number, count: number): string {
  if (count === 0) return 'No confirmed, chargeable players yet.'
  const { base, remainder } = splitPence(total, count)
  if (remainder === 0) return `${formatPence(total)} ÷ ${count} = ${formatPence(base)} each.`
  return `${formatPence(total)} ÷ ${count} does not divide exactly, so ${remainder} ${remainder === 1 ? 'player pays' : 'players pay'} ${formatPence(base + 1)} and ${count - remainder} pay ${formatPence(base)}. The extra pennies rotate between sessions; the shares add up to exactly ${formatPence(total)}.`
}

// Banner text for a session flagged as test: the flag only hides it, so say what its card payments really were.
export function testSessionNote(payments: { method: string; livemode: boolean | null }[]): string {
  const card = payments.filter((p) => p.method === 'STRIPE')
  const base = 'Kept for the record but excluded from normal session lists, player views and reporting.'
  if (card.some((p) => p.livemode)) return `${base} It includes real card payments taken in Stripe live mode${card.some((p) => p.livemode === false) ? ', as well as Stripe test-mode payments' : ''}.`
  if (card.length > 0) return `${base} Its card payments were made in Stripe test mode and are not real money.`
  return `${base} Its payment links still work and charge in the current Stripe mode.`
}

// Player-facing label for a pay link. After Stripe's redirect the webhook may lag, so a link still marked payable reads
// Processing (never Due) until the verified webhook flips it to Paid.
export function payStatus(link: { status: string; payable: boolean; session_status: string }, returnedFromCheckout: boolean): string {
  if (link.session_status === 'CANCELLED') return 'CANCELLED'
  if (returnedFromCheckout && link.payable) return 'PROCESSING'
  if (link.payable) return link.status === 'FAILED' ? 'FAILED' : 'DUE'
  return link.status
}
