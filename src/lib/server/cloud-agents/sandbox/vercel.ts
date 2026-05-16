import { createLogger } from "@/lib/logger"

import {
  getGithubInstallationToken,
  resolveGithubAppCredentials,
} from "../github-app"
import type {
  CloudAgentSandboxAdapter,
  CloudAgentSandboxCommandResult,
  CloudAgentSandboxDiff,
  CloudAgentSandboxProvisionInput,
  CloudAgentSandboxProvisionResult,
} from "./types"

const logger = createLogger("cloud-agent-sandbox-vercel")

const SANDBOX_TIMEOUT_MS = (() => {
  const raw = process.env.CLOUD_AGENT_SANDBOX_TIMEOUT_MS
  if (!raw) return 90 * 60 * 1000
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 90 * 60 * 1000
})()
const SANDBOX_GIT_DEPTH = (() => {
  const raw = process.env.CLOUD_AGENT_SANDBOX_GIT_DEPTH
  if (!raw) return 50
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 50
})()

// Tracks whether writeFile saw the path before so the write_file tool
// can label its file_change event as `added` vs `modified`. The per-
// file line counts that used to live here are gone: getDiff now reads
// the working tree via `git status` + `git diff --numstat` so it
// captures `run_command` mutations too.
interface FileChangeRecord {
  wasNew: boolean
}

interface VercelSandboxSession {
  sandbox: {
    sandboxId: string
    runCommand(params: {
      cmd: string
      args?: string[]
      cwd?: string
      env?: Record<string, string>
      signal?: AbortSignal
    }): Promise<{
      exitCode: number
      stdout: () => Promise<string>
      stderr: () => Promise<string>
    }>
    writeFiles(
      files: { path: string; content: Buffer | string }[]
    ): Promise<void>
    stop?: () => Promise<void>
  }
  repoCwd: string
  baseBranch: string
  repoOwner: string
  repoName: string
  fileChanges: Map<string, FileChangeRecord>
}

const sessions = new Map<string, VercelSandboxSession>()

function require(sandboxId: string): VercelSandboxSession {
  const session = sessions.get(sandboxId)
  if (!session) {
    throw new Error(`Vercel sandbox session ${sandboxId} not found.`)
  }
  return session
}

async function rehydrateSession(params: {
  sandboxId: string
  repoOwner: string
  repoName: string
  baseBranch: string
}): Promise<VercelSandboxSession> {
  const existing = sessions.get(params.sandboxId)
  if (existing) return existing
  const { Sandbox } = await import("@vercel/sandbox")
  const sandbox = await Sandbox.get({ sandboxId: params.sandboxId })
  const session: VercelSandboxSession = {
    sandbox: sandbox as unknown as VercelSandboxSession["sandbox"],
    repoCwd: SANDBOX_REPO_CWD,
    baseBranch: params.baseBranch,
    repoOwner: params.repoOwner,
    repoName: params.repoName,
    fileChanges: new Map(),
  }
  sessions.set(params.sandboxId, session)
  logger.info("Rehydrated Vercel sandbox session.", {
    sandboxId: params.sandboxId,
    repoOwner: params.repoOwner,
    repoName: params.repoName,
  })
  return session
}

const SANDBOX_REPO_CWD = "/vercel/sandbox"

// Defense in depth alongside FILE_PATH_SCHEMA in sandbox/tools.ts.
// Even if a caller bypasses the AI SDK tool schema (e.g. a future
// scripted runtime that calls writeFile directly), the adapter must
// not let the LLM write outside its sandbox checkout via traversal,
// NUL bytes, or absolute paths.
function ensureSafeRepoPath(path: string): string {
  const trimmed = path.trim()
  if (
    !trimmed ||
    trimmed.startsWith("/") ||
    trimmed.includes("\0") ||
    trimmed.includes("\\") ||
    trimmed.split("/").some((segment) => segment === ".." || segment === ".")
  ) {
    throw new Error(
      "Repo-relative path required: no leading '/', no '..'/'.' segments, no NUL bytes or backslashes."
    )
  }
  return trimmed
}

