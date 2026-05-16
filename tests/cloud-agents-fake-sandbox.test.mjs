import assert from "node:assert/strict"
import path from "node:path"
import { afterEach, test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const fakeUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/cloud-agents/sandbox/fake.ts")
).href

const { fakeCloudAgentSandboxAdapter, resetFakeCloudAgentSandboxes } =
  await import(fakeUrl)

afterEach(() => {
  resetFakeCloudAgentSandboxes()
})

test("fake adapter provisions a sandbox with seed files", async () => {
  const { sandboxId } = await fakeCloudAgentSandboxAdapter.provision({
    userId: "user-1",
    taskId: "task-1",
    repoOwner: "chloeilabs",
    repoName: "chloei",
    baseBranch: "main",
    sandboxRuntime: "node22",
  })
  assert.match(sandboxId, /^fake-sb-/)

  const readme = await fakeCloudAgentSandboxAdapter.readFile({
    sandboxId,
    path: "README.md",
  })
  assert.match(readme.content, /^# chloei/)
})

test("fake adapter records writeFile changes and reports diff totals", async () => {
  const { sandboxId } = await fakeCloudAgentSandboxAdapter.provision({
    userId: "user-1",
    taskId: "task-2",
    repoOwner: "chloeilabs",
    repoName: "chloei",
    baseBranch: "main",
    sandboxRuntime: "node22",
  })
  await fakeCloudAgentSandboxAdapter.writeFile({
    sandboxId,
    path: "NEW.md",
    content: "alpha\nbeta\ngamma\n",
  })
  const diff = await fakeCloudAgentSandboxAdapter.getDiff({
    sandboxId,
    baseBranch: "main",
  })
  assert.equal(diff.totals.filesChanged, 1)
  assert.equal(diff.totals.additions, 4)
  assert.equal(diff.totals.deletions, 0)
  assert.equal(diff.files[0].path, "NEW.md")
  assert.equal(diff.files[0].change, "added")
})

test("fake adapter rejects path traversal", async () => {
  const { sandboxId } = await fakeCloudAgentSandboxAdapter.provision({
    userId: "user-1",
    taskId: "task-3",
    repoOwner: "chloeilabs",
    repoName: "chloei",
    baseBranch: "main",
    sandboxRuntime: "node22",
  })
  await assert.rejects(
    fakeCloudAgentSandboxAdapter.writeFile({
      sandboxId,
      path: "../escape.txt",
      content: "no",
    })
  )
  await assert.rejects(
    fakeCloudAgentSandboxAdapter.readFile({
      sandboxId,
      path: "../escape.txt",
    })
  )
})

test("fake adapter simulates ls and test command output", async () => {
  const { sandboxId } = await fakeCloudAgentSandboxAdapter.provision({
    userId: "user-1",
    taskId: "task-4",
    repoOwner: "chloeilabs",
    repoName: "chloei",
    baseBranch: "main",
    sandboxRuntime: "node22",
  })
  const lsResult = await fakeCloudAgentSandboxAdapter.runCommand({
    sandboxId,
    command: "ls",
  })
  assert.equal(lsResult.exitCode, 0)
  assert.match(lsResult.stdout, /README\.md/)

  const testResult = await fakeCloudAgentSandboxAdapter.runCommand({
    sandboxId,
    command: "pnpm test",
  })
  assert.equal(testResult.exitCode, 0)
  assert.match(testResult.stdout, /PASS/)
})

test("fake adapter creates a stub branch and PR url", async () => {
  const { sandboxId } = await fakeCloudAgentSandboxAdapter.provision({
    userId: "user-1",
    taskId: "task-5",
    repoOwner: "chloeilabs",
    repoName: "chloei",
    baseBranch: "main",
    sandboxRuntime: "node22",
  })
  const push = await fakeCloudAgentSandboxAdapter.createBranchAndPush({
    sandboxId,
    branch: "chloei/test-12345678",
  })
  assert.equal(push.pushedRef, "refs/heads/chloei/test-12345678")

  const pr = await fakeCloudAgentSandboxAdapter.createPullRequest({
    sandboxId,
    repoOwner: "chloeilabs",
    repoName: "chloei",
    branch: "chloei/test-12345678",
    baseBranch: "main",
    title: "Title",
    body: "Body",
  })
  assert.match(pr.url, /^https:\/\/github\.com\/chloeilabs\/chloei\/pull\/\d+$/)
  assert.ok(pr.number >= 1000 && pr.number <= 9999)
})

test("fake adapter destroys sandboxes idempotently", async () => {
  const { sandboxId } = await fakeCloudAgentSandboxAdapter.provision({
    userId: "user-1",
    taskId: "task-6",
    repoOwner: "chloeilabs",
    repoName: "chloei",
    baseBranch: "main",
    sandboxRuntime: "node22",
  })
  await fakeCloudAgentSandboxAdapter.destroy({ sandboxId })
  await fakeCloudAgentSandboxAdapter.destroy({ sandboxId })
  await assert.rejects(
    fakeCloudAgentSandboxAdapter.runCommand({ sandboxId, command: "ls" })
  )
})
