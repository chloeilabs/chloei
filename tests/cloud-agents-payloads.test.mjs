import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const payloadsUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/cloud-agents/payloads.ts")
).href

const {
  cloudAgentEnvironmentCreateSchema,
  cloudAgentEventPayloadSchema,
  cloudAgentTaskApproveSchema,
  cloudAgentTaskCreateSchema,
  parseArtifactRow,
  parseEnvironmentRow,
  parseTaskEventRow,
  parseTaskRow,
} = await import(payloadsUrl)

test("environment create schema applies defaults and trims", () => {
  const parsed = cloudAgentEnvironmentCreateSchema.parse({
    name: "  Prod  ",
    repoOwner: "  chloeilabs",
    repoName: "chloei",
  })
  assert.deepEqual(parsed, {
    name: "Prod",
    repoOwner: "chloeilabs",
    repoName: "chloei",
    repoProvider: "github",
    baseBranch: "main",
    networkPolicy: { mode: "setup_only" },
    sandboxRuntime: "node22",
  })
})

test("environment create schema rejects empty repo owner", () => {
  assert.throws(() =>
    cloudAgentEnvironmentCreateSchema.parse({
      name: "Prod",
      repoOwner: " ",
      repoName: "chloei",
    })
  )
})

test("task create schema enforces prompt length", () => {
  const parsed = cloudAgentTaskCreateSchema.parse({
    environmentId: "env-1",
    prompt: "  do the thing  ",
  })
  assert.equal(parsed.environmentId, "env-1")
  assert.equal(parsed.prompt, "do the thing")

  assert.throws(() =>
    cloudAgentTaskCreateSchema.parse({
      environmentId: "env-1",
      prompt: "",
    })
  )
})

test("approval schema accepts approve/deny only", () => {
  const approve = cloudAgentTaskApproveSchema.parse({
    approvalId: "abc",
    decision: "approve",
    note: "looks good",
  })
  assert.equal(approve.decision, "approve")

  const deny = cloudAgentTaskApproveSchema.parse({
    approvalId: "abc",
    decision: "deny",
  })
  assert.equal(deny.decision, "deny")

  assert.throws(() =>
    cloudAgentTaskApproveSchema.parse({
      approvalId: "abc",
      decision: "merge",
    })
  )
})

test("event payload schema validates each kind", () => {
  const statusEvent = cloudAgentEventPayloadSchema.parse({
    kind: "status",
    status: "editing",
    phase: "Editing files",
  })
  assert.equal(statusEvent.kind, "status")

  const terminalEvent = cloudAgentEventPayloadSchema.parse({
    kind: "terminal_output",
    stream: "stdout",
    chunk: "hello",
  })
  assert.equal(terminalEvent.kind, "terminal_output")

  const approvalEvent = cloudAgentEventPayloadSchema.parse({
    kind: "approval_required",
    approvalId: "ap-1",
    action: "push_branch",
    reason: "Push 1 file change.",
  })
  assert.equal(approvalEvent.kind, "approval_required")

  assert.throws(() =>
    cloudAgentEventPayloadSchema.parse({
      kind: "unknown",
    })
  )
  assert.throws(() =>
    cloudAgentEventPayloadSchema.parse({
      kind: "approval_required",
      approvalId: "ap-1",
      action: "deploy_to_moon",
      reason: "Why not?",
    })
  )
})

test("parseEnvironmentRow restores optional fields and policy defaults", () => {
  const parsed = parseEnvironmentRow({
    id: "env-1",
    name: "Prod",
    repoProvider: "github",
    repoOwner: "chloeilabs",
    repoName: "chloei",
    baseBranch: "main",
    setupCommand: null,
    testCommand: "pnpm test",
    devCommand: null,
    networkPolicy: { mode: "open" },
    vercelProjectId: null,
    sandboxRuntime: "node22",
    createdAt: "2026-05-15T10:00:00.000Z",
    updatedAt: "2026-05-15T10:00:00.000Z",
  })
  assert.equal(parsed.id, "env-1")
  assert.equal(parsed.testCommand, "pnpm test")
  assert.equal(parsed.setupCommand, undefined)
  assert.equal(parsed.networkPolicy.mode, "open")
})

test("parseTaskRow normalizes status and timestamps", () => {
  const parsed = parseTaskRow({
    id: "task-1",
    environmentId: "env-1",
    prompt: "do the thing",
    status: "editing",
    phase: "Editing files",
    branch: "chloei/do-1234",
    sandboxId: "fake-1",
    snapshotId: null,
    prUrl: null,
    previewUrl: null,
    summary: null,
    error: null,
    createdAt: "2026-05-15T10:00:00.000Z",
    updatedAt: "2026-05-15T10:01:00.000Z",
    completedAt: null,
  })
  assert.equal(parsed.status, "editing")
  assert.equal(parsed.branch, "chloei/do-1234")
  assert.equal(parsed.completedAt, undefined)

  const recovered = parseTaskRow({
    id: "task-2",
    environmentId: "env-1",
    prompt: "do the thing",
    status: "totally-bogus",
    phase: null,
    branch: null,
    sandboxId: null,
    snapshotId: null,
    prUrl: null,
    previewUrl: null,
    summary: null,
    error: null,
    createdAt: "2026-05-15T10:00:00.000Z",
    updatedAt: "2026-05-15T10:01:00.000Z",
    completedAt: null,
  })
  assert.equal(recovered.status, "failed")
})

test("parseTaskEventRow coerces bigint seq and validates payload", () => {
  const parsed = parseTaskEventRow({
    id: "evt-1",
    taskId: "task-1",
    seq: 42n,
    payload: { kind: "status", status: "editing" },
    createdAt: "2026-05-15T10:01:00.000Z",
  })
  assert.equal(parsed.seq, 42)
  assert.equal(parsed.payload.kind, "status")

  assert.throws(() =>
    parseTaskEventRow({
      id: "evt-2",
      taskId: "task-1",
      seq: 1,
      payload: { kind: "bogus" },
      createdAt: "2026-05-15T10:01:00.000Z",
    })
  )
})

test("parseArtifactRow coerces sizeBytes and falls back on unknown kind", () => {
  const parsed = parseArtifactRow({
    id: "art-1",
    taskId: "task-1",
    kind: "unrecognized",
    label: "Some artifact",
    mediaType: "text/plain",
    sizeBytes: "12345",
    url: "https://example.com/x",
    blobPathname: null,
    metadata: { foo: "bar" },
    createdAt: "2026-05-15T10:01:00.000Z",
  })
  assert.equal(parsed.kind, "other")
  assert.equal(parsed.sizeBytes, 12345)
  assert.equal(parsed.url, "https://example.com/x")
  assert.deepEqual(parsed.metadata, { foo: "bar" })
})
