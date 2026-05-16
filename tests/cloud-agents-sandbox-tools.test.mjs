import assert from "node:assert/strict"
import path from "node:path"
import { afterEach, beforeEach, test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const toolsUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/cloud-agents/sandbox/tools.ts")
).href
const fakeUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/cloud-agents/sandbox/fake.ts")
).href

const { buildCloudAgentSandboxTools } = await import(toolsUrl)
const { fakeCloudAgentSandboxAdapter, resetFakeCloudAgentSandboxes } =
  await import(fakeUrl)

let sandboxId
let onCallEvents
let onResultEvents

beforeEach(async () => {
  resetFakeCloudAgentSandboxes()
  onCallEvents = []
  onResultEvents = []
  const { sandboxId: id } = await fakeCloudAgentSandboxAdapter.provision({
    userId: "user-1",
    taskId: "task-tools",
    repoOwner: "acme",
    repoName: "widgets",
    baseBranch: "main",
    sandboxRuntime: "node22",
  })
  sandboxId = id
})

afterEach(() => {
  resetFakeCloudAgentSandboxes()
})

function buildTools({ testCommand } = {}) {
  return buildCloudAgentSandboxTools({
    adapter: fakeCloudAgentSandboxAdapter,
    sandboxId,
    baseBranch: "main",
    ...(testCommand ? { testCommand } : {}),
    onCall: async (event) => {
      onCallEvents.push(event)
    },
    onResult: async (event) => {
      onResultEvents.push(event)
    },
  })
}

test("write_file emits call+result events and reports a file_change", async () => {
  const tools = buildTools()
  const result = await tools.write_file.execute({
    path: "notes/output.md",
    content: "alpha\nbeta\n",
  })
  assert.match(result, /wrote/)
  assert.equal(onCallEvents.length, 1)
  assert.equal(onCallEvents[0].toolName, "write_file")
  assert.equal(onResultEvents.length, 1)
  assert.equal(onResultEvents[0].status, "success")
  assert.equal(onResultEvents[0].fileChange?.path, "notes/output.md")
})

test("read_file returns content on success and reports an error for missing files", async () => {
  const tools = buildTools()
  await tools.write_file.execute({
    path: "alpha.md",
    content: "ok",
  })
  const present = await tools.read_file.execute({ path: "alpha.md" })
  assert.equal(present, "ok")
  const missing = await tools.read_file.execute({ path: "missing.md" })
  assert.match(missing, /^error:/)
  const errorEvent = onResultEvents.at(-1)
  assert.equal(errorEvent.status, "error")
})

test("run_command attaches terminal output and propagates exit codes", async () => {
  const tools = buildTools()
  const result = await tools.run_command.execute({ command: "ls" })
  assert.match(result, /exit_code=0/)
  const last = onResultEvents.at(-1)
  assert.equal(last.status, "success")
  assert.equal(last.terminal?.stream, "stdout")
})

test("get_diff summarizes file counts and additions", async () => {
  const tools = buildTools()
  await tools.write_file.execute({
    path: "a.txt",
    content: "alpha\nbeta\ngamma\n",
  })
  const summary = await tools.get_diff.execute({})
  assert.match(summary, /1 file\(s\) changed, \+4\/-0/)
  assert.equal(onResultEvents.at(-1).status, "success")
})

test("summarize_changes records the summary text on the result event input", async () => {
  const tools = buildTools()
  await tools.summarize_changes.execute({ summary: "Tightened the docs." })
  const call = onCallEvents.at(-1)
  assert.equal(call.toolName, "summarize_changes")
  const result = onResultEvents.at(-1)
  assert.equal(result.status, "success")
  assert.equal(result.input.summary, "Tightened the docs.")
})

test("run_tests uses the environment's configured test command", async () => {
  const tools = buildTools({ testCommand: "pnpm test" })
  const result = await tools.run_tests.execute({})
  assert.match(result, /exit_code=0/)
  assert.match(result, /PASS/)
  assert.equal(onCallEvents.at(-1).input.command, "pnpm test")
  assert.equal(onResultEvents.at(-1).status, "success")
})

test("run_tests reports a skip notice when no test command is configured", async () => {
  const tools = buildTools()
  const result = await tools.run_tests.execute({})
  assert.match(result, /^no test command configured/)
  assert.equal(onResultEvents.at(-1).output.skipped, true)
  assert.equal(
    onResultEvents.at(-1).output.reason,
    "no_test_command_configured"
  )
})

test("tool call ids are scoped to the buildCloudAgentSandboxTools invocation", async () => {
  const toolsA = buildTools()
  const toolsB = buildTools()
  await toolsA.write_file.execute({ path: "a.txt", content: "a" })
  await toolsB.write_file.execute({ path: "b.txt", content: "b" })
  // First call in each invocation should both start at counter 1.
  const aCall = onCallEvents[onCallEvents.length - 2]
  const bCall = onCallEvents[onCallEvents.length - 1]
  assert.equal(aCall.callId, "write_file-1")
  assert.equal(bCall.callId, "write_file-1")
})
