import { createHmac, timingSafeEqual } from "node:crypto"

export interface WebhookVerificationResult {
  ok: boolean
  reason?: string
}

export function verifyGithubWebhookSignature(params: {
  payload: string
  signatureHeader: string | null
  secret: string
}): WebhookVerificationResult {
  if (!params.signatureHeader) {
    return { ok: false, reason: "Missing X-Hub-Signature-256 header." }
  }
  const expectedPrefix = "sha256="
  if (!params.signatureHeader.startsWith(expectedPrefix)) {
    return { ok: false, reason: "Signature must use sha256= prefix." }
  }
  const provided = params.signatureHeader.slice(expectedPrefix.length)
  const computed = createHmac("sha256", params.secret)
    .update(params.payload)
    .digest("hex")
  const providedBuffer = Buffer.from(provided, "hex")
  const computedBuffer = Buffer.from(computed, "hex")
  if (
    providedBuffer.length === 0 ||
    providedBuffer.length !== computedBuffer.length
  ) {
    return { ok: false, reason: "Signature length mismatch." }
  }
  return timingSafeEqual(providedBuffer, computedBuffer)
    ? { ok: true }
    : { ok: false, reason: "Signature verification failed." }
}

interface GithubIssueCommentPayload {
  action?: string
  issue?: { number?: number; pull_request?: unknown; user?: { login?: string } }
  comment?: { body?: string; user?: { login?: string } }
  repository?: { full_name?: string; owner?: { login?: string }; name?: string }
  installation?: { id?: number }
  sender?: { login?: string }
}

interface GithubPullRequestPayload {
  action?: string
  pull_request?: {
    number?: number
    state?: string
    merged?: boolean
    head?: { ref?: string }
    base?: { ref?: string }
    user?: { login?: string }
  }
  repository?: { full_name?: string; owner?: { login?: string }; name?: string }
}

interface GithubCheckRunPayload {
  action?: string
  check_run?: {
    name?: string
    status?: string
    conclusion?: string
    head_sha?: string
    pull_requests?: { number?: number }[]
  }
  repository?: { full_name?: string; owner?: { login?: string }; name?: string }
}

export type ParsedGithubWebhookEvent =
  | {
      type: "chloei_mention"
      action: "fix" | "review"
      repoOwner: string
      repoName: string
      issueNumber: number
      isPullRequest: boolean
      requester: string
      body: string
    }
  | {
      type: "pull_request"
      action: string
      repoOwner: string
      repoName: string
      number: number
      branch: string
      baseBranch: string
      merged: boolean
    }
  | {
      type: "check_run_failed"
      repoOwner: string
      repoName: string
      checkName: string
      headSha: string
      pullRequestNumbers: number[]
    }
  | { type: "ignored"; reason: string }

const CHLOEI_FIX_PATTERN = /(^|\s)@chloei\s+(fix|review)\b/i

