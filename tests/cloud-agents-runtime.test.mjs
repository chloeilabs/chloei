import assert from "node:assert/strict"
import path from "node:path"
import { beforeEach, test } from "node:test"
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
})

const runtimeUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/cloud-agents/runtime.ts")
).href
const storesStubUrl = pathToFileURL(
  path.join(cwd, "tests/stubs/cloud-agent-stores.mjs")
).href
const fakeUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/cloud-agents/sandbox/fake.ts")
).href

const { startCloudAgentTaskRun, continueCloudAgentTaskAfterApproval } =
  await import(runtimeUrl)
const {
  clearAllStores,
  getStoredArtifacts,
  getStoredEvents,
  getStoredTask,
  seedEnvironment,
  seedTask,
  setAppendCloudAgentTaskEventHook,
} = await import(storesStubUrl)
const { resetFakeCloudAgentSandboxes } = await import(fakeUrl)

function nowIso() {
  return new Date().toISOString()
}

function seedFixtures(overrides = {}) {
  const userId = "user-1"
  const environmentId = "env-1"
  const taskId = overrides.taskId ?? "task-1"
  const environment = {
    id: environmentId,
    name: "Prod",
    repoProvider: "github",
    repoOwner: "chloeilabs",
    repoName: "chloei",
    baseBranch: "main",
    setupCommand: "pnpm install",
    testCommand: "pnpm test",
    networkPolicy: { mode: "setup_only" },
    sandboxRuntime: "node22",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...overrides.environmentOverrides,
  }
  const task = {
    id: taskId,
    environmentId,
    prompt: "Improve cloud agent demo notes.",
    status: "queued",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...overrides.taskOverrides,
  }
  seedEnvironment(userId, environment)
  seedTask(userId, task)
  return { userId, taskId, environment, task }
}

beforeEach(() => {
  clearAllStores()
  resetFakeCloudAgentSandboxes()
})

test("startCloudAgentTaskRun walks queued → waiting_for_approval emitting structured events", async () => {
  const { userId, taskId } = seedFixtures()
  await startCloudAgentTaskRun({ userId, taskId })
  const task = getStoredTask(userId, taskId)
  assert.ok(task, "task should still exist")
  assert.equal(task.status, "waiting_for_approval")
  assert.ok(task.sandboxId)
  assert.ok(task.branch?.startsWith("chloei/"))

  const events = getStoredEvents(userId, taskId)
  const statusOrder = events
    .filter((event) => event.payload.kind === "status")
    .map((event) => event.payload.status)
  assert.deepEqual(statusOrder, [
    "provisioning",
    "setting_up",
    "planning",
    "editing",
    "testing",
    "waiting_for_approval",
  ])

  const kinds = new Set(events.map((event) => event.payload.kind))
  for (const expectedKind of [
    "status",
    "tool_call",
    "tool_result",
    "terminal_output",
    "text_delta",
    "file_change",
    "diff_update",
    "approval_required",
  ]) {
    assert.equal(
      kinds.has(expectedKind),
      true,
      `expected to see event kind ${expectedKind}`
    )
  }

  const approvalEvent = events.find(
    (event) => event.payload.kind === "approval_required"
  )
  assert.equal(approvalEvent?.payload.action, "push_branch")
})

