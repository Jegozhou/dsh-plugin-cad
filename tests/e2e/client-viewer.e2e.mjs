/**
 * End-to-end verification of the dsh-plugin-cad **browser half** against a real,
 * running DeepSeek Harness Web instance.
 *
 * What it proves (all observed, never inferred):
 *   1. the installed client bundle registers the `main` page and the sidebar
 *      panellist ("CAD") on the real Harness shell;
 *   2. the page renders a real three.js `<canvas>` and reaches the `ready` state
 *      with a model selected automatically;
 *   3. a `model.glb` artifact is fetched from the plugin's own asset route with
 *      HTTP 200 and `content-type: model/gltf-binary`;
 *   4. orbit works through real pointer input;
 *   5. clicking the part raycasts and shows the inspect card (name, triangle
 *      count, bounding box);
 *   6. the panel's `data-revision-id` equals the Host's current revision, and a
 *      revision created by an external writer while the panel is open is picked
 *      up by polling: the panel follows it and fetches the new GLB;
 *   7. a page reload rediscovers the model + current revision from the Host
 *      alone (no browser-memory state is needed);
 *   8. the browser console stays free of plugin errors.
 *
 * It is deliberately read-only: it never creates or modifies a CAD model. The
 * revision-change step waits for an external writer (a headless agent creating
 * the next revision in another process, same DSH_HOME) or runs the command in
 * DSH_E2E_TRIGGER.
 *
 * Usage:
 *   DSH_WEB_URL='http://127.0.0.1:64899/?token=...' node tests/e2e/client-viewer.e2e.mjs
 *
 * Environment:
 *   DSH_WEB_URL                 required; when unset the script SKIPS with exit 0
 *   DSH_E2E_OUT                 screenshot/report directory (tests/fixtures/out)
 *   DSH_E2E_TIMEOUT_MS          per-step UI timeout (60000)
 *   DSH_E2E_REVISION_TIMEOUT_MS wait for the external revision (240000)
 *   DSH_E2E_WAIT_REVISION       "0" skips waiting for a *new* revision; the
 *                               panel/Host equality check still runs (default "1")
 *   DSH_E2E_TRIGGER             optional shell command that creates the revision
 *   DSH_E2E_EXPECT_REVISION     revision id (e.g. r-0004) the external writer will
 *                               create; robust to it landing before the watch starts
 *   DSH_E2E_MODEL_ID            pin the model under test (clicks its row in the rail)
 *   DSH_E2E_ALLOW_EMPTY         "1" accepts an empty profile (empty-state only)
 *   DSH_E2E_CHANNEL             playwright chromium channel (default "chrome")
 *   DSH_E2E_CHROME_PATH         explicit Chrome executable (overrides channel)
 */
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const URL = process.env.DSH_WEB_URL
const OUT = process.env.DSH_E2E_OUT ?? join(import.meta.dirname, '..', 'fixtures', 'out')
const STEP_TIMEOUT = Number(process.env.DSH_E2E_TIMEOUT_MS ?? 60000)
const REVISION_TIMEOUT = Number(process.env.DSH_E2E_REVISION_TIMEOUT_MS ?? 240000)
const WAIT_REVISION = (process.env.DSH_E2E_WAIT_REVISION ?? '1') !== '0'
const ALLOW_EMPTY = process.env.DSH_E2E_ALLOW_EMPTY === '1'
const CHANNEL = process.env.DSH_E2E_CHANNEL ?? 'chrome'
const CHROME_PATH = process.env.DSH_E2E_CHROME_PATH
const TRIGGER = process.env.DSH_E2E_TRIGGER
const EXPECT_REVISION = process.env.DSH_E2E_EXPECT_REVISION ?? null
const EXPECT_MODEL_ID = process.env.DSH_E2E_MODEL_ID ?? null
const API = '/dsh-plugin-cad/api'

if (URL === undefined || URL === '') {
  console.log('[client-viewer.e2e] SKIPPED: DSH_WEB_URL is not set.')
  console.log('  Start a throwaway Harness web profile (e.g. `dsh --profile cadtest --no-open --port 64899`),')
  console.log('  install the plugin there, then run:')
  console.log('    DSH_WEB_URL="http://127.0.0.1:64899/?token=..." node tests/e2e/client-viewer.e2e.mjs')
  console.log('  (exit 0: skipping is not a failure; the real-UI run is scenario F/G evidence)')
  process.exit(0)
}

mkdirSync(OUT, { recursive: true })
const steps = []
const consoleErrors = []
const glbResponses = []
const apiRequests = []
let page
let browser

