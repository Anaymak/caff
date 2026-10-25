// Dev-only. Requires the harness (tests/e2e/mock-server.mjs) and a build pointed at it; see docs/deployment.md.
// Headless Chrome (CDP) mobile audit against the local e2e harness. Usage: node mobile-audit.mjs <outDir> [quick]
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
const OUT = process.argv[2]; mkdirSync(OUT, { recursive: true })
const BASE = 'http://localhost:4310'
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-port=9333', `--user-data-dir=${OUT}/profile`, '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let target
for (let i = 0; i < 50 && !target; i++) { await sleep(200); try { target = (await (await fetch('http://127.0.0.1:9333/json/list')).json()).find((t) => t.type === 'page') } catch {} }
const ws = new WebSocket(target.webSocketDebuggerUrl); await new Promise((r) => ws.onopen = r)
let seq = 0; const pending = new Map(); const events = []
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) } else if (msg.method) events.push(msg) }
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description }
await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable'); await send('Log.enable')

const UA = { ios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36' }
const quick = process.argv[3] === 'quick'
const devices = quick ? [['iphone-375', 375, 812, 3, 'ios']] : [['iphone-se-320', 320, 568, 2, 'ios'], ['iphone-375', 375, 812, 3, 'ios'], ['iphone-390', 390, 844, 3, 'ios'], ['iphone-max-430', 430, 932, 3, 'ios'], ['android-360', 360, 800, 3, 'android'], ['android-412', 412, 915, 2.625, 'android'], ['desktop-1280', 1280, 800, 1, 'desktop']]
async function device([, w, h, dpr, os]) {
  const mobile = os !== 'desktop'
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile })
  await send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 0 })
  if (mobile) await send('Emulation.setUserAgentOverride', { userAgent: UA[os] })
}
async function go(path, wait = 2200) { events.length = 0; await send('Page.navigate', { url: BASE + path }); await sleep(wait) }
async function signIn(email) {
  await go('/auth/', 1500)
  await evaluate(`localStorage.clear(); location.reload()`); await sleep(1500)
  await evaluate(`(() => { const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) };
    set(document.querySelector('input[type=email]'), ${JSON.stringify(email)}); set(document.querySelector('input[type=password]'), 'local-e2e-only');
    document.querySelector('form button[type=submit], form button:not([type=button])').click() })()`)
  await sleep(2500)
}
const METRICS = `(() => {
  const W = document.documentElement.clientWidth, desc = (e) => e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className ? '.' + e.className.split(' ')[0] : '') + ':' + (e.innerText || e.value || e.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 22)
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' && !e.closest('details:not([open]) > :not(summary)') }
  const ctrls = [...document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,summary')].filter(vis)
  const small = ctrls.filter((e) => { const r = e.getBoundingClientRect(); const inline = e.tagName === 'A' && getComputedStyle(e).display === 'inline' && e.closest('p,li,small,td'); return !inline && !['checkbox', 'radio'].includes(e.type) && (r.height < 40 || r.width < 40) })
  const fixed = [...document.querySelectorAll('nav,header')].filter((e) => /fixed|sticky/.test(getComputedStyle(e).position))
  return { layoutViewport: innerWidth, deviceWidth: screen.width, overflowX: document.documentElement.scrollWidth - W,
    small: small.length + '/' + ctrls.length, smallSamples: [...new Set(small.map((e) => desc(e) + ' ' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height)))].slice(0, 5),
    inputsUnder16: [...document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=hidden]),select,textarea')].filter((e) => vis(e) && parseFloat(getComputedStyle(e).fontSize) < 16).length,
    h1: [...document.querySelectorAll('h1')].map((e) => e.innerText.slice(0, 40)), fixed: fixed.map((e) => e.className + ' ' + Math.round(e.getBoundingClientRect().height) + 'px') }
})()`
const issues = () => events.filter((e) => (e.method === 'Runtime.exceptionThrown') || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') || (e.method === 'Network.responseReceived' && e.params.response.status >= 400 && !/favicon/.test(e.params.response.url)) || e.method === 'Network.loadingFailed')
  .map((e) => e.method === 'Network.responseReceived' ? `HTTP ${e.params.response.status} ${e.params.response.url.replace(BASE, '')}` : e.method === 'Network.loadingFailed' ? `FAILED ${e.params.errorText}` : (e.params.entry?.text || e.params.exceptionDetails?.exception?.description || e.params.args?.map((a) => a.value).join(' ') || '').slice(0, 140))

const results = []
async function audit(role, pages, shotSet) {
  for (const dev of devices) {
    await device(dev)
    for (const [name, path] of pages) {
      await go(path)
      const m = await evaluate(METRICS)
      results.push({ role, device: dev[0], page: name, ...m, issues: issues() })
      if (shotSet.includes(name) && (dev[0] === 'iphone-375' || dev[0] === 'iphone-se-320' || dev[0] === 'desktop-1280')) {
        const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 60, captureBeyondViewport: true, clip: { x: 0, y: 0, width: dev[1], height: Math.min(await evaluate('document.documentElement.scrollHeight'), 2600), scale: 1 } })
        writeFileSync(`${OUT}/${role}-${name}-${dev[0]}.jpg`, Buffer.from(shot.result.data, 'base64'))
      }
    }
  }
}
const PAGES = JSON.parse(process.env.AUDIT_PAGES)
for (const [role, email, pages, shots] of PAGES) { await device(devices[0]); if (email) await signIn(email); else { await go('/auth/', 1000); await evaluate('localStorage.clear()') } await audit(role, pages, shots) }
if (!quick) { // landscape spot check
  await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 3, mobile: true, screenOrientation: { type: 'landscapePrimary', angle: 90 } })
  for (const [role, , pages] of PAGES.slice(-1)) for (const [name, path] of pages.slice(0, 3)) { await go(path); results.push({ role, device: 'iphone-landscape-844', page: name, ...(await evaluate(METRICS)), issues: issues() }) }
}
writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 1))
for (const r of results) console.log([r.role, r.device, r.page, `vp=${r.layoutViewport}/${r.deviceWidth}`, `ox=${r.overflowX}`, `small=${r.small}`, `in<16=${r.inputsUnder16}`, r.issues.length ? 'ISSUES ' + r.issues.join(' | ') : '', r.smallSamples.length ? 'eg ' + r.smallSamples.join('; ') : ''].filter(Boolean).join('  '))
ws.close(); chrome.kill()
