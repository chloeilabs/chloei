import assert from "node:assert/strict"
import test from "node:test"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const scriptUrl = pathToFileURL(
  path.join(cwd, "scripts/inngest-smoke.mjs")
).href

const {
  DEFAULT_INNGEST_SMOKE_EVENT_NAME,
  buildEventApiUrl,
  buildSmokeEventPayload,
  parseArgs,
  parseDotEnv,
  sendSmokeEvent,
} = await import(scriptUrl)

test("Inngest smoke script builds the no-op smoke event payload", () => {
  const payload = buildSmokeEventPayload({
    now: new Date("2026-06-07T15:00:00.000Z"),
    smokeId: "smoke-123",
  })

  assert.deepEqual(payload, {
    data: {
      sentAt: "2026-06-07T15:00:00.000Z",
      smokeId: "smoke-123",
      source: "chloei_inngest_smoke",
    },
    id: `${DEFAULT_INNGEST_SMOKE_EVENT_NAME}:smoke-123`,
    name: DEFAULT_INNGEST_SMOKE_EVENT_NAME,
  })
})

test("Inngest smoke script keeps the event key out of output data", async () => {
  let requestUrl = ""
  const result = await sendSmokeEvent({
    endpoint: "https://inn.gs/e",
    env: { INNGEST_EVENT_KEY: "test-secret-key" },
    fetchImpl: async (url, init) => {
      requestUrl = String(url)
      assert.equal(init.method, "POST")
      assert.equal(init.headers["Content-Type"], "application/json")
      assert.equal(JSON.parse(init.body).name, DEFAULT_INNGEST_SMOKE_EVENT_NAME)
      return new Response(JSON.stringify({ ids: ["evt_test"] }), {
        status: 200,
      })
    },
  })

  assert.equal(requestUrl, "https://inn.gs/e/test-secret-key")
  assert.equal(result.status, 200)
  assert.equal(result.body.ids[0], "evt_test")
  assert.doesNotMatch(JSON.stringify(result.payload), /test-secret-key/)
})

test("Inngest smoke script parses dotenv and CLI options", () => {
  assert.deepEqual(parseDotEnv("INNGEST_EVENT_KEY='abc'\n# comment\nFOO=bar"), {
    FOO: "bar",
    INNGEST_EVENT_KEY: "abc",
  })
  assert.deepEqual(
    parseArgs([
      "--env-file",
      "/tmp/prod.env",
      "--endpoint",
      "https://example.test/e",
      "--timeout-ms",
      "5000",
    ]),
    {
      endpoint: "https://example.test/e",
      envFile: "/tmp/prod.env",
      eventName: DEFAULT_INNGEST_SMOKE_EVENT_NAME,
      timeoutMs: 5000,
    }
  )
  assert.equal(
    buildEventApiUrl("https://inn.gs/e/", "abc/123"),
    "https://inn.gs/e/abc%2F123"
  )
})