interface GitStatusEntry {
  path: string
  previousPath?: string
  change: "added" | "modified" | "deleted" | "renamed"
}

// `git status --porcelain=v1 -z` separates entries with NUL bytes.
// Each entry is `XY␣<path>` (and renames inline an extra NUL +
// origin path). We only care about working-tree mutations the user
// is about to push, so collapse the index + worktree fields into a
// single change classification per path.
function parseGitStatusPorcelainZ(text: string): GitStatusEntry[] {
  const entries: GitStatusEntry[] = []
  const tokens = text.split("\0")
  let i = 0
  while (i < tokens.length) {
    const token = tokens[i]
    if (!token || token.length < 3) {
      i += 1
      continue
    }
    const xy = token.slice(0, 2)
    const path = token.slice(3)
    const indexStatus = xy[0] ?? " "
    const worktreeStatus = xy[1] ?? " "
    if (indexStatus === "R" || worktreeStatus === "R") {
      const previousPath = tokens[i + 1]
      entries.push({
        path,
        change: "renamed",
        ...(previousPath ? { previousPath } : {}),
      })
      i += 2
      continue
    }
    const summary = `${indexStatus}${worktreeStatus}`
    if (summary === "??" || indexStatus === "A") {
      entries.push({ path, change: "added" })
    } else if (indexStatus === "D" || worktreeStatus === "D") {
      entries.push({ path, change: "deleted" })
    } else {
      entries.push({ path, change: "modified" })
    }
    i += 1
  }
  return entries
}

// `git diff --numstat` rows are `<additions>\t<deletions>\t<path>`.
// Binary files use `-` for the numeric fields; treat those as 0/0.
function parseGitNumstat(
  text: string
): Map<string, { additions: number; deletions: number }> {
  const result = new Map<string, { additions: number; deletions: number }>()
  for (const line of text.split("\n")) {
    if (!line) continue
    const parts = line.split("\t")
    if (parts.length < 3) continue
    const additionsRaw = parts[0] ?? "0"
    const deletionsRaw = parts[1] ?? "0"
    const path = parts.slice(2).join("\t").trim()
    if (!path) continue
    const additions =
      additionsRaw === "-" ? 0 : Number.parseInt(additionsRaw, 10)
    const deletions =
      deletionsRaw === "-" ? 0 : Number.parseInt(deletionsRaw, 10)
    result.set(path, {
      additions: Number.isFinite(additions) ? additions : 0,
      deletions: Number.isFinite(deletions) ? deletions : 0,
    })
  }
  return result
}

async function readFileContent(
  session: VercelSandboxSession,
  path: string
): Promise<string | null> {
  const result = await session.sandbox.runCommand({
    cmd: "cat",
    args: [path],
    cwd: session.repoCwd,
  })
  if (result.exitCode !== 0) return null
  return await result.stdout()
}

async function asCommandResult(
  startedAt: number,
  result: {
    exitCode: number
    stdout: () => Promise<string>
    stderr: () => Promise<string>
  }
): Promise<CloudAgentSandboxCommandResult> {
  const [stdout, stderr] = await Promise.all([result.stdout(), result.stderr()])
  return {
    exitCode: result.exitCode,
    stdout,
    stderr,
    durationMs: Date.now() - startedAt,
  }
}

export function isVercelSandboxConfigured(): boolean {
  const token = process.env.VERCEL_TOKEN ?? process.env.VERCEL_OIDC_TOKEN
  return Boolean(
    token && process.env.VERCEL_TEAM_ID && process.env.VERCEL_PROJECT_ID
  )
}

