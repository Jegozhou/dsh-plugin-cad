import { chromium } from 'playwright-core'
const tokenUrl = process.argv[2]
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
const page = await context.newPage()
const net = []
page.on('response', r => { const u = r.url(); if (/dsh-plugin-cad|plugins\?\?|\.glb/.test(u)) net.push(`${r.status()} ${u}`) })
const errors = []
page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text().slice(0, 300)) })
page.on('pageerror', err => errors.push('pageerror: ' + String(err).slice(0, 300)))
await page.goto(tokenUrl, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(5000)
// find the CAD nav entry
const cadCandidates = await page.evaluate(() => [...document.querySelectorAll('button,[role=button],a,[data-testid]')]
  .filter(el => (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim().toUpperCase() === 'CAD')
  .map(el => ({ tag: el.tagName, aria: el.getAttribute('aria-label'), title: el.getAttribute('title'), testid: el.getAttribute('data-testid'), text: (el.textContent||'').trim().slice(0,30), cls: el.className?.toString().slice(0,60) })))
console.log('CAD candidates:', JSON.stringify(cadCandidates, null, 2))
const target = page.locator('button:has-text("CAD"), [aria-label="CAD"], [title="CAD"]').first()
const count = await target.count()
console.log('locator count:', count)
if (count > 0) {
  const box = await target.boundingBox().catch(() => null)
  console.log('bounding box:', JSON.stringify(box))
  await target.dispatchEvent('click').catch(e => console.log('dispatch failed:', String(e).slice(0,200)))
  await page.waitForTimeout(8000)
}
await page.screenshot({ path: '/tmp/ui-cad-panel.png' })
const panel = await page.evaluate(() => {
  const testids = {}
  for (const el of document.querySelectorAll('[data-testid]')) {
    const key = el.getAttribute('data-testid')
    if (/cad/i.test(key)) testids[key] = (el.textContent || '').trim().slice(0, 80) || el.getAttribute('data-model-id') || el.tagName
  }
  const root = document.querySelector('[data-model-id]')
  return {
    testids,
    canvases: [...document.querySelectorAll('canvas')].map(c => ({ w: c.width, h: c.height, cls: c.className?.toString().slice(0, 60) })),
    modelRoot: root ? { modelId: root.getAttribute('data-model-id'), revisionId: root.getAttribute('data-revision-id') } : null,
    cadText: (document.body.innerText || '').split('\n').filter(l => /CAD|模型|revision|Revision|runtime|运行时/i.test(l)).slice(0, 25),
  }
})
console.log('PANEL:', JSON.stringify(panel, null, 2))
console.log('NET:', JSON.stringify(net.slice(0, 30), null, 2))
console.log('ERRORS:', JSON.stringify(errors.slice(0, 10), null, 2))
await browser.close()
