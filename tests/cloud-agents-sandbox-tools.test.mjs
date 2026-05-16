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

function buildTools() {
  return buildCloudAgentSandboxTools({
    adapter: fakeCloudAgentSandboxAdapter,
    sandboxId,
    baseBranch: "main",
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