// Map our CloudAgentSandboxRuntime enum to the strings the
// @vercel/sandbox SDK accepts ("node22"/"node24"/"node26"/"python3.13").
// Throw on unknown values rather than silently picking a different
// version — the schema only allows the supported set.
function mapToVercelRuntime(value: string): string {
  switch (value) {
    case "node22":
    case "node24":
    case "node26":
      return value
    case "python313":
      return "python3.13"
    default:
      throw new Error(
        `Unsupported sandbox runtime ${value}; allowed: node22, node24, node26, python313.`
      )
  }
}

// Map our networkPolicy onto the Vercel SDK's NetworkPolicy union.
// `setup_only` is treated as `allow-all` at creation time because the
// SDK only supports phase-transition via updateNetworkPolicy after
// setup completes; tightening it post-setup is a follow-up.
function mapToVercelNetworkPolicy(
  policy: CloudAgentSandboxProvisionInput["networkPolicy"]
): "allow-all" | "deny-all" | { allow: string[] } {
  switch (policy.mode) {
    case "off":
      return "deny-all"
    case "open":
    case "setup_only":
      return "allow-all"
    case "allowlist":
      return { allow: policy.allowlist ?? [] }
  }
}

export const vercelCloudAgentSandboxAdapter: CloudAgentSandboxAdapter = {
  id: "vercel",
  async provision(
    input: CloudAgentSandboxProvisionInput
  ): Promise<CloudAgentSandboxProvisionResult> {
    const { Sandbox } = await import("@vercel/sandbox")
    const sandbox = await Sandbox.create({
      timeout: SANDBOX_TIMEOUT_MS,
      runtime: mapToVercelRuntime(input.sandboxRuntime),
      networkPolicy: mapToVercelNetworkPolicy(input.networkPolicy),
      source: {
        type: "git",
        url: `https://github.com/${input.repoOwner}/${input.repoName}.git`,
        revision: input.baseBranch,
        depth: SANDBOX_GIT_DEPTH,
      },
    })
    const repoCwd = SANDBOX_REPO_CWD
    const session: VercelSandboxSession = {
      sandbox: sandbox as unknown as VercelSandboxSession["sandbox"],
      repoCwd,
      baseBranch: input.baseBranch,
      repoOwner: input.repoOwner,
      repoName: input.repoName,
      fileChanges: new Map(),
    }
    sessions.set(sandbox.sandboxId, session)
    logger.info("Provisioned Vercel sandbox.", {
      sandboxId: sandbox.sandboxId,
      repoOwner: input.repoOwner,
      repoName: input.repoName,
    })
    return { sandboxId: sandbox.sandboxId }
  },

  async runSetup(params): Promise<CloudAgentSandboxCommandResult> {
    const session = require(params.sandboxId)
    const startedAt = Date.now()
    const result = await session.sandbox.runCommand({
      cmd: "sh",
      args: ["-lc", params.command],
      cwd: session.repoCwd,
    })
    return asCommandResult(startedAt, result)
  },

  async runCommand(params): Promise<CloudAgentSandboxCommandResult> {
    const session = require(params.sandboxId)
    const startedAt = Date.now()
    // Wire the adapter-level timeoutMs through to the Vercel SDK via
    // an AbortController so a model-controlled command that hangs
    // (LLM `run_command` tool) doesn't stall the entire Inngest step
    // until the sandbox 90-minute timeout.
    const controller =
      params.timeoutMs !== undefined ? new AbortController() : null
    const timeoutHandle =
      controller && params.timeoutMs !== undefined
        ? setTimeout(() => {
            controller.abort()
          }, params.timeoutMs)
        : null
    try {
      const result = await session.sandbox.runCommand({
        cmd: "sh",
        args: ["-lc", params.command],
        cwd: session.repoCwd,
        ...(controller ? { signal: controller.signal } : {}),
      })
      return await asCommandResult(startedAt, result)
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }
  },

  async writeFile(params) {
    const session = require(params.sandboxId)
    const safePath = ensureSafeRepoPath(params.path)
    const existing = session.fileChanges.get(safePath)
    const wasNew =
      existing?.wasNew ?? (await readFileContent(session, safePath)) === null
    await session.sandbox.writeFiles([
      {
        path: `${session.repoCwd}/${safePath}`,
        content: Buffer.from(params.content, "utf8"),
      },
    ])
    session.fileChanges.set(safePath, { wasNew })
    return { wasNew }
  },

  async readFile(params) {
    const session = require(params.sandboxId)
    const safePath = ensureSafeRepoPath(params.path)
    const result = await session.sandbox.runCommand({
      cmd: "cat",
      args: [safePath],
      cwd: session.repoCwd,
    })
    if (result.exitCode !== 0) {
      const stderr = await result.stderr()
      throw new Error(`Failed to read ${safePath}: ${stderr}`)
    }
    return { content: await result.stdout() }
  },

  async getDiff(params): Promise<CloudAgentSandboxDiff> {
    void params.baseBranch
    const session = require(params.sandboxId)
    // Enumerate working-tree changes via git so we capture mutations
    // from `run_command` (sed, formatters, codemods, pkg managers)
    // alongside writeFile-tracked edits. Without this, the approval
    // UI showed zero files while `git add -A` later included them in
    // the pushed PR.
    const status = await session.sandbox.runCommand({
      cmd: "git",
      args: ["status", "--porcelain=v1", "--untracked-files=all", "-z"],
      cwd: session.repoCwd,
    })
    if (status.exitCode !== 0) {
      const stderr = await status.stderr()
      throw new Error(`git status failed: ${stderr}`)
    }
    const statusText = await status.stdout()
    const statusEntries = parseGitStatusPorcelainZ(statusText)

    const numstat = await session.sandbox.runCommand({
      cmd: "sh",
      args: [
        "-lc",
        // Use `git add --intent-to-add` semantics implicitly: diff
        // HEAD (already at the base commit since we cloned single-
        // revision) against the working tree. `git diff` doesn't
        // report untracked files, so we layer those in from status.
        "git diff --numstat HEAD -- 2>/dev/null; " +
          // For each untracked file, count its line count as
          // additions (deletions=0). Pipes to wc -l for each path.
          "git status --porcelain --untracked-files=all -z " +
          "| while IFS= read -r -d '' entry; do " +
          "case \"$entry\" in '?? '*) " +
          'p="${entry:3}"; ' +
          'lines=$(wc -l < "$p" 2>/dev/null || echo 0); ' +
          'printf "%s\\t0\\t%s\\n" "$lines" "$p" ;; ' +
          "esac; done",
      ],
      cwd: session.repoCwd,
    })
    const numstatText = numstat.exitCode === 0 ? await numstat.stdout() : ""
    const numstatByPath = parseGitNumstat(numstatText)

    const files: CloudAgentSandboxDiff["files"] = []
    let totalAdditions = 0
    let totalDeletions = 0
    for (const entry of statusEntries) {
      const numstatRow = numstatByPath.get(entry.path)
      const additions = numstatRow?.additions ?? 0
      const deletions = numstatRow?.deletions ?? 0
      totalAdditions += additions
      totalDeletions += deletions
      files.push({
        path: entry.path,
        change: entry.change,
        additions,
        deletions,
        ...(entry.previousPath ? { previousPath: entry.previousPath } : {}),
      })
    }
    return {
      files,
      totals: {
        filesChanged: files.length,
        additions: totalAdditions,
        deletions: totalDeletions,
      },
    }
  },

  async createBranchAndPush(params) {
    const session = await rehydrateSession({
      sandboxId: params.sandboxId,
      repoOwner: params.repoOwner,
      repoName: params.repoName,
      baseBranch: params.baseBranch,
    })
    const credentials = resolveGithubAppCredentials()
    if (!credentials) {
      throw new Error(
        "GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be configured to push branches."
      )
    }
    const githubToken = await getGithubInstallationToken({
      credentials,
      owner: session.repoOwner,
      repo: session.repoName,
    })
    const checkout = await session.sandbox.runCommand({
      cmd: "git",
      args: ["checkout", "-b", params.branch],
      cwd: session.repoCwd,
    })
    if (checkout.exitCode !== 0) {
      throw new Error(
        `git checkout -b ${params.branch} failed: ${await checkout.stderr()}`
      )
    }
    const add = await session.sandbox.runCommand({
      cmd: "git",
      args: ["add", "-A"],
      cwd: session.repoCwd,
    })
    if (add.exitCode !== 0) {
      throw new Error(`git add failed: ${await add.stderr()}`)
    }
    const commit = await session.sandbox.runCommand({
      cmd: "git",
      args: [
        "-c",
        "user.name=Chloei Cloud Agent",
        "-c",
        "user.email=cloud-agents@chloei.ai",
        "commit",
        "-m",
        `chloei: ${params.branch}`,
      ],
      cwd: session.repoCwd,
    })
    if (commit.exitCode !== 0) {
      throw new Error(`git commit failed: ${await commit.stderr()}`)
    }
    // Pass the token, repo identifiers, and branch through env vars rather
    // than interpolating them into the shell command. Env var VALUES are
    // not re-parsed by the shell, so double-quoted `"$CHLOEI_REPO_OWNER"`
    // expands to the literal value even if it contains `$(...)` or other
    // shell metacharacters. Using `cmd: "git"` directly skips shell
    // expansion, so the auth header token would land as literal text; we
    // need `sh -lc` to expand $CHLOEI_GITHUB_TOKEN into the header.
    const push = await session.sandbox.runCommand({
      cmd: "sh",
      args: [
        "-lc",
        'git -c "http.extraHeader=Authorization: Bearer $CHLOEI_GITHUB_TOKEN" ' +
          'push "https://github.com/$CHLOEI_REPO_OWNER/$CHLOEI_REPO_NAME.git" ' +
          '"HEAD:refs/heads/$CHLOEI_BRANCH"',
      ],
      cwd: session.repoCwd,
      env: {
        CHLOEI_GITHUB_TOKEN: githubToken,
        CHLOEI_REPO_OWNER: session.repoOwner,
        CHLOEI_REPO_NAME: session.repoName,
        CHLOEI_BRANCH: params.branch,
      },
    })
    if (push.exitCode !== 0) {
      throw new Error(`git push failed: ${await push.stderr()}`)
    }
    return { pushedRef: `refs/heads/${params.branch}` }
  },

  async createPullRequest(params) {
    const credentials = resolveGithubAppCredentials()
    if (!credentials) {
      throw new Error(
        "GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be configured to create pull requests."
      )
    }
    const githubToken = await getGithubInstallationToken({
      credentials,
      owner: params.repoOwner,
      repo: params.repoName,
    })
    const { Octokit } = await import("@octokit/rest")
    const octokit = new Octokit({ auth: githubToken })
    const pr = await octokit.pulls.create({
      owner: params.repoOwner,
      repo: params.repoName,
      head: params.branch,
      base: params.baseBranch,
      title: params.title,
      body: params.body,
      maintainer_can_modify: true,
    })
    return { url: pr.data.html_url, number: pr.data.number }
  },

  async destroy(params) {
    sessions.delete(params.sandboxId)
    try {
      const { Sandbox } = await import("@vercel/sandbox")
      const live = (await Sandbox.get({
        sandboxId: params.sandboxId,
      })) as unknown as { stop?: () => Promise<unknown> }
      if (typeof live.stop === "function") {
        await live.stop()
      }
    } catch (error) {
      logger.warn("Failed to stop Vercel sandbox.", {
        sandboxId: params.sandboxId,
        error,
      })
    }
  },
}
