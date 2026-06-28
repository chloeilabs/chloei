import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  setTestModuleStubs,
  toProjectFileUrl,
} from "./register-ts-path-hooks.mjs"
import { resetTestMocks, setTestMocks } from "./stubs/mock-state.mjs"

setTestModuleStubs({
  "@/lib/logger": toProjectFileUrl("tests/stubs/logger.mjs"),
  "@/lib/server/llm/openai-raw-client": toProjectFileUrl(
    "tests/stubs/openai-raw-client.mjs"
  ),
  "next/server": toProjectFileUrl("tests/stubs/next-server.mjs"),
})

const cwd = fileURLToPath(new URL("..", import.meta.url))
const { POST } = await import(
  pathToFileURL(path.join(cwd, "src/app/api/webhooks/openai/route.ts")).href
)

function makeRequest(body) {
  return {
    headers: new Headers({
      "webhook-id": "wh_1",
      "webhook-timestamp": "1700000000",
      "webhook-signature": "v1,signature",
    }),
    text: async () => body,
  }
}

beforeEach(() => {
  resetTestMocks()
  process.env.OPENAI_WEBHOOK_SECRET = "whsec_test"
  process.env.OPENAI_API_KEY = "sk-test"
})

afterEach(() => {
  delete process.env.OPENAI_WEBHOOK_SECRET
  delete process.env.OPENAI_API_KEY
})

test("returns 503 when the webhook secret is not configured", async () => {
  delete process.env.OPENAI_WEBHOOK_SECRET
  const res = await POST(makeRequest("{}"))
  assert.equal(res.status, 503)
})

test("returns 400 on an invalid signature", async () => {
  setTestMocks({
    webhookUnwrap: () => {
      throw new Error("bad signature")
    },
  })
  const res = await POST(makeRequest("{}"))
  assert.equal(res.status, 400)
})

test("acks a valid event with 200 and de-dupes repeats", async () => {
  let calls = 0
  setTestMocks({
    webhookUnwrap: () => {
      calls += 1
      return {
        id: "evt_dedupe_1",
        type: "response.completed",
        data: { id: "resp_1" },
      }
    },
  })

  const first = await POST(makeRequest("{}"))
  assert.equal(first.status, 200)

  // A retried delivery with the same webhook id is still acked (200) but is
  // recognized as a duplicate so downstream work is not repeated.
  const second = await POST(makeRequest("{}"))
  assert.equal(second.status, 200)
  assert.equal(calls, 2)
})
