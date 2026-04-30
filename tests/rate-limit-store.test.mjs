import assert from "node:assert/strict"
import { afterEach, beforeEach, test } from "node:test"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  setTestModuleStubs,
  toProjectFileUrl,
} from "./register-ts-path-hooks.mjs"
import { resetTestMocks, setTestMocks } from "./stubs/mock-state.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const rateLimitUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/rate-limit.ts")
).href

setTestModuleStubs({
  "./postgres": toProjectFileUrl("tests/stubs/postgres.mjs"),
  kysely: toProjectFileUrl("tests/stubs/kysely.mjs"),
})

const { evaluateAndConsumeSlidingWindowRateLimit, tryAcquireConcurrencySlot } =
  await import(`${rateLimitUrl}?store-test=1`)

const originalDateNow = Date.now

let recorded

beforeEach(() => {
  recorded = {
    queries: [],
  }

  resetTestMocks()
  Date.now = () => 1_000_000
})

afterEach(() => {
  Date.now = originalDateNow
})

test("rate limiter falls back to memory when no primary database is configured", async () => {
  setTestMocks({
    postgres: {
      isPrimaryDatabaseConfigured() {
        return false
      },
    },
    kysely: {
      async execute(query) {
        recorded.queries.push(query)
        return { rows: [] }
      },
    },
  })

  const first = await evaluateAndConsumeSlidingWindowRateLimit({
    identifier: "memory-user",
    maxRequests: 1,
    windowMs: 60_000,
  })
  const second = await evaluateAndConsumeSlidingWindowRateLimit({
    identifier: "memory-user",
    maxRequests: 1,
    windowMs: 60_000,
  })

  assert.equal(first.allowed, true)
  assert.equal(first.remaining, 0)
  assert.equal(second.allowed, false)
  assert.equal(second.retryAfterSeconds, 60)
  assert.equal(recorded.queries.length, 0)
})

test("postgres sliding-window rate limit consumes through a locked shared row", async () => {
  setTestMocks({
    postgres: {
      getDatabase() {
        return { name: "postgres-rate-limit" }
      },
      isPrimaryDatabaseConfigured() {
        return true
      },
    },
    kysely: {
      async execute(query) {
        recorded.queries.push(query)

        if (query.text.includes("pruned_state")) {
          return {
            rows: [
              {
                hitCount: "2",
                oldestHit: "970000",
              },
            ],
          }
        }

        return { rows: [] }
      },
    },
  })

  const decision = await evaluateAndConsumeSlidingWindowRateLimit({
    identifier: "user:shared",
    maxRequests: 2,
    windowMs: 60_000,
  })

  assert.equal(decision.allowed, false)
  assert.equal(decision.limit, 2)
  assert.equal(decision.remaining, 0)
  assert.equal(decision.retryAfterSeconds, 30)
  assert.equal(decision.resetAtEpochSeconds, 1030)

  const consumeQuery = recorded.queries.find((query) =>
    query.text.includes("pruned_state")
  )
  assert(consumeQuery)
  assert.match(consumeQuery.text, /FOR UPDATE/)
  assert.match(consumeQuery.text, /UPDATE agent_rate_limit/)
  assert(consumeQuery.values.includes("user:shared"))
})

test("postgres concurrency slot increments atomically and releases asynchronously", async () => {
  Date.now = () => 1_120_000

  setTestMocks({
    postgres: {
      getDatabase() {
        return { name: "postgres-rate-limit" }
      },
      isPrimaryDatabaseConfigured() {
        return true
      },
    },
    kysely: {
      async execute(query) {
        recorded.queries.push(query)

        if (query.text.includes('"previousInFlight"')) {
          return {
            rows: [
              {
                previousInFlight: 1,
                inFlight: 2,
              },
            ],
          }
        }

        return { rows: [] }
      },
    },
  })

  const slot = await tryAcquireConcurrencySlot({
    identifier: "user:concurrency",
    maxConcurrent: 2,
    windowMs: 60_000,
  })

  assert.equal(slot.allowed, true)
  assert.equal(slot.inFlight, 2)
  assert.equal(slot.retryAfterSeconds, null)

  slot.release()
  await new Promise((resolve) => {
    setImmediate(resolve)
  })

  assert(
    recorded.queries.some((query) =>
      query.text.includes('"inFlight" = GREATEST("inFlight" - 1, 0)')
    )
  )
})
