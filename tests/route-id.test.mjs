import { test } from 'node:test'
import assert from 'node:assert/strict'
// Mirrors lib/route-id.ts idFromPath (kept dependency-free for node --test).
const idFromPath = (p) => { const parts = p.split('/').filter(Boolean); const last = parts[parts.length - 1] ?? ''; return last === '_' ? '' : decodeURIComponent(last) }
test('reads the id from the browser path', () => {
  assert.equal(idFromPath('/dashboard/matches/abc-123/'), 'abc-123')
  assert.equal(idFromPath('/dashboard/admin/matches/abc-123'), 'abc-123')
  assert.equal(idFromPath('/dashboard/player/a%20b/'), 'a b')
  assert.equal(idFromPath('/dashboard/matches/_/'), '')
})
