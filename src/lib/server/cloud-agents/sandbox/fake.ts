import { randomUUID } from "node:crypto"

import type {
  CloudAgentSandboxAdapter,
  CloudAgentSandboxCommandResult,
  CloudAgentSandboxDiff,
  CloudAgentSandboxProvisionInput,
  CloudAgentSandboxProvisionResult,
} from "./types"

interface FakeSandboxState {
  sandboxId: string
  repoOwner: string
  repoName: string
  baseBranch: string
  files: Map<string, string>
  changes: Map<
    string,
    {
      change: "added" | "modified" | "deleted"
      additions: number
      deletions: number
    }
  >
  createdAt: number
}

declare global {
  var chloeiCloudAgentFakeSandboxes: Map<string, FakeSandboxState> | undefined
}

function getStore(): Map<string, FakeSandboxState> {
  globalThis.chloeiCloudAgentFakeSandboxes ??= new Map()
  return globalThis.chloeiCloudAgentFakeSandboxes
}

function require(state: FakeSandboxState | undefined, sandboxId: string) {
  if (!state) {
    throw new Error(`Fake sandbox ${sandboxId} not found.`)
  }
  return state
}

function countLines(content: string): number {
  if (content.length === 0) return 0
  return content.split("\n").length
}

function ensureSafePath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed || trimmed.includes("..") || trimmed.startsWith("/")) {
    throw new Error("Path must be a repo-relative path without '..' segments.")
  }
  return trimmed
}

export const fakeCloudAgentSandboxAdapter: CloudAgentSandboxAdapter = {
  id: "fake",
  provision(
    input: CloudAgentSandboxProvisionInput
  ): Promise<CloudAgentSandboxProvisionResult> {
    const sandboxId = `fake-sb-${randomUUID().slice(0, 8)}`
    const store = getStore()
    store.set(sandboxId, {
      sandboxId,
      repoOwner: input.repoOwner,
      repoName: input.repoName,
      baseBranch: input.baseBranch,
      files: new Map([
        ["README.md", `# ${input.repoName}\n\nFake sandbox seed.\n`],
        ["package.json", `{"name":"${input.repoName}","version":"0.0.0"}\n`],
      ]),
      changes: new Map(),
      createdAt: Date.now(),
    })
    return Promise.resolve({ sandboxId })
  },

  runSetup(params): Promise<CloudAgentSandboxCommandResult> {
    try {
      require(getStore().get(params.sandboxId), params.sandboxId)
      return Promise.resolve({
        exitCode: 0,
        stdout: `[fake] ran setup: ${params.command}\n[fake] deps installed.\n`,
        stderr: "",
        durationMs: 200,
      })
    } catch (error) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new Error("fake sandbox runSetup failed")
      )
    }
  },

  runCommand(params): Promise<CloudAgentSandboxCommandResult> {
    try {
      require(getStore().get(params.sandboxId), params.sandboxId)
      const command = params.command.trim()
      if (command.startsWith("fake-fail")) {
        return Promise.resolve({
          exitCode: 1,
          stdout: "",
          stderr: `[fake] command failed: ${command}\n`,
          durationMs: 5,
        })
      }
      if (command.startsWith("ls")) {
        const state = require(getStore().get(
          params.sandboxId
        ), params.sandboxId)
        return Promise.resolve({
          exitCode: 0,
          stdout: [...state.files.keys()].sort().join("\n") + "\n",
          stderr: "",
          durationMs: 5,
        })
      }
      if (
        command.startsWith("npm test") ||
        command.startsWith("pnpm test") ||
        command.startsWith("yarn test")
      ) {
        return Promise.resolve({
          exitCode: 0,
          stdout: `[fake] test runner stub\nPASS  fake.test\nTests: 1 passed, 1 total\n`,
          stderr: "",
          durationMs: 350,
        })
      }
      return Promise.resolve({
        exitCode: 0,
        stdout: `[fake] executed: ${command}\n`,
        stderr: "",
        durationMs: 50,
      })
    } catch (error) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new Error("fake sandbox runCommand failed")
      )
    }
  },

  writeFile(params): Promise<void> {
    try {
      const state = require(getStore().get(params.sandboxId), params.sandboxId)
      const path = ensureSafePath(params.path)
      const previous = state.files.get(path)
      const newLines = countLines(params.content)
      const oldLines = previous ? countLines(previous) : 0
      state.files.set(path, params.content)
      state.changes.set(path, {
        change: previous ? "modified" : "added",
        additions: previous ? Math.max(newLines - oldLines, 0) : newLines,
        deletions: previous ? Math.max(oldLines - newLines, 0) : 0,
      })
      return Promise.resolve()
    } catch (error) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new Error("fake sandbox writeFile failed")
      )
    }
  },

  readFile(params): Promise<{ content: string }> {
    try {
      const state = require(getStore().get(params.sandboxId), params.sandboxId)
      const path = ensureSafePath(params.path)
      const content = state.files.get(path)
      if (content === undefined) {
        throw new Error(
          `File ${path} not found in sandbox ${params.sandboxId}.`
        )
      }
      return Promise.resolve({ content })
    } catch (error) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new Error("fake sandbox readFile failed")
      )
    }
  },

  getDiff(params): Promise<CloudAgentSandboxDiff> {
    try {
      const state = require(getStore().get(params.sandboxId), params.sandboxId)
      const files = [...state.changes.entries()].map(([path, change]) => ({
        path,
        change: change.change,
        additions: change.additions,
        deletions: change.deletions,
      }))
      const totals = files.reduce(
        (acc, file) => ({
          filesChanged: acc.filesChanged + 1,
          additions: acc.additions + file.additions,
          deletions: acc.deletions + file.deletions,
        }),
        { filesChanged: 0, additions: 0, deletions: 0 }
      )
      return Promise.resolve({ files, totals })
    } catch (error) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new Error("fake sandbox getDiff failed")
      )
    }
  },

  createBranchAndPush(params): Promise<{ pushedRef: string }> {
    try {
      require(getStore().get(params.sandboxId), params.sandboxId)
      return Promise.resolve({ pushedRef: `refs/heads/${params.branch}` })
    } catch (error) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new Error("fake sandbox createBranchAndPush failed")
      )
    }
  },

  createPullRequest(params): Promise<{ url: string; number: number }> {
    try {
      require(getStore().get(params.sandboxId), params.sandboxId)
      const number = Math.floor(Math.random() * 9000) + 1000
      return Promise.resolve({
        url: `https://github.com/${params.repoOwner}/${params.repoName}/pull/${String(number)}`,
        number,
      })
    } catch (error) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new Error("fake sandbox createPullRequest failed")
      )
    }
  },

  destroy(params): Promise<void> {
    getStore().delete(params.sandboxId)
    return Promise.resolve()
  },
}

export function resetFakeCloudAgentSandboxes(): void {
  globalThis.chloeiCloudAgentFakeSandboxes?.clear()
}
