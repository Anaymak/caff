import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { handler } = createRequire(import.meta.url)('../infra/viewer-request.js')
const run = (uri, querystring = {}) => handler({ request: { uri, querystring, headers: {} } })
const id = '6f1c2b0e-1d2a-4c3b-9f8e-0a1b2c3d4e5f'

test('directory URLs serve index.html', () => {
  assert.equal(run('/').uri, '/index.html')
  assert.equal(run('/auth/').uri, '/auth/index.html')
  assert.equal(run('/dashboard/matches/').uri, '/dashboard/matches/index.html')
})
test('extensionless URLs redirect to the trailing slash, keeping the query', () => {
  const r = run('/dashboard', { tab: { value: 'x' } })
  assert.equal(r.statusCode, 301); assert.equal(r.headers.location.value, '/dashboard/?tab=x')
  assert.equal(run('/dashboard/matches/' + id).headers.location.value, '/dashboard/matches/' + id + '/')
})
test('dynamic ids are served by the "_" page', () => {
  assert.equal(run('/dashboard/matches/' + id + '/').uri, '/dashboard/matches/_/index.html')
  assert.equal(run('/dashboard/player/' + id + '/').uri, '/dashboard/player/_/index.html')
  assert.equal(run('/dashboard/admin/matches/' + id + '/').uri, '/dashboard/admin/matches/_/index.html')
})
test('RSC payloads for dynamic ids are rewritten too', () => {
  assert.equal(run('/dashboard/matches/' + id + '/index.txt').uri, '/dashboard/matches/_/index.txt')
  assert.equal(run('/dashboard/matches/' + id + '/__next.dashboard.matches.$d$id.__PAGE__.txt').uri, '/dashboard/matches/_/__next.dashboard.matches.$d$id.__PAGE__.txt')
})
test('static assets and non-dynamic pages pass through', () => {
  assert.equal(run('/_next/static/chunks/a.js').uri, '/_next/static/chunks/a.js')
  assert.equal(run('/dashboard/matches/index.txt').uri, '/dashboard/matches/index.txt')
  assert.equal(run('/dashboard/admin/people/').uri, '/dashboard/admin/people/index.html')
  assert.equal(run('/dashboard/matches/_/').uri, '/dashboard/matches/_/index.html')
})
test('non-canonical hosts redirect to https://caffleague.com, keeping path and query', () => {
  const r = handler({ request: { uri: '/dashboard/matches/', querystring: { a: { value: '1' } }, headers: { host: { value: 'www.caffleague.com' } } } })
  assert.equal(r.statusCode, 301); assert.equal(r.headers.location.value, 'https://caffleague.com/dashboard/matches/?a=1')
  assert.equal(handler({ request: { uri: '/', querystring: {}, headers: { host: { value: 'www.caffleague.com' } } } }).headers.location.value, 'https://caffleague.com/')
  assert.equal(handler({ request: { uri: '/auth/', querystring: {}, headers: { host: { value: 'caffleague.com' } } } }).uri, '/auth/index.html')
  const old = handler({ request: { uri: '/dashboard/matches/' + 'abc' + '/', querystring: { type: { value: 'signup' } }, headers: { host: { value: 'caff.anaysprojects.com' } } } })
  assert.equal(old.statusCode, 301); assert.equal(old.headers.location.value, 'https://caffleague.com/dashboard/matches/abc/?type=signup')
  assert.equal(handler({ request: { uri: '/x.js', querystring: {}, headers: { host: { value: 'd2h2djtswdb4sj.cloudfront.net' } } } }).statusCode, 301)
})
