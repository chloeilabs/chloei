import assert from "node:assert/strict"
import test from "node:test"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  setTestModuleStubs,
  toProjectFileUrl,
} from "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))

setTestModuleStubs({
  "@vercel/edge-config": toProjectFileUrl("tests/stubs/edge-config.mjs"),
})

const edgeConfigStoreKey = Symbol.for("chloei.tests.edge-config-store")

const integrationFlagsUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/integration-flags.ts")
).href

const {
  resolveAgentFeatureFlags,
  resolveIntegrationBooleanFlag,
  toEdgeConfigFlagKey,
  toVercelFlagSlug,
} = await import(integrationFlagsUrl)

const TELEMETRY_FLAG_ENV = "AGENT_TELEMETRY_RECORD_IO"

test("agent feature flags default off and respect explicit env overrides", async () => {
  const original = process.env[TELEMETRY_FLAG_ENV]
  const originalEdgeConfig = process.env.EDGE_CONFIG
  try {
    delete process.env[TELEMETRY_FLAG_ENV]
    delete process.env.EDGE_CONFIG
    assert.deepEqual(await resolveAgentFeatureFlags(), {
      telemetryRecordIo: false,
    })

    process.env[TELEMETRY_FLAG_ENV] = "true"
    const flags = await resolveAgentFeatureFlags()
    assert.equal(flags.telemetryRecordIo, true)
  } finally {
    if (original === undefined) {
      delete process.env[TELEMETRY_FLAG_ENV]
    } else {
      process.env[TELEMETRY_FLAG_ENV] = original
    }

    if (originalEdgeConfig === undefined) {
      delete process.env.EDGE_CONFIG
    } else {
      process.env.EDGE_CONFIG = originalEdgeConfig
    }
  }
})

test("agent feature flag resolution does not mutate shared defaults", async () => {
  const original = process.env[TELEMETRY_FLAG_ENV]
  const originalEdgeConfig = process.env.EDGE_CONFIG
  try {
    delete process.env.EDGE_CONFIG
    process.env[TELEMETRY_FLAG_ENV] = "true"
    assert.equal((await resolveAgentFeatureFlags()).telemetryRecordIo, true)

    delete process.env[TELEMETRY_FLAG_ENV]
    assert.equal((await resolveAgentFeatureFlags()).telemetryRecordIo, false)
  } finally {
    if (original === undefined) {
      delete process.env[TELEMETRY_FLAG_ENV]
    } else {
      process.env[TELEMETRY_FLAG_ENV] = original
    }

    if (originalEdgeConfig === undefined) {
      delete process.env.EDGE_CONFIG
    } else {
      process.env.EDGE_CONFIG = originalEdgeConfig
    }
  }
})

test("Edge Config flag keys are compatible with Vercel key restrictions", () => {
  assert.equal(
    toEdgeConfigFlagKey("agent.telemetry.record_io"),
    "agent_telemetry_record_io"
  )
  assert.equal(
    toVercelFlagSlug("agent.telemetry.record_io"),
    "agent-telemetry-record-io"
  )
})

test("agent feature flags can read Vercel/Flags-SDK Edge Config shape", async () => {
  const originalEdgeConfig = process.env.EDGE_CONFIG
  const originalTelemetry = process.env[TELEMETRY_FLAG_ENV]
  try {
    delete process.env[TELEMETRY_FLAG_ENV]
    process.env.EDGE_CONFIG = "test-edge-config-connection"
    globalThis[edgeConfigStoreKey] = {
      flags: {
        "agent-telemetry-record-io": true,
      },
    }

    const flags = await resolveAgentFeatureFlags()
    assert.equal(flags.telemetryRecordIo, true)
  } finally {
    delete globalThis[edgeConfigStoreKey]
    if (originalTelemetry === undefined) {
      delete process.env[TELEMETRY_FLAG_ENV]
    } else {
      process.env[TELEMETRY_FLAG_ENV] = originalTelemetry
    }
    if (originalEdgeConfig === undefined) {
      delete process.env.EDGE_CONFIG
    } else {
      process.env.EDGE_CONFIG = originalEdgeConfig
    }
  }
})

test("integration boolean flags can read Edge Config map shape", async () => {
  const originalEdgeConfig = process.env.EDGE_CONFIG
  try {
    process.env.EDGE_CONFIG = "test-edge-config-connection"
    globalThis[edgeConfigStoreKey] = {
      agent_flags: {
        "agent.telemetry.record_io": true,
      },
    }

    assert.equal(
      await resolveIntegrationBooleanFlag({
        key: "agent.telemetry.record_io",
      }),
      true
    )
  } finally {
    delete globalThis[edgeConfigStoreKey]
    if (originalEdgeConfig === undefined) {
      delete process.env.EDGE_CONFIG
    } else {
      process.env.EDGE_CONFIG = originalEdgeConfig
    }
  }
})
