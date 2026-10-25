import assert from 'node:assert/strict'
import test from 'node:test'
import { allocationTotal, estimateFee, explainSplit, formatPence, parsePounds, previewSplit, splitPence, testSessionNote } from '../lib/domain/payments.ts'

const UK = { percentBps: 150, fixedPence: 20 }

test('fees: percentage plus a fixed fee for every separate payment', () => {
  assert.equal(estimateFee(600, UK), 29)
  assert.equal(estimateFee(625, UK), 29)
  assert.equal(estimateFee(0, UK), 0)
  assert.equal(previewSplit(6000, 10, 'ABSORB', UK).estimatedFees, 290, '10 × (9p + 20p), not 1.5% of £60')
})

test('split: £60/10, £75/12 and remainders that still add up', () => {
  assert.deepEqual(splitPence(6000, 10).shares, Array(10).fill(600))
  assert.equal(splitPence(7500, 12).base, 625)
  for (let total = 1; total < 3000; total += 37) for (let n = 1; n <= 22; n++) {
    const { shares } = splitPence(total, n)
    assert.equal(shares.reduce((a, b) => a + b, 0), total)
    assert.ok(Math.max(...shares) - Math.min(...shares) <= 1)
  }
  assert.match(explainSplit(5000, 3), /2 players pay £16\.67 and 1 pay £16\.66/)
})

test('cover-in-price total is the smallest that covers the pitch after fees', () => {
  for (const [pitch, n] of [[6000, 10], [7500, 12], [3000, 4], [10000, 22]]) {
    const total = allocationTotal(pitch, n, 'COVER_IN_PRICE', UK)
    const net = (t) => splitPence(t, n).shares.reduce((sum, s) => sum + s - estimateFee(s, UK), 0)
    assert.ok(net(total) >= pitch); assert.ok(net(total - 1) < pitch)
  }
  assert.equal(allocationTotal(6000, 10, 'ABSORB', UK), 6000)
})

test('money parsing and formatting never go through float rounding', () => {
  assert.equal(parsePounds('75'), 7500); assert.equal(parsePounds('£72.5'), 7250); assert.equal(parsePounds('0.29'), 29)
  assert.equal(parsePounds('1,250.00'), 125000)
  for (const bad of ['', '6.255', '-5', 'abc', '1e3']) assert.equal(parsePounds(bad), null)
  assert.equal(formatPence(625), '£6.25'); assert.equal(formatPence(-30), '−£0.30'); assert.equal(formatPence(123456), '£1,234.56'); assert.equal(formatPence(null), '—')
})

test('test-session banner reflects the mode of its card payments', () => {
  assert.match(testSessionNote([{ method: 'STRIPE', livemode: true }]), /real card payments taken in Stripe live mode\.$/)
  assert.match(testSessionNote([{ method: 'STRIPE', livemode: true }, { method: 'STRIPE', livemode: false }]), /live mode, as well as Stripe test-mode payments\./)
  assert.match(testSessionNote([{ method: 'STRIPE', livemode: false }, { method: 'CASH', livemode: null }]), /test mode and are not real money/)
  assert.match(testSessionNote([]), /still work and charge in the current Stripe mode/)
  assert.match(testSessionNote([{ method: 'CASH', livemode: null }]), /current Stripe mode/)
  assert.doesNotMatch(testSessionNote([{ method: 'STRIPE', livemode: true }]), /not real money/)
})