export function parseGithubWebhookEvent(params: {
  event: string
  payload: unknown
}): ParsedGithubWebhookEvent {
  if (params.event === "issue_comment") {
    const body = params.payload as GithubIssueCommentPayload
    if (body.action !== "created") {
      return { type: "ignored", reason: "Comment was not a create event." }
    }
    const repoOwner = body.repository?.owner?.login
    const repoName = body.repository?.name
    const issueNumber = body.issue?.number
    const commentBody = body.comment?.body ?? ""
    if (!repoOwner || !repoName || !issueNumber) {
      return { type: "ignored", reason: "Missing repo/issue identifiers." }
    }
    const match = CHLOEI_FIX_PATTERN.exec(commentBody)
    if (!match) {
      return { type: "ignored", reason: "Comment does not mention @chloei." }
    }
    const action = match[2]?.toLowerCase() === "review" ? "review" : "fix"
    return {
      type: "chloei_mention",
      action,
      repoOwner,
      repoName,
      issueNumber,
      isPullRequest: Boolean(body.issue?.pull_request),
      requester: body.comment?.user?.login ?? "unknown",
      body: commentBody.slice(0, 4_000),
    }
  }

  if (params.event === "pull_request") {
    const body = params.payload as GithubPullRequestPayload
    const repoOwner = body.repository?.owner?.login
    const repoName = body.repository?.name
    const number = body.pull_request?.number
    const branch = body.pull_request?.head?.ref
    const baseBranch = body.pull_request?.base?.ref
    if (!repoOwner || !repoName || !number || !branch || !baseBranch) {
      return { type: "ignored", reason: "Missing pull request fields." }
    }
    return {
      type: "pull_request",
      action: body.action ?? "unknown",
      repoOwner,
      repoName,
      number,
      branch,
      baseBranch,
      merged: Boolean(body.pull_request?.merged),
    }
  }

  if (params.event === "check_run") {
    const body = params.payload as GithubCheckRunPayload
    if (body.action !== "completed") {
      return { type: "ignored", reason: "Check run not completed yet." }
    }
    if (body.check_run?.conclusion !== "failure") {
      return { type: "ignored", reason: "Check run did not fail." }
    }
    const repoOwner = body.repository?.owner?.login
    const repoName = body.repository?.name
    const checkName = body.check_run.name
    const headSha = body.check_run.head_sha
    if (!repoOwner || !repoName || !checkName || !headSha) {
      return { type: "ignored", reason: "Missing check run fields." }
    }
    const pullRequestNumbers = (body.check_run.pull_requests ?? [])
      .map((pr) => pr.number)
      .filter((n): n is number => typeof n === "number")
    return {
      type: "check_run_failed",
      repoOwner,
      repoName,
      checkName,
      headSha,
      pullRequestNumbers,
    }
  }

  return { type: "ignored", reason: `Unhandled event type: ${params.event}` }
}

interface VercelDeploymentPayload {
  type?: string
  payload?: {
    url?: string
    name?: string
    target?: string
    project?: { id?: string; name?: string }
    deployment?: {
      url?: string
      meta?: Record<string, string | undefined>
      target?: string
    }
    deploymentId?: string
    user?: { id?: string }
  }
}

export type ParsedVercelWebhookEvent =
  | {
      type: "deployment_ready"
      url: string
      target: string
      projectId: string
      taskId?: string
      branch?: string
    }
  | { type: "ignored"; reason: string }

export function verifyVercelWebhookSignature(params: {
  payload: string
  signatureHeader: string | null
  secret: string
}): WebhookVerificationResult {
  if (!params.signatureHeader) {
    return { ok: false, reason: "Missing x-vercel-signature header." }
  }
  const computed = createHmac("sha1", params.secret)
    .update(params.payload)
    .digest("hex")
  const providedBuffer = Buffer.from(params.signatureHeader, "hex")
  const computedBuffer = Buffer.from(computed, "hex")
  if (
    providedBuffer.length === 0 ||
    providedBuffer.length !== computedBuffer.length
  ) {
    return { ok: false, reason: "Signature length mismatch." }
  }
  return timingSafeEqual(providedBuffer, computedBuffer)
    ? { ok: true }
    : { ok: false, reason: "Signature verification failed." }
}

export function parseVercelWebhookEvent(
  payload: unknown
): ParsedVercelWebhookEvent {
  const body = payload as VercelDeploymentPayload
  const type = body.type ?? ""
  if (!type.startsWith("deployment.")) {
    return { type: "ignored", reason: `Unhandled Vercel event: ${type}` }
  }
  if (type !== "deployment.succeeded" && type !== "deployment.ready") {
    return { type: "ignored", reason: `Skipping ${type}` }
  }
  const url = body.payload?.deployment?.url ?? body.payload?.url ?? null
  const target =
    body.payload?.deployment?.target ?? body.payload?.target ?? "preview"
  const projectId = body.payload?.project?.id ?? null
  if (!url || !projectId) {
    return { type: "ignored", reason: "Missing deployment URL or project id." }
  }
  const meta = body.payload?.deployment?.meta ?? {}
  const taskId = meta.chloei_task_id
  const branch =
    meta.githubCommitRef ?? meta.gitlabCommitRef ?? meta.bitbucketCommitRef
  return {
    type: "deployment_ready",
    url: url.startsWith("http") ? url : `https://${url}`,
    target,
    projectId,
    ...(taskId ? { taskId } : {}),
    ...(branch ? { branch } : {}),
  }
}
