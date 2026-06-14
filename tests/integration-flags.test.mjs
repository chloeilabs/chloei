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
  isInternalUser,
  resolveAgentFeatureFlags,
  resolveIntegrationBooleanFlag,
  toEdgeConfigFlagKey,
  toVercelFlagSlug,
} = await import(moduleUrl)

// All env that the module reads. Cleared before each scenario so tests never
// leak into one another and Edge Config is never contacted (EDGE_CONFIG unset
// short-circuits the lookup).
const ENV_KEYS = [
  "EDGE_CONFIG",
  "AGENT_ASYNC_REPORTS_ENABLED",
  "AGENT_TELEMETRY_RECORD_IO",
  "AGENT_FINANCE_WORKFLOWS_ENABLED",
  "AGENT_INTERNAL_USER_EMAILS",
  "AGENT_INTERNAL_USER_EMAIL_DOMAINS",
  "AGENT_ENABLE_NEW_CAPABILITIES_FOR_INTERNAL_USERS",
]

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
    toEdgeConfigFlagKey("agent.async_reports.enabled"),
    "agent_async_reports_enabled"
  )
  assert.equal(
    toVercelFlagSlug("agent.async_reports.enabled"),
    "agent-async-reports-enabled"
  )
  assert.equal(
    toVercelFlagSlug("agent.telemetry.record_io"),
    "agent-telemetry-record-io"
  )
})

test("getDefaultAgentFeatureFlags returns fresh all-disabled copies", () => {
  const first = getDefaultAgentFeatureFlags()
  assert.deepEqual(first, {
    asyncReportsEnabled: false,
    telemetryRecordIo: false,
    financeWorkflowsEnabled: false,
  })

  first.asyncReportsEnabled = true
  assert.equal(getDefaultAgentFeatureFlags().asyncReportsEnabled, false)
})

test("isInternalUser matches configured emails and domains", async () => {
  await withEnv(
    {
      AGENT_INTERNAL_USER_EMAILS: "insider@example.com, other@team.dev",
      AGENT_INTERNAL_USER_EMAIL_DOMAINS: "trusted.io",
    },
    () => {
      assert.equal(isInternalUser("INSIDER@example.com"), true)
      assert.equal(isInternalUser("anyone@trusted.io"), true)
      assert.equal(isInternalUser("stranger@gmail.com"), false)
      assert.equal(isInternalUser(""), false)
      assert.equal(isInternalUser(null), false)
      assert.equal(isInternalUser(undefined), false)
    }
  )
})

test("resolveIntegrationBooleanFlag reads env names in order", async () => {
  await withEnv({ AGENT_ASYNC_REPORTS_ENABLED: "true" }, async () => {
    assert.equal(
      await resolveIntegrationBooleanFlag({
        key: "agent.async_reports.enabled",
        envNames: ["AGENT_ASYNC_REPORTS_ENABLED"],
      }),
      true
    )
  })

  await withEnv({ AGENT_ASYNC_REPORTS_ENABLED: "off" }, async () => {
    assert.equal(
      await resolveIntegrationBooleanFlag({
        key: "agent.async_reports.enabled",
        envNames: ["AGENT_ASYNC_REPORTS_ENABLED"],
        defaultValue: true,
      }),
      false
    )
  })

  await withEnv({}, async () => {
    assert.equal(
      await resolveIntegrationBooleanFlag({
        key: "agent.async_reports.enabled",
        defaultValue: true,
      }),
      true
    )
  })
})

test("resolveAgentFeatureFlags defaults everything off", async () => {
  await withEnv({}, async () => {
    assert.deepEqual(await resolveAgentFeatureFlags(), {
      asyncReportsEnabled: false,
      telemetryRecordIo: false,
      financeWorkflowsEnabled: false,
    })
  })
})

test("resolveAgentFeatureFlags applies per-flag env overrides", async () => {
  await withEnv({ AGENT_TELEMETRY_RECORD_IO: "1" }, async () => {
    const flags = await resolveAgentFeatureFlags()
    assert.equal(flags.telemetryRecordIo, true)
    assert.equal(flags.asyncReportsEnabled, false)
    assert.equal(flags.financeWorkflowsEnabled, false)
  })
})

test("internal users get opt-in capability defaults", async () => {
  await withEnv(
    {
      AGENT_INTERNAL_USER_EMAILS: "insider@example.com",
      AGENT_ENABLE_NEW_CAPABILITIES_FOR_INTERNAL_USERS: "true",
    },
    async () => {
      const flags = await resolveAgentFeatureFlags({
        userEmail: "insider@example.com",
      })
      assert.equal(flags.asyncReportsEnabled, true)
      assert.equal(flags.financeWorkflowsEnabled, true)
      assert.equal(flags.telemetryRecordIo, false)
    }
  )
})

test("explicit env flags override internal-user defaults", async () => {
  await withEnv(
    {
      AGENT_INTERNAL_USER_EMAILS: "insider@example.com",
      AGENT_ENABLE_NEW_CAPABILITIES_FOR_INTERNAL_USERS: "true",
      AGENT_ASYNC_REPORTS_ENABLED: "false",
    },
    async () => {
      const flags = await resolveAgentFeatureFlags({
        userEmail: "insider@example.com",
      })
      assert.equal(flags.asyncReportsEnabled, false)
      assert.equal(flags.financeWorkflowsEnabled, true)
    }
  )
})