test("continueCloudAgentTaskAfterApproval with approve creates PR and completes the task", async () => {
  const { userId, taskId } = seedFixtures()
  await startCloudAgentTaskRun({ userId, taskId })
  await continueCloudAgentTaskAfterApproval({
    userId,
    taskId,
    approved: true,
  })

  const task = getStoredTask(userId, taskId)
  assert.equal(task.status, "completed")
  assert.match(
    task.prUrl ?? "",
    /^https:\/\/github\.com\/chloeilabs\/chloei\/pull\/\d+/
  )
  assert.match(task.summary ?? "", /Opened https/)

  const artifacts = getStoredArtifacts(userId, taskId)
  assert.equal(artifacts.length, 1)
  assert.equal(artifacts[0].kind, "preview")
  assert.match(artifacts[0].label, /Pull request #\d+/)

  const statuses = getStoredEvents(userId, taskId)
    .filter((event) => event.payload.kind === "status")
    .map((event) => event.payload.status)
  assert.deepEqual(statuses.slice(-3), ["pushing", "pr_ready", "completed"])
})

test("continueCloudAgentTaskAfterApproval with deny cancels the task", async () => {
  const { userId, taskId } = seedFixtures({ taskId: "task-deny" })
  await startCloudAgentTaskRun({ userId, taskId })
  await continueCloudAgentTaskAfterApproval({
    userId,
    taskId,
    approved: false,
    note: "Not yet.",
  })

  const task = getStoredTask(userId, taskId)
  assert.equal(task.status, "cancelled")
  assert.equal(task.summary, "Not yet.")
})

test("startCloudAgentTaskRun no-ops when task is not in queued state", async () => {
  const { userId, taskId } = seedFixtures({
    taskId: "task-already-completed",
    taskOverrides: { status: "completed" },
  })
  await startCloudAgentTaskRun({ userId, taskId })
  const task = getStoredTask(userId, taskId)
  assert.equal(task.status, "completed")
  assert.equal(getStoredEvents(userId, taskId).length, 0)
})

test("startCloudAgentTaskRun fails fast when environment is missing", async () => {
  const userId = "user-1"
  const taskId = "task-missing-env"
  seedTask(userId, {
    id: taskId,
    environmentId: "env-missing",
    prompt: "do",
    status: "queued",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  })
  await startCloudAgentTaskRun({ userId, taskId })
  const task = getStoredTask(userId, taskId)
  assert.equal(task.status, "failed")
  const errorEvent = getStoredEvents(userId, taskId).find(
    (event) => event.payload.kind === "error"
  )
  assert.equal(errorEvent?.payload.errorCode, "CLOUD_AGENT_ENVIRONMENT_MISSING")
})

test("scripted runtime fails the task when the configured test command exits non-zero", async () => {
  const { userId, taskId } = seedFixtures({
    taskId: "task-failing-tests",
    environmentOverrides: { testCommand: "fake-fail-tests" },
  })
  await startCloudAgentTaskRun({ userId, taskId })
  const task = getStoredTask(userId, taskId)
  assert.equal(task.status, "failed")
  assert.match(task.error ?? "", /Tests failed/)
  const events = getStoredEvents(userId, taskId)
  const approvalEvent = events.find(
    (event) => event.payload.kind === "approval_required"
  )
  assert.equal(
    approvalEvent,
    undefined,
    "task should fail before requesting push approval"
  )
})

test("continueCloudAgentTaskAfterApproval backfills prUrl and notifies when cancel lands mid-push", async () => {
  const { userId, taskId } = seedFixtures({ taskId: "task-race-cancel" })
  await startCloudAgentTaskRun({ userId, taskId })

  // Simulate the race: as soon as the runtime emits the "pushing"
  // status event, an out-of-band cancel (e.g. user clicks cancel
  // from the dashboard) flips the row to "cancelled". By the time
  // the runtime tries the conditional `pushing` → `pr_ready`
  // update, the row is no longer in "pushing" and the update
  // returns null — but the GitHub PR has already shipped.
  setAppendCloudAgentTaskEventHook(async (params) => {
    if (
      params.payload.kind === "status" &&
      params.payload.status === "pushing"
    ) {
      const current = getStoredTask(params.userId, params.taskId)
      if (current && current.status === "pushing") {
        seedTask(params.userId, {
          ...current,
          status: "cancelled",
          summary: "User cancelled.",
        })
      }
    }
  })

  await continueCloudAgentTaskAfterApproval({
    userId,
    taskId,
    approved: true,
  })

  const task = getStoredTask(userId, taskId)
  assert.equal(task.status, "cancelled", "status should remain cancelled")
  assert.match(
    task.prUrl ?? "",
    /^https:\/\/github\.com\/chloeilabs\/chloei\/pull\/\d+/,
    "prUrl should be backfilled even though the row stayed cancelled"
  )
  assert.match(
    task.summary ?? "",
    /PR shipped after task was cancelled/,
    "summary should explain the surprise PR"
  )

  const textDeltas = getStoredEvents(userId, taskId).filter(
    (event) => event.payload.kind === "text_delta"
  )
  const notice = textDeltas.find((event) =>
    event.payload.text.startsWith(
      "Pull request was opened on GitHub before the cancel landed:"
    )
  )
  assert.ok(notice, "expected a text_delta notice about the shipped PR")
  assert.match(
    notice.payload.text,
    /https:\/\/github\.com\/chloeilabs\/chloei\/pull\/\d+/,
    "notice text should include the PR url"
  )

  const statuses = getStoredEvents(userId, taskId)
    .filter((event) => event.payload.kind === "status")
    .map((event) => event.payload.status)
  assert.equal(
    statuses.includes("pr_ready"),
    false,
    "should not have emitted pr_ready status after cancel"
  )
  assert.equal(
    statuses.includes("completed"),
    false,
    "should not have emitted completed status after cancel"
  )
})

test("post-approval runtime no longer emits a placeholder preview URL", async () => {
  const { userId, taskId } = seedFixtures({
    taskId: "task-vercel",
    environmentOverrides: { vercelProjectId: "prj_abc" },
  })
  await startCloudAgentTaskRun({ userId, taskId })
  await continueCloudAgentTaskAfterApproval({ userId, taskId, approved: true })

  const task = getStoredTask(userId, taskId)
  assert.equal(task.status, "completed")
  // Preview URL is populated asynchronously by the Vercel deployment webhook
  // (POST /api/webhooks/vercel) — never by the runtime itself.
  assert.equal(task.previewUrl, undefined)

  const previewEvents = getStoredEvents(userId, taskId).filter(
    (event) => event.payload.kind === "preview_ready"
  )
  assert.equal(previewEvents.length, 0)
})
