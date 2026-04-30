import { defineConfig, devices } from "@playwright/test"

const localPort = process.env.SMOKE_PORT?.trim() || "3000"
const baseURL =
  process.env.SMOKE_BASE_URL?.trim() || `http://localhost:${localPort}`
const isMockSmoke = process.env.E2E_MOCK_AUTH === "1"
const shouldStartLocalServer = !process.env.SMOKE_BASE_URL
const shouldReuseExistingServer = !process.env.CI && !isMockSmoke

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
          ? `next start --port ${localPort}`
          : `next dev --port ${localPort}`,
        env: {
          ...process.env,
        },
        reuseExistingServer: shouldReuseExistingServer,
        timeout: 120_000,
        url: baseURL,
      }
    : undefined,
  use: {
    baseURL,
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
