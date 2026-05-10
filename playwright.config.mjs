import { defineConfig, devices } from "@playwright/test"

const localPort = process.env.SMOKE_PORT?.trim() || "3000"
const baseURL =
  process.env.SMOKE_BASE_URL?.trim() || `http://localhost:${localPort}`
const isMockSmoke = process.env.E2E_MOCK_AUTH === "1"
const shouldStartLocalServer = !process.env.SMOKE_BASE_URL
const shouldReuseExistingServer = !process.env.CI && !isMockSmoke
const vercelProtectionBypassSecret =
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim()

export default defineConfig({
  testDir: "./tests/smoke",
  timeout: 120_000,
  expect: {
    timeout: 15_000,
  },
  reporter: [["list"]],
  webServer: shouldStartLocalServer
    ? {
        command: isMockSmoke
          ? "node scripts/start-standalone-server.mjs"
          : `next dev --port ${localPort}`,
        env: {
          ...process.env,
          ...(isMockSmoke
            ? {
                HOSTNAME: "127.0.0.1",
                PORT: localPort,
              }
            : {}),
        },
        reuseExistingServer: shouldReuseExistingServer,
        timeout: 120_000,
        url: baseURL,
      }
    : undefined,
  use: {
    baseURL,
    ...(vercelProtectionBypassSecret
      ? {
          extraHTTPHeaders: {
            "x-vercel-protection-bypass": vercelProtectionBypassSecret,
            "x-vercel-set-bypass-cookie": "true",
          },
        }
      : {}),
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
      },
    },
  ],
})
