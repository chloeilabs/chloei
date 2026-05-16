import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  setTestModuleStubs,
  toProjectFileUrl,
} from "./register-ts-path-hooks.mjs"

setTestModuleStubs({
  "@vercel/edge-config": toProjectFileUrl("tests/stubs/edge-config.mjs"),
})

const cwd = fileURLToPath(new URL("..", import.meta.url))
const sharedUrl = pathToFileURL(
  path.join(cwd, "src/lib/shared/cloud-agents.ts")
).href
const integrationFlagsUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/integration-flags.ts")
).href

const {
  CLOUD_AGENT_TASK_STATUSES,
  CLOUD_AGENT_APPROVAL_ACTIONS,
  CLOUD_AGENT_EVENT_KINDS,
  CLOUD_AGENT_ARTIFACT_KINDS,
  deriveCloudAgentTaskBranchName,
  getCloudAgentDefaultNetworkPolicy,
  isCloudAgentApprovalAction,
  isCloudAgentTaskStatus,
  isInProgressCloudAgentTaskStatus,
  isTerminalCloudAgentTaskStatus,
} = await import(sharedUrl)
const { resolveAgentFeatureFlags } = await import(integrationFlagsUrl)

test("task statuses include all plan-required states", () => {
  assert.deepEqual([...CLOUD_AGENT_TASK_STATUSES].sort(), [
    "cancelled",
    "completed",
    "editing",
    "failed",
    "planning",
    "pr_ready",
    "provisioning",
    "pushing",
    "queued",
    "setting_up",
    "testing",
    "waiting_for_approval",
  ])
})

test("terminal and in-progress status helpers partition the lifecycle", () => {
  const terminal = ["completed", "failed", "cancelled"]
  const inProgress = [
    "queued",
    "provisioning",
    "setting_up",
    "planning",
    "editing",
    "testing",
    "pushing",
  ]
  const ambiguous = ["waiting_for_approval", "pr_ready"]

  for (const status of terminal) {
    assert.equal(isTerminalCloudAgentTaskStatus(status), true)
    assert.equal(isInProgressCloudAgentTaskStatus(status), false)
  }
  for (const status of inProgress) {
    assert.equal(isInProgressCloudAgentTaskStatus(status), true)
    assert.equal(isTerminalCloudAgentTaskStatus(status), false)
  }
  for (const status of ambiguous) {
    assert.equal(isInProgressCloudAgentTaskStatus(status), false)
    assert.equal(isTerminalCloudAgentTaskStatus(status), false)
  }
})

test("status guard rejects unknown strings and non-strings", () => {
  assert.equal(isCloudAgentTaskStatus("queued"), true)
  assert.equal(isCloudAgentTaskStatus("done"), false)
  assert.equal(isCloudAgentTaskStatus(42), false)
  assert.equal(isCloudAgentTaskStatus(null), false)
})

test("approval action guard covers every plan-required action", () => {
  assert.deepEqual([...CLOUD_AGENT_APPROVAL_ACTIONS].sort(), [
    "create_pr",
    "deploy_preview",
    "deploy_production",
    "push_branch",
    "run_sensitive_command",
    "use_secret",
  ])
  for (const action of CLOUD_AGENT_APPROVAL_ACTIONS) {
    assert.equal(isCloudAgentApprovalAction(action), true)
  }
  assert.equal(isCloudAgentApprovalAction("escalate"), false)
})

test("event kinds and artifact kinds cover plan-specified shapes", () => {
  assert.deepEqual([...CLOUD_AGENT_EVENT_KINDS].sort(), [
    "approval_required",
    "artifact",
    "diff_update",
    "error",
    "file_change",
    "preview_ready",
    "status",
    "terminal_output",
    "text_delta",
    "tool_call",
    "tool_result",
  ])
  assert.deepEqual([...CLOUD_AGENT_ARTIFACT_KINDS].sort(), [
    "coverage",
    "file",
    "log",
    "other",
    "preview",
    "screenshot",
    "video",
  ])
})

test("default network policy is setup_only with no allowlist", () => {
  assert.deepEqual(getCloudAgentDefaultNetworkPolicy(), { mode: "setup_only" })
})

test("branch name slugifies input, falls back to 'task', and trims long ids", () => {
  assert.equal(
    deriveCloudAgentTaskBranchName({
      taskId: "abcd1234efgh5678",
      slug: "Fix Auth Bug!",
    }),
    "chloei/fix-auth-bug-abcd1234"
  )
  assert.equal(
    deriveCloudAgentTaskBranchName({ taskId: "deadbeef" }),
    "chloei/task-deadbeef"
  )
  const longSlug = "a".repeat(80)
  const longBranch = deriveCloudAgentTaskBranchName({
    taskId: "shortid",
    slug: longSlug,
  })
  assert.equal(longBranch.startsWith("chloei/"), true)
  assert.equal(longBranch.split("-").pop(), "shortid")
  assert.equal(longBranch.length <= "chloei/".length + 40 + 1 + 8, true)
})

test("cloud_agents flags default off and honor explicit env overrides", async () => {
  const envKeys = [
    "AGENT_CLOUD_AGENTS_ENABLED",
    "AGENT_CLOUD_AGENTS_GITHUB_ENABLED",
    "AGENT_CLOUD_AGENTS_VERCEL_DEPLOYMENTS_ENABLED",
    "AGENT_CLOUD_AGENTS_AUTOMATIONS_ENABLED",
  ]
  const previous = Object.fromEntries(
    envKeys.map((key) => [key, process.env[key]])
  )
  const originalEdgeConfig = process.env.EDGE_CONFIG
  try {
    delete process.env.EDGE_CONFIG
    for (const key of envKeys) {
      delete process.env[key]
    }

    const offFlags = await resolveAgentFeatureFlags()
    assert.equal(offFlags.cloudAgentsEnabled, false)
    assert.equal(offFlags.cloudAgentsGithubEnabled, false)
    assert.equal(offFlags.cloudAgentsVercelDeploymentsEnabled, false)
    assert.equal(offFlags.cloudAgentsAutomationsEnabled, false)

    process.env.AGENT_CLOUD_AGENTS_ENABLED = "true"
    process.env.AGENT_CLOUD_AGENTS_GITHUB_ENABLED = "true"
    const onFlags = await resolveAgentFeatureFlags()
    assert.equal(onFlags.cloudAgentsEnabled, true)
    assert.equal(onFlags.cloudAgentsGithubEnabled, true)
    assert.equal(onFlags.cloudAgentsVercelDeploymentsEnabled, false)
    assert.equal(onFlags.cloudAgentsAutomationsEnabled, false)
  } finally {
    for (const key of envKeys) {
      if (previous[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = previous[key]
      }
    }
    if (originalEdgeConfig === undefined) {
      delete process.env.EDGE_CONFIG
    } else {
      process.env.EDGE_CONFIG = originalEdgeConfig
    }
  }
})
