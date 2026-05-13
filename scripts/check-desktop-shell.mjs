import assert from "node:assert/strict"
import path from "node:path"

import { _electron as electron } from "playwright-core"

const rootDir = path.resolve(import.meta.dirname, "..")
const electronMainPath = path.join(rootDir, "electron", "main.cjs")
const expectedAgentResponse =
  process.env.E2E_MOCK_AGENT_RESPONSE?.trim() || "DESKTOP_SMOKE_OK"

const electronApp = await electron.launch({
  args: [electronMainPath],
  cwd: rootDir,
  env: {
    ...process.env,
    E2E_MOCK_AGENT_RESPONSE: expectedAgentResponse,
    E2E_MOCK_AUTH: "1",
    E2E_MOCK_AUTH_ALLOW_NEXT_START: "1",
    NEXT_TELEMETRY_DISABLED: "1",
  },
  timeout: 120_000,
})

try {
  const page = await electronApp.firstWindow({ timeout: 120_000 })
  await page.waitForLoadState("domcontentloaded", { timeout: 120_000 })
  await page.waitForURL(/http:\/\/127\.0\.0\.1:\d+\//u, {
    timeout: 120_000,
  })

  const localAppUrl = new URL(page.url())
  assert.equal(localAppUrl.hostname, "127.0.0.1")
  assert.match(localAppUrl.port, /^\d+$/u)

  const desktopApi = await page.evaluate(async () => {
    const updateState = await window.chloeiDesktop.updates.getState()

    return {
      isDesktop: window.chloeiDesktop.isDesktop,
      keys: Object.keys(window.chloeiDesktop).sort(),
      platform: window.chloeiDesktop.platform,
      updateState,
      updateTypes: {
        check: typeof window.chloeiDesktop.updates.check,
        getState: typeof window.chloeiDesktop.updates.getState,
        install: typeof window.chloeiDesktop.updates.install,
        onStateChange: typeof window.chloeiDesktop.updates.onStateChange,
      },
      updatesKeys: Object.keys(window.chloeiDesktop.updates).sort(),
      version: window.chloeiDesktop.version,
    }
  })
  assert.deepEqual(desktopApi.keys, [
    "isDesktop",
    "platform",
    "updates",
    "version",
  ])
  assert.equal(desktopApi.isDesktop, true)
  assert.equal(typeof desktopApi.platform, "string")
  assert.equal(typeof desktopApi.version, "string")
  assert.notEqual(desktopApi.version.length, 0)
  assert.deepEqual(desktopApi.updatesKeys, [
    "check",
    "getState",
    "install",
    "onStateChange",
  ])
  assert.deepEqual(desktopApi.updateTypes, {
    check: "function",
    getState: "function",
    install: "function",
    onStateChange: "function",
  })
  assert.equal(desktopApi.updateState.currentVersion, desktopApi.version)
  assert.equal(desktopApi.updateState.status, "unavailable")

  const rendererGlobals = await page.evaluate(() => ({
    processType: typeof window.process,
    requireType: typeof window.require,
  }))
  assert.deepEqual(rendererGlobals, {
    processType: "undefined",
    requireType: "undefined",
  })

  const origin = localAppUrl.origin
  await page.context().addCookies([
    {
      name: "chloei_e2e_auth",
      url: origin,
      value: "1",
    },
  ])
  await page.goto(origin)
  await page.getByPlaceholder("Ask anything").waitFor({
    state: "visible",
    timeout: 30_000,
  })

  console.log(
    `Desktop shell smoke passed for ${origin} with window.chloeiDesktop.version=${desktopApi.version}`
  )
} finally {
  await electronApp.close()
}
