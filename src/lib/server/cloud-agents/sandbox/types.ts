export interface CloudAgentSandboxFileChange {
  path: string
  change: "added" | "modified" | "deleted" | "renamed"
  previousPath?: string
  additions: number
  deletions: number
}

export interface CloudAgentSandboxDiff {
  files: CloudAgentSandboxFileChange[]
  totals: {
    filesChanged: number
    additions: number
    deletions: number
  }
}

export interface CloudAgentSandboxCommandResult {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
}

export interface CloudAgentSandboxProvisionInput {
  userId: string
  taskId: string
  repoOwner: string
  repoName: string
  baseBranch: string
  sandboxRuntime: string
  networkPolicy: {
    mode: "setup_only" | "open" | "off" | "allowlist"
    allowlist?: string[]
  }
}

export interface CloudAgentSandboxProvisionResult {
  sandboxId: string
}

export interface CloudAgentSandboxAdapter {
  readonly id: string
  provision(
    input: CloudAgentSandboxProvisionInput
  ): Promise<CloudAgentSandboxProvisionResult>
  // Mirrors the provision-time networkPolicy shape so the runtime can
  // tighten or relax an existing sandbox's policy after a phase
  // transition (e.g. flipping `setup_only` to `deny-all` once the
  // setup phase completes). Implementations should be best-effort —
  // callers wrap failures in `.catch(...)` rather than aborting the
  // run.
  setNetworkPolicy(params: {
    sandboxId: string
    policy: {
      mode: "setup_only" | "open" | "off" | "allowlist"
      allowlist?: string[]
    }
  }): Promise<void>
  runSetup(params: {
    sandboxId: string
    command: string
  }): Promise<CloudAgentSandboxCommandResult>
  runCommand(params: {
    sandboxId: string
    command: string
    timeoutMs?: number
  }): Promise<CloudAgentSandboxCommandResult>
  writeFile(params: {
    sandboxId: string
    path: string
    content: string
  }): Promise<{ wasNew: boolean }>
  readFile(params: {
    sandboxId: string
    path: string
  }): Promise<{ content: string }>
  getDiff(params: {
    sandboxId: string
    baseBranch: string
  }): Promise<CloudAgentSandboxDiff>
  createBranchAndPush(params: {
    sandboxId: string
    repoOwner: string
    repoName: string
    baseBranch: string
    branch: string
  }): Promise<{ pushedRef: string }>
  createPullRequest(params: {
    sandboxId: string
    repoOwner: string
    repoName: string
    branch: string
    baseBranch: string
    title: string
    body: string
  }): Promise<{ url: string; number: number }>
  destroy(params: { sandboxId: string }): Promise<void>
}
