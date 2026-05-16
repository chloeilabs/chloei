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

interface FileChangeRecord {
  wasNew: boolean
  newLineCount: number
  oldLineCount: number
}

function countLines(text: string): number {
  if (text.length === 0) return 0
  return text.split("\n").length
}

interface VercelSandboxSession {
  sandbox: {
    sandboxId: string
    runCommand(params: {
      cmd: string
      args?: string[]
      cwd?: string
      env?: Record<string, string>
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

export const vercelCloudAgentSandboxAdapter: CloudAgentSandboxAdapter = {
  id: "vercel",
  async provision(
    input: CloudAgentSandboxProvisionInput
  ): Promise<CloudAgentSandboxProvisionResult> {
    const { Sandbox } = await import("@vercel/sandbox")
    const sandbox = await Sandbox.create({
      timeout: SANDBOX_TIMEOUT_MS,
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
    const result = await session.sandbox.runCommand({
      cmd: "sh",
      args: ["-lc", params.command],
      cwd: session.repoCwd,
    })
    return asCommandResult(startedAt, result)
  },

  async writeFile(params) {
    const session = require(params.sandboxId)
    const existing = session.fileChanges.get(params.path)
    const wasNew =
      existing?.wasNew ?? (await readFileContent(session, params.path)) === null
    const oldLineCount =
      existing?.oldLineCount ??
      (wasNew
        ? 0
        : countLines((await readFileContent(session, params.path)) ?? ""))
    await session.sandbox.writeFiles([
      {
        path: `${session.repoCwd}/${params.path}`,
        content: Buffer.from(params.content, "utf8"),
      },
    ])
    session.fileChanges.set(params.path, {
      wasNew,
      oldLineCount,
      newLineCount: countLines(params.content),
    })
    return { wasNew }
  },

  async readFile(params) {
    const session = require(params.sandboxId)
    const result = await session.sandbox.runCommand({
      cmd: "cat",
      args: [params.path],
      cwd: session.repoCwd,
    })
    if (result.exitCode !== 0) {
      const stderr = await result.stderr()
      throw new Error(`Failed to read ${params.path}: ${stderr}`)
    }
    return { content: await result.stdout() }
  },

  async getDiff(params): Promise<CloudAgentSandboxDiff> {
    void params.baseBranch
    const session = require(params.sandboxId)
    const files: CloudAgentSandboxDiff["files"] = []
    let totalAdditions = 0
    let totalDeletions = 0
    for (const [path, record] of session.fileChanges.entries()) {
      const additions = record.wasNew
        ? record.newLineCount
        : Math.max(record.newLineCount - record.oldLineCount, 0)
      const deletions = record.wasNew
        ? 0
        : Math.max(record.oldLineCount - record.newLineCount, 0)
      totalAdditions += additions
      totalDeletions += deletions
      files.push({
        path,
        change: record.wasNew ? "added" : "modified",
        additions,
        deletions,
      })
    }
    return Promise.resolve({
      files,
      totals: {
        filesChanged: files.length,
        additions: totalAdditions,
        deletions: totalDeletions,
      },
    })
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
