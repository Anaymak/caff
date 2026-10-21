import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The CloudFront Function deployed by infra/caff-site.yaml must be exactly the tested infra/viewer-request.js.
const normalise = (s) => s.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() && !l.trim().startsWith('//') && !l.includes('module.exports')).map((l) => l.trim()).join('\n')

test('template FunctionCode matches infra/viewer-request.js', () => {
  const yaml = readFileSync(new URL('../infra/caff-site.yaml', import.meta.url), 'utf8')
  const block = yaml.split('FunctionCode: |\n')[1].split(/\n  [A-Za-z]+:\n/)[0]
  const js = readFileSync(new URL('../infra/viewer-request.js', import.meta.url), 'utf8')
  assert.equal(normalise(block), normalise(js))
})
