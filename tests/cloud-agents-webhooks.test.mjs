import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const webhooksUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/cloud-agents/webhooks.ts")
).href

const {
  parseGithubWebhookEvent,
  parseVercelWebhookEvent,
  verifyGithubWebhookSignature,
  verifyVercelWebhookSignature,
} = await import(webhooksUrl)

function githubSignature(secret, payload) {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`
}

function vercelSignature(secret, payload) {
  return createHmac("sha1", secret).update(payload).digest("hex")
}

test("github signature verification accepts well-formed sha256 headers", () => {
  const payload = JSON.stringify({ hello: "world" })
  const secret = "hunter2"
  const sig = githubSignature(secret, payload)
  assert.deepEqual(
    verifyGithubWebhookSignature({ payload, signatureHeader: sig, secret }),
    { ok: true }
  )
})

test("github signature verification rejects altered payloads", () => {
  const payload = JSON.stringify({ hello: "world" })
  const sig = githubSignature("hunter2", payload)
  const result = verifyGithubWebhookSignature({
    payload: JSON.stringify({ hello: "altered" }),
    signatureHeader: sig,
    secret: "hunter2",
  })
  assert.equal(result.ok, false)
})

test("github signature verification rejects missing header", () => {
  const result = verifyGithubWebhookSignature({
    payload: "{}",
    signatureHeader: null,
    secret: "hunter2",
  })
  assert.equal(result.ok, false)
  assert.match(result.reason ?? "", /Missing/)
})

test("github webhook parser extracts @chloei fix mentions", () => {
  const parsed = parseGithubWebhookEvent({
    event: "issue_comment",
    payload: {
      action: "created",
      issue: { number: 42, pull_request: { url: "x" } },
      comment: {
        body: "@chloei fix the failing snapshot test",
        user: { login: "person" },
      },
      repository: { owner: { login: "acme" }, name: "widgets" },
    },
  })
  assert.equal(parsed.type, "chloei_mention")
  assert.equal(parsed.action, "fix")
  assert.equal(parsed.repoOwner, "acme")
  assert.equal(parsed.repoName, "widgets")
  assert.equal(parsed.issueNumber, 42)
  assert.equal(parsed.isPullRequest, true)
  assert.equal(parsed.requester, "person")
})

test("github webhook parser ignores comments without @chloei", () => {
  const parsed = parseGithubWebhookEvent({
    event: "issue_comment",
    payload: {
      action: "created",
      issue: { number: 1 },
      comment: { body: "looks good" },
      repository: { owner: { login: "acme" }, name: "widgets" },
    },
  })
  assert.equal(parsed.type, "ignored")
})

test("github webhook parser handles check_run failures", () => {
  const parsed = parseGithubWebhookEvent({
    event: "check_run",
    payload: {
      action: "completed",
      check_run: {
        name: "ci/unit",
        conclusion: "failure",
        head_sha: "abc123",
        pull_requests: [{ number: 7 }],
      },
      repository: { owner: { login: "acme" }, name: "widgets" },
    },
  })
  assert.equal(parsed.type, "check_run_failed")
  assert.equal(parsed.checkName, "ci/unit")
  assert.deepEqual(parsed.pullRequestNumbers, [7])
})

test("github webhook parser ignores successful check runs", () => {
  const parsed = parseGithubWebhookEvent({
    event: "check_run",
    payload: {
      action: "completed",
      check_run: { name: "ci", conclusion: "success", head_sha: "abc" },
      repository: { owner: { login: "acme" }, name: "widgets" },
    },
  })
  assert.equal(parsed.type, "ignored")
})

test("github webhook parser extracts pull request metadata", () => {
  const parsed = parseGithubWebhookEvent({
    event: "pull_request",
    payload: {
      action: "closed",
      pull_request: {
        number: 9,
        merged: true,
        head: { ref: "feature/x" },
        base: { ref: "main" },
      },
      repository: { owner: { login: "acme" }, name: "widgets" },
    },
  })
  assert.equal(parsed.type, "pull_request")
  assert.equal(parsed.action, "closed")
  assert.equal(parsed.merged, true)
  assert.equal(parsed.branch, "feature/x")
})

test("vercel signature verification matches sha1 hmac of body", () => {
  const payload = JSON.stringify({ type: "deployment.ready" })
  const secret = "vercel-secret"
  const sig = vercelSignature(secret, payload)
  assert.deepEqual(
    verifyVercelWebhookSignature({ payload, signatureHeader: sig, secret }),
    { ok: true }
  )
  assert.equal(
    verifyVercelWebhookSignature({
      payload: payload + "!",
      signatureHeader: sig,
      secret,
    }).ok,
    false
  )
})

test("vercel webhook parser extracts preview URL and taskId metadata", () => {
  const parsed = parseVercelWebhookEvent({
    type: "deployment.succeeded",
    payload: {
      project: { id: "prj_123" },
      deployment: {
        url: "chloei-preview-9701.vercel.app",
        target: "preview",
        meta: { chloei_task_id: "task-abc" },
      },
    },
  })
  assert.equal(parsed.type, "deployment_ready")
  assert.equal(parsed.url, "https://chloei-preview-9701.vercel.app")
  assert.equal(parsed.target, "preview")
  assert.equal(parsed.projectId, "prj_123")
  assert.equal(parsed.taskId, "task-abc")
})

test("vercel webhook parser ignores unrelated event types", () => {
  const parsed = parseVercelWebhookEvent({
    type: "project.created",
    payload: {},
  })
  assert.equal(parsed.type, "ignored")
})

test("vercel webhook parser ignores deployments missing url or project id", () => {
  const parsed = parseVercelWebhookEvent({
    type: "deployment.ready",
    payload: { deployment: {} },
  })
  assert.equal(parsed.type, "ignored")
})