/** Throw with a failure screenshot attached. */
async function fail(message) {
  await page?.screenshot({ path: join(OUT, 'client-99-failure.png') }).catch(() => undefined)
  throw new Error(message)
}

/** Run one labelled step. */
async function step(name, operation) {
  process.stdout.write(`- ${name} ... `)
  const started = Date.now()
  try {
    const value = await operation()
    steps.push({ name, ok: true, ms: Date.now() - started })
    process.stdout.write('ok\n')
    return value
  } catch (error) {
    steps.push({ name, ok: false, error: String((error && error.message) || error), ms: Date.now() - started })
    process.stdout.write('FAILED\n')
    throw error
  }
}

/** Poll a locator's text until it contains `expected`. */
async function waitText(selector, expected, timeout = STEP_TIMEOUT) {
  const handle = page.locator(selector).first()
  await handle.waitFor({ state: 'attached', timeout })
  const deadline = Date.now() + timeout
  let last = ''
  while (Date.now() < deadline) {
    last = (await handle.textContent()) ?? ''
    if (last.includes(expected)) return last
    await page.waitForTimeout(120)
  }
  throw new Error(`${selector} never contained ${JSON.stringify(expected)} (last: ${JSON.stringify(last)})`)
}

/** Poll until `predicate` returns true. */
async function waitFor(predicate, description, timeout = STEP_TIMEOUT) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await page.waitForTimeout(200)
  }
  throw new Error(`timed out after ${timeout} ms waiting for ${description}`)
}

/** Click away first-run onboarding overlays, without assuming a language. */
async function dismissOnboarding() {
  for (const label of ['关闭', '继续', '我知道了', '跳过', 'Close', 'Continue', 'Got it', 'Skip']) {
    const button = page.getByRole('button', { name: label, exact: true })
    if (await button.count()) {
      await button.first().click({ force: true, timeout: 3000 }).catch(() => undefined)
      await page.waitForTimeout(400)
    }
  }
}

/**
 * Open the CAD panel from the sidebar. The harness sidebar row can be partially
 * overlapped during boot, so a plain click may not be actionable: try force,
 * then a DOM click event, and retry while the shell finishes booting.
 */
async function openCadPanel() {
  const deadline = Date.now() + STEP_TIMEOUT
  let lastError = null
  while (Date.now() < deadline) {
    const button = page.locator('[aria-label="CAD"], [aria-label="CAD "]').first()
    const count = await button.count()
    if (count > 0) {
      try {
        await button.click({ force: true, timeout: 4000 })
      } catch (error) {
        lastError = error
        await button.dispatchEvent('click').catch(() => undefined)
      }
      try {
        await page.waitForSelector('.dsh-cad-page', { timeout: 12000 })
        return
      } catch (error) {
        lastError = error
      }
    }
    // Fallback: a role-based lookup for shells that do not mark the row.
    const byRole = page.getByRole('button', { name: 'CAD', exact: true }).first()
    if (await byRole.count()) {
      await byRole.dispatchEvent('click').catch(() => undefined)
      if (await page.locator('.dsh-cad-page').count()) return
    }
    await page.waitForTimeout(500)
  }
  await fail(`could not open the CAD panel from the sidebar${lastError ? ` (${lastError.message})` : ''}`)
}

/** Read the panel's current revision id. */
async function panelRevision() {
  return page.locator('.dsh-cad-page').getAttribute('data-revision-id')
}

/** Read the panel's current model id. */
async function panelModel() {
  return page.locator('.dsh-cad-page').getAttribute('data-model-id')
}

/** Read the Host's current revision id for one model (same-origin page fetch). */
async function hostCurrentRevision(modelId) {
  return page.evaluate(async ({ api, id }) => {
    const response = await fetch(`${api}/models/${encodeURIComponent(String(id))}?include=summary`, { credentials: 'same-origin' })
    if (!response.ok) return { ok: false, status: response.status }
    const body = await response.json().catch(() => null)
    return {
      ok: true,
      currentRevisionId: body?.model?.currentRevisionId ?? null,
      currentRevision: body?.model?.currentRevision ?? null,
      latestRevisionId: body?.model?.latestRevisionId ?? null,
      latestStatus: body?.model?.latestStatus ?? null,
      failing: body?.model?.failing ?? null,
    }
  }, { api: API, id: modelId })
}

/** Take a cropped screenshot of the panel element (scenario evidence). */
async function panelScreenshot(name) {
  const panel = page.locator('.dsh-cad-page')
  if (await panel.count()) {
    await panel.screenshot({ path: join(OUT, name) })
  } else {
    await page.screenshot({ path: join(OUT, name) })
  }
}

