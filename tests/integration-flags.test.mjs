import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const moduleUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/integration-flags.ts")
).href

const {
  getDefaultAgentFeatureFlags,
  resolveAgentFeatureFlags,
  resolveIntegrationBooleanFlag,
  toEdgeConfigFlagKey,
  toVercelFlagSlug,
} = await import(moduleUrl)

// All env that the module reads. Cleared before each scenario so tests never
// leak into one another and Edge Config is never contacted (EDGE_CONFIG unset
// short-circuits the lookup).
const ENV_KEYS = ["EDGE_CONFIG", "AGENT_TELEMETRY_RECORD_IO"]

async function withEnv(overrides, fn) {
  const saved = new Map()
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key])
    delete process.env[key]
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  try {
    return await fn()
  } finally {
    for (const key of ENV_KEYS) {
      const value = saved.get(key)
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

test("flag key encoders normalize separators", () => {
  assert.equal(
    toEdgeConfigFlagKey("agent.telemetry.record_io"),
    "agent_telemetry_record_io"
  )
  assert.equal(
    toVercelFlagSlug("agent.telemetry.record_io"),
    "agent-telemetry-record-io"
  )
})

test("getDefaultAgentFeatureFlags returns fresh all-disabled copies", () => {
  const first = getDefaultAgentFeatureFlags()
  assert.deepEqual(first, {
    telemetryRecordIo: false,
  })

  first.telemetryRecordIo = true
  assert.equal(getDefaultAgentFeatureFlags().telemetryRecordIo, false)
})

test("resolveIntegrationBooleanFlag reads env names in order", async () => {
  await withEnv({ AGENT_TELEMETRY_RECORD_IO: "true" }, async () => {
    assert.equal(
      await resolveIntegrationBooleanFlag({
        key: "agent.telemetry.record_io",
        envNames: ["AGENT_TELEMETRY_RECORD_IO"],
      }),
      true
    )
  })

  await withEnv({ AGENT_TELEMETRY_RECORD_IO: "off" }, async () => {
    assert.equal(
      await resolveIntegrationBooleanFlag({
        key: "agent.telemetry.record_io",
        envNames: ["AGENT_TELEMETRY_RECORD_IO"],
        defaultValue: true,
      }),
      false
    )
  })

  await withEnv({}, async () => {
    assert.equal(
      await resolveIntegrationBooleanFlag({
        key: "agent.telemetry.record_io",
        defaultValue: true,
      }),
      true
    )
  })
})

test("resolveAgentFeatureFlags defaults everything off", async () => {
  await withEnv({}, async () => {
    assert.deepEqual(await resolveAgentFeatureFlags(), {
      telemetryRecordIo: false,
    })
  })
})

test("resolveAgentFeatureFlags applies per-flag env overrides", async () => {
  await withEnv({ AGENT_TELEMETRY_RECORD_IO: "1" }, async () => {
    const flags = await resolveAgentFeatureFlags()
    assert.equal(flags.telemetryRecordIo, true)
  })
})
