import { createHmac, timingSafeEqual } from "node:crypto"

import { z } from "zod"

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

// Zod schemas at the trust boundary. Webhook payloads are HMAC-
// signed but not structurally type-checked, so a malformed body
// should be `ignored` rather than silently degrading into a
// partial parse. `.loose()` keeps the upstream provider's extra
// fields without failing the parse.
const REPOSITORY_SCHEMA = z
  .object({
    full_name: z.string().optional(),
    owner: z.object({ login: z.string() }).loose(),
    name: z.string(),
  })
  .loose()

const ISSUE_COMMENT_PAYLOAD_SCHEMA = z
  .object({
    action: z.string(),
    issue: z
      .object({
        number: z.number().int(),
        pull_request: z.unknown().optional(),
        user: z.object({ login: z.string() }).loose().optional(),
      })
      .loose(),
    comment: z
      .object({
        body: z.string().optional(),
        user: z.object({ login: z.string() }).loose().optional(),
      })
      .loose(),
    repository: REPOSITORY_SCHEMA,
  })
  .loose()

const PULL_REQUEST_PAYLOAD_SCHEMA = z
  .object({
    action: z.string(),
    pull_request: z
      .object({
        number: z.number().int(),
        state: z.string().optional(),
        merged: z.boolean().optional(),
        head: z.object({ ref: z.string() }).loose(),
        base: z.object({ ref: z.string() }).loose(),
        user: z.object({ login: z.string() }).loose().optional(),
      })
      .loose(),
    repository: REPOSITORY_SCHEMA,
  })
  .loose()

const CHECK_RUN_PAYLOAD_SCHEMA = z
  .object({
    action: z.string(),
    check_run: z
      .object({
        name: z.string(),
        status: z.string().optional(),
        conclusion: z.string().nullish(),
        head_sha: z.string(),
        pull_requests: z
          .array(z.object({ number: z.number().int() }).loose())
          .optional(),
      })
      .loose(),
    repository: REPOSITORY_SCHEMA,
  })
  .loose()

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
    const parsed = ISSUE_COMMENT_PAYLOAD_SCHEMA.safeParse(params.payload)
    if (!parsed.success) {
      return { type: "ignored", reason: "Invalid issue_comment payload shape." }
    }
    const body = parsed.data
    if (body.action !== "created") {
      return { type: "ignored", reason: "Comment was not a create event." }
    }
    const commentBody = body.comment.body ?? ""
    const match = CHLOEI_FIX_PATTERN.exec(commentBody)
    if (!match) {
      return { type: "ignored", reason: "Comment does not mention @chloei." }
    }
    const action = match[2]?.toLowerCase() === "review" ? "review" : "fix"
    return {
      type: "chloei_mention",
      action,
      repoOwner: body.repository.owner.login,
      repoName: body.repository.name,
      issueNumber: body.issue.number,
      isPullRequest: Boolean(body.issue.pull_request),
      requester: body.comment.user?.login ?? "unknown",
      body: commentBody.slice(0, 4_000),
    }
  }

  if (params.event === "pull_request") {
    const parsed = PULL_REQUEST_PAYLOAD_SCHEMA.safeParse(params.payload)
    if (!parsed.success) {
      return { type: "ignored", reason: "Invalid pull_request payload shape." }
    }
    const body = parsed.data
    return {
      type: "pull_request",
      action: body.action,
      repoOwner: body.repository.owner.login,
      repoName: body.repository.name,
      number: body.pull_request.number,
      branch: body.pull_request.head.ref,
      baseBranch: body.pull_request.base.ref,
      merged: Boolean(body.pull_request.merged),
    }
  }

  if (params.event === "check_run") {
    const parsed = CHECK_RUN_PAYLOAD_SCHEMA.safeParse(params.payload)
    if (!parsed.success) {
      return { type: "ignored", reason: "Invalid check_run payload shape." }
    }
    const body = parsed.data
    if (body.action !== "completed") {
      return { type: "ignored", reason: "Check run not completed yet." }
    }
    if (body.check_run.conclusion !== "failure") {
      return { type: "ignored", reason: "Check run did not fail." }
    }
    const pullRequestNumbers = (body.check_run.pull_requests ?? []).map(
      (pr) => pr.number
    )
    return {
      type: "check_run_failed",
      repoOwner: body.repository.owner.login,
      repoName: body.repository.name,
      checkName: body.check_run.name,
      headSha: body.check_run.head_sha,
      pullRequestNumbers,
    }
  }

  return { type: "ignored", reason: `Unhandled event type: ${params.event}` }
}

const VERCEL_DEPLOYMENT_PAYLOAD_SCHEMA = z
  .object({
    type: z.string(),
    payload: z
      .object({
        url: z.string().optional(),
        target: z.string().optional(),
        project: z
          .object({ id: z.string(), name: z.string().optional() })
          .loose()
          .optional(),
        deployment: z
          .object({
            url: z.string().optional(),
            target: z.string().optional(),
            meta: z.record(z.string(), z.string().optional()).optional(),
          })
          .loose()
          .optional(),
      })
      .loose()
      .optional(),
  })
  .loose()

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
  const parsed = VERCEL_DEPLOYMENT_PAYLOAD_SCHEMA.safeParse(payload)
  if (!parsed.success) {
    return { type: "ignored", reason: "Invalid Vercel webhook payload shape." }
  }
  const body = parsed.data
  if (!body.type.startsWith("deployment.")) {
    return { type: "ignored", reason: `Unhandled Vercel event: ${body.type}` }
  }
  if (
    body.type !== "deployment.succeeded" &&
    body.type !== "deployment.ready"
  ) {
    return { type: "ignored", reason: `Skipping ${body.type}` }
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