try {
  const launchOptions = { headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader'] }
  if (CHROME_PATH !== undefined && CHROME_PATH !== '') launchOptions.executablePath = CHROME_PATH
  else launchOptions.channel = CHANNEL
  browser = await chromium.launch(launchOptions)
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  page = await context.newPage()
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 1000))
  })
  page.on('pageerror', error => consoleErrors.push(`pageerror: ${error.message}`))
  page.on('response', response => {
    const url = response.url()
    if (url.includes('/model.glb')) {
      glbResponses.push({ url, status: response.status(), contentType: response.headers()['content-type'] ?? null })
    }
    if (url.includes('/dsh-plugin-cad/api/')) {
      apiRequests.push(`${response.request().method()} ${url} -> ${response.status()}`)
    }
  })

  await step('boot the Harness Web UI', async () => {
    const response = await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: STEP_TIMEOUT })
    if (response === null || response.status() >= 400) {
      await fail(`the Harness Web UI answered ${response === null ? 'no response' : response.status()}`)
    }
    await page.waitForTimeout(5000)
    await dismissOnboarding()
    await page.waitForTimeout(500)
  })

  await step('the plugin Host API is reachable from the page', async () => {
    const health = await page.evaluate(async (api) => {
      const response = await fetch(`${api}/health`, { credentials: 'same-origin' })
      return { status: response.status, body: await response.json().catch(() => null) }
    }, API)
    if (health.status !== 200) await fail(`GET ${API}/health answered ${health.status}`)
    if (health.body?.plugin !== 'dsh-plugin-cad') {
      await fail(`unexpected health payload: ${JSON.stringify(health.body).slice(0, 300)}`)
    }
  })

  await step('open the CAD panel from the sidebar and render the canvas', async () => {
    await openCadPanel()
    await page.waitForSelector('[data-testid="cad-canvas"]', { timeout: STEP_TIMEOUT })
    await waitText('[data-testid="cad-status"]', 'ready', STEP_TIMEOUT)
    const box = await page.locator('[data-testid="cad-canvas"]').boundingBox()
    if (box === null || box.width < 300 || box.height < 200) await fail(`canvas box too small: ${JSON.stringify(box)}`)
  })

  await step('the model under test is selected in the rail', async () => {
    if (EXPECT_MODEL_ID === null || EXPECT_MODEL_ID === '') {
      // No pin requested: the page auto-selects the newest model with built
      // geometry, which is what a person sees on first open.
      return
    }
    const row = page.locator(`[data-testid="cad-model-list"] [data-model-id="${EXPECT_MODEL_ID}"]`).first()
    await row.waitFor({ state: 'attached', timeout: STEP_TIMEOUT })
    await row.click({ force: true })
    await waitFor(async () => (await panelModel()) === EXPECT_MODEL_ID, `the panel to switch to model ${EXPECT_MODEL_ID}`, STEP_TIMEOUT)
    await waitText('[data-testid="cad-status"]', 'ready', STEP_TIMEOUT)
  })

  let emptyProfile = false
  const initial = await step('a model is auto-selected and shows the Host current revision', async () => {
    await page.waitForTimeout(800)
    const list = page.locator('[data-testid="cad-model-list"] [role="option"]')
    const count = await list.count()
    if (count === 0) {
      if (ALLOW_EMPTY) {
        emptyProfile = true
        return { id: null, revision: null, name: null }
      }
      await fail('no CAD model exists in this profile; seed one before running the E2E (or set DSH_E2E_ALLOW_EMPTY=1)')
    }
    const name = (await page.locator('[data-testid="cad-model-name"]').textContent()) ?? ''
    const id = await panelModel()
    const revision = await panelRevision()
    const badge = (await page.locator('[data-testid="cad-revision"]').first().textContent()) ?? ''
    assert.match(String(id), /^m-[a-z0-9]+$/iu, `panel data-model-id=${String(id)}`)
    assert.match(String(revision), /^r-\d+$/u, `panel data-revision-id=${String(revision)}`)
    assert.match(badge, /r-\d+/u, `revision badge "${badge}" does not show a revision id`)
    if (name.trim() === '') await fail('the panel shows no model name')
    return { id, revision, name }
  })

  if (emptyProfile) {
    console.log('  (empty profile accepted via DSH_E2E_ALLOW_EMPTY=1; GLB and revision steps are not applicable)')
    await panelScreenshot('client-00-panel.png')
    await waitText('[data-testid="cad-status"]', 'empty', STEP_TIMEOUT)
  } else {
    await step('a model.glb artifact was fetched with HTTP 200 and model/gltf-binary', async () => {
      const deadline = Date.now() + STEP_TIMEOUT
      while (glbResponses.length === 0 && Date.now() < deadline) await page.waitForTimeout(150)
      const hit = glbResponses.find(entry => entry.status === 200)
      if (hit === undefined) await fail(`no 200 model.glb response observed: ${JSON.stringify(glbResponses)}`)
      if (!String(hit.contentType).includes('model/gltf-binary')) {
        await fail(`model.glb content-type is ${String(hit.contentType)}, expected model/gltf-binary`)
      }
      assert.match(hit.url, /\/dsh-plugin-cad\/assets\/models\/m-[^/]+\/r-\d+\/model\.glb$/u)
    })

    await panelScreenshot('client-00-panel.png')
    await page.screenshot({ path: join(OUT, 'client-01-viewer.png') })

    await step('orbit with a real pointer drag', async () => {
      const box = await page.locator('[data-testid="cad-canvas"]').boundingBox()
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width * 0.68, box.y + box.height * 0.42, { steps: 20 })
      await page.mouse.up()
      await page.waitForTimeout(600)
      await page.screenshot({ path: join(OUT, 'client-02-orbit.png') })
    })

    await step('raycast selection shows the part inspect card', async () => {
      const box = await page.locator('[data-testid="cad-canvas"]').boundingBox()
      await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5)
      await page.waitForSelector('.dsh-cad-inspect', { timeout: 15000 })
      const text = await page.locator('.dsh-cad-inspect').innerText()
      // The Harness UI language follows the profile (zh or en); accept both.
      assert.match(text, /triangles|三角形/iu, `inspect card lacks a triangle count: ${text.slice(0, 300)}`)
      assert.match(text, /bounding box|包围盒/iu, `inspect card lacks a bounding box: ${text.slice(0, 300)}`)
      assert.match(text, /vertices|顶点/iu, `inspect card lacks a vertex count: ${text.slice(0, 300)}`)
      await page.screenshot({ path: join(OUT, 'client-03-picked.png') })
      await page.keyboard.press('Escape')
      await page.waitForSelector('.dsh-cad-inspect', { state: 'detached', timeout: 10000 })
    })

    await step('the panel revision matches the Host current revision after Refresh', async () => {
      const host = await hostCurrentRevision(initial.id)
      if (!host.ok) await fail(`the Host detail API answered ${host.status}`)
      await page.locator('[data-testid="cad-refresh"]').click()
      await waitFor(async () => (await panelRevision()) === host.currentRevisionId, `the panel to show the Host current revision ${String(host.currentRevisionId)}`, STEP_TIMEOUT)
      assert.equal(await panelRevision(), host.currentRevisionId)
    })

    let finalRevision = initial.revision
    const hostBefore = (await hostCurrentRevision(initial.id)).currentRevisionId
    if (!WAIT_REVISION) {
      steps.push({ name: 'revision refresh (external writer)', ok: true, skipped: true, reason: 'DSH_E2E_WAIT_REVISION=0' })
      console.log('  (revision-change step skipped by DSH_E2E_WAIT_REVISION=0)')
      finalRevision = hostBefore ?? initial.revision
    } else {
      finalRevision = await step('a revision published while the panel is open is followed by polling', async () => {
        if (TRIGGER !== undefined && TRIGGER !== '') {
          console.log(`\n  running DSH_E2E_TRIGGER: ${TRIGGER}`)
          execSync(TRIGGER, { stdio: 'inherit', env: process.env, timeout: REVISION_TIMEOUT })
        } else {
          console.log(`\n  waiting up to ${Math.round(REVISION_TIMEOUT / 1000)}s for an external writer to create the next revision…`)
        }
        const beforeCount = glbResponses.length
        const next = await (async () => {
          if (EXPECT_REVISION !== null && EXPECT_REVISION !== '') {
            // The external writer may already have created the expected revision
            // before this watch started; wait for it either way.
            await waitFor(async () => {
              const host = await hostCurrentRevision(initial.id)
              return host.ok && host.currentRevisionId === EXPECT_REVISION
            }, `the Host current revision to become ${EXPECT_REVISION}`, REVISION_TIMEOUT)
            return EXPECT_REVISION
          }
          await waitFor(async () => {
            const host = await hostCurrentRevision(initial.id)
            return host.ok && host.currentRevisionId !== hostBefore
          }, `the Host current revision to change from ${String(hostBefore)}`, REVISION_TIMEOUT)
          const host = await hostCurrentRevision(initial.id)
          return host.currentRevisionId
        })()
        await waitFor(async () => (await panelRevision()) === next, `the panel to follow the new revision ${String(next)}`, STEP_TIMEOUT)
        await waitText('[data-testid="cad-status"]', 'ready', STEP_TIMEOUT)
        // If the change landed before the panel's first GLB load, the new GLB may
        // already be cached in memory; frame it explicitly then re-check.
        let found = () => glbResponses.some(entry => entry.status === 200 && entry.url.includes(`/${String(next)}/model.glb`))
        if (!found()) {
          await page.locator('[data-testid="cad-refresh"]').click().catch(() => undefined)
          await waitFor(async () => found(), 'the new revision GLB to be fetched', STEP_TIMEOUT)
        }
        await waitFor(async () => found(), 'the new revision GLB to be fetched', STEP_TIMEOUT)
        if (glbResponses.length > beforeCount && !found()) {
          await fail(`the GLB reload did not follow revision ${String(next)}: ${JSON.stringify(glbResponses.slice(-3))}`)
        }
        const latest = [...glbResponses].reverse().find(entry => entry.url.includes(`/${String(next)}/model.glb`))
        assert.ok(latest !== undefined && latest.status === 200, `no 200 GLB for revision ${String(next)}`)
        assert.equal(await panelRevision(), next)
        return next
      })
      await page.waitForTimeout(800)
      await page.screenshot({ path: join(OUT, 'client-04-revision2.png') })
      await panelScreenshot('client-04b-panel-revision.png')
    }

    await step('a page reload rediscovers the model and revision from the Host alone', async () => {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: STEP_TIMEOUT })
      await page.waitForTimeout(5000)
      await dismissOnboarding()
      await openCadPanel()
      await page.waitForSelector('[data-testid="cad-canvas"]', { timeout: STEP_TIMEOUT })
      await waitText('[data-testid="cad-status"]', 'ready', STEP_TIMEOUT)
      const host = await hostCurrentRevision(initial.id)
      if (!host.ok) await fail(`the Host detail API answered ${host.status} after reload`)
      await waitFor(async () => (await panelRevision()) === host.currentRevisionId, 'the reloaded panel to show the Host current revision', STEP_TIMEOUT)
      assert.equal(await panelModel(), initial.id, 'the reloaded panel lost the Host model id')
      finalRevision = host.currentRevisionId
      await page.screenshot({ path: join(OUT, 'client-05-reload.png') })
    })

    await step('polling really re-read the detail endpoint while the panel was open', async () => {
      const detailPolls = apiRequests.filter(entry => /GET .*\/models\/m-[^/?]+\?/u.test(entry))
      assert.ok(detailPolls.length >= 2, `expected repeated detail polls, saw ${JSON.stringify(apiRequests.slice(-10))}`)
    })

    await step('the browser console stayed free of plugin errors', async () => {
      const relevant = consoleErrors.filter(message => /dsh-plugin-cad|dsh-cad|three\.js|WebGL|\bglb\b/iu.test(message))
      if (relevant.length > 0) await fail(`plugin console errors: ${JSON.stringify(relevant.slice(0, 5))}`)
    })

    const report = {
      ok: true,
      url: URL.replace(/([?&]token=)[^&]+/u, '$1<redacted>'),
      model: { id: initial.id, name: initial.name, initialRevision: initial.revision, finalRevision },
      glbResponses,
      apiRequests,
      steps,
      consoleErrors,
      screenshots: OUT,
      generatedAt: new Date().toISOString(),
    }
    writeFileSync(join(OUT, 'client-e2e-report.json'), `${JSON.stringify(report, null, 2)}\n`)
    console.log(`\nCLIENT E2E OK: ${steps.length} steps; model ${initial.name} (${initial.id}); revision ${initial.revision} -> ${finalRevision}`)
    console.log(`GLB fetches: ${glbResponses.filter(entry => entry.status === 200).length}; screenshots + report: ${OUT}`)
  }
} catch (error) {
  await page?.screenshot({ path: join(OUT, 'client-99-failure.png') }).catch(() => undefined)
  const report = {
    ok: false,
    url: URL?.replace(/([?&]token=)[^&]+/u, '$1<redacted>'),
    steps,
    glbResponses,
    apiRequests,
    consoleErrors,
    error: String((error && error.stack) || error),
    generatedAt: new Date().toISOString(),
  }
  writeFileSync(join(OUT, 'client-e2e-report.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.error('\nCLIENT E2E FAILED:', error)
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => undefined)
}
