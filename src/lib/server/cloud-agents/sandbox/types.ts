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
}

export interface CloudAgentSandboxProvisionResult {
  sandboxId: string
}

export interface CloudAgentSandboxAdapter {
  readonly id: string
  provision(
    input: CloudAgentSandboxProvisionInput
  ): Promise<CloudAgentSandboxProvisionResult>
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
  }): Promise<void>
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
