import assert from "node:assert/strict"
import path from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  setTestModuleStubs,
  toProjectFileUrl,
} from "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))

setTestModuleStubs({
  "@/lib/logger": toProjectFileUrl("tests/stubs/logger.mjs"),
  "./environments": toProjectFileUrl("tests/stubs/cloud-agent-stores.mjs"),
  "./tasks": toProjectFileUrl("tests/stubs/cloud-agent-stores.mjs"),
  "./events": toProjectFileUrl("tests/stubs/cloud-agent-stores.mjs"),
  "./artifacts": toProjectFileUrl("tests/stubs/cloud-agent-stores.mjs"),
  "./dispatcher": toProjectFileUrl("tests/stubs/cloud-agent-dispatcher.mjs"),
})

const automationUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/cloud-agents/automation-router.ts")
).href
const storesUrl = pathToFileURL(
  path.join(cwd, "tests/stubs/cloud-agent-stores.mjs")
).href
const dispatcherUrl = pathToFileURL(
  path.join(cwd, "tests/stubs/cloud-agent-dispatcher.mjs")
).href

const { routeAutomationTriggerToCloudAgent } = await import(automationUrl)
const { clearAllStores, seedEnvironment, getStoredTask, getStoredEvents } =
  await import(storesUrl)
const { getDispatchedTasks, resetDispatchedTasks } = await import(dispatcherUrl)

let previousAutomationUserId
let previousAutomationsEnabled

beforeEach(() => {
  previousAutomationUserId = process.env.AGENT_CLOUD_AGENT_AUTOMATION_USER_ID
  previousAutomationsEnabled =
    process.env.AGENT_CLOUD_AGENTS_AUTOMATIONS_ENABLED
  process.env.AGENT_CLOUD_AGENTS_AUTOMATIONS_ENABLED = "1"
  clearAllStores()
  resetDispatchedTasks()
})

afterEach(() => {
  if (previousAutomationUserId === undefined) {
    delete process.env.AGENT_CLOUD_AGENT_AUTOMATION_USER_ID
  } else {
    process.env.AGENT_CLOUD_AGENT_AUTOMATION_USER_ID = previousAutomationUserId
  }
  if (previousAutomationsEnabled === undefined) {
    delete process.env.AGENT_CLOUD_AGENTS_AUTOMATIONS_ENABLED
  } else {
    process.env.AGENT_CLOUD_AGENTS_AUTOMATIONS_ENABLED =
      previousAutomationsEnabled
  }
})

test("routeAutomationTriggerToCloudAgent skips when automation user is not configured", async () => {
  const result = await routeAutomationTriggerToCloudAgent({
    repoOwner: "acme",
    repoName: "widgets",
    prompt: "fix it",
    source: "test",
  })
  assert.equal(result.skipped, true)
  assert.match(result.reason, /AUTOMATION_USER_ID/)
})

test("routeAutomationTriggerToCloudAgent skips when automations feature flag is disabled", async () => {
  process.env.AGENT_CLOUD_AGENT_AUTOMATION_USER_ID = "bot-user"
  process.env.AGENT_CLOUD_AGENTS_AUTOMATIONS_ENABLED = "0"
  const result = await routeAutomationTriggerToCloudAgent({
    repoOwner: "acme",
    repoName: "widgets",
    prompt: "fix",
    source: "test",
  })
  assert.equal(result.skipped, true)
  assert.match(result.reason, /automations are disabled/i)
})

test("routeAutomationTriggerToCloudAgent skips when no env matches the repo", async () => {
  process.env.AGENT_CLOUD_AGENT_AUTOMATION_USER_ID = "bot-user"
  const result = await routeAutomationTriggerToCloudAgent({
    repoOwner: "acme",
    repoName: "missing",
    prompt: "fix",
    source: "test",
  })
  assert.equal(result.skipped, true)
})

test("routeAutomationTriggerToCloudAgent dispatches a task when env matches", async () => {
  process.env.AGENT_CLOUD_AGENT_AUTOMATION_USER_ID = "bot-user"
  const env = {
    id: "env-1",
    name: "Widgets",
    repoProvider: "github",
    repoOwner: "Acme",
    repoName: "Widgets",
    baseBranch: "main",
    networkPolicy: { mode: "setup_only" },
    sandboxRuntime: "node22",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  seedEnvironment("bot-user", env)
  const result = await routeAutomationTriggerToCloudAgent({
    repoOwner: "acme",
    repoName: "widgets",
    prompt: "fix the snapshot test",
    source: "github_fix_mention",
  })
  assert.ok(result.taskId)
  const stored = getStoredTask("bot-user", result.taskId)
  assert.equal(stored.environmentId, "env-1")
  assert.equal(stored.prompt, "fix the snapshot test")
  const events = getStoredEvents("bot-user", result.taskId)
  assert.equal(events.length, 1)
  assert.equal(events[0].payload.kind, "status")
  assert.match(events[0].payload.phase, /Triggered by github_fix_mention/)
  const dispatched = getDispatchedTasks()
  assert.deepEqual(dispatched, [{ userId: "bot-user", taskId: result.taskId }])
})
