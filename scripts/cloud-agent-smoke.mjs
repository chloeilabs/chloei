import { Client } from "pg"
import { createHmac } from "node:crypto"
import { readFileSync } from "node:fs"

const env = {}
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
  if (m) {
    let v = m[2]
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
    env[m[1]] = v
  }
}
const requiredEnvKeys = [
  "DATABASE_URL",
  "GITHUB_APP_WEBHOOK_SECRET",
  "AGENT_CLOUD_AGENT_AUTOMATION_USER_ID",
]
const missing = requiredEnvKeys.filter((key) => !env[key]?.trim())
if (missing.length > 0) {
  console.error(`[smoke] missing required env vars: ${missing.join(", ")}`)
  process.exit(1)
}

const userId = env.AGENT_CLOUD_AGENT_AUTOMATION_USER_ID
const client = new Client({ connectionString: env.DATABASE_URL })
await client.connect()

try {
  // 1. Fire signed GitHub webhook
  const payload = JSON.stringify({
    action: "created",
    issue: { number: 5, pull_request: { url: "x" }, user: { login: "labs" } },
    comment: {
      body: "@chloei fix add CLOUD_AGENT_NOTE.md with single line: hello chloei v5 (full real flow test)",
      user: { login: "labs" },
    },
    repository: { owner: { login: "chloeilabs" }, name: "chloei" },
  })
  const sig =
    "sha256=" +
    createHmac("sha256", env.GITHUB_APP_WEBHOOK_SECRET)
      .update(payload)
      .digest("hex")
  const webhookRes = await fetch("http://localhost:3000/api/webhooks/github", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-GitHub-Event": "issue_comment",
      "X-Hub-Signature-256": sig,
    },
    body: payload,
  })
  const webhookJson = await webhookRes.json()
  console.log("[smoke] webhook accepted:", JSON.stringify(webhookJson))
  const taskId = webhookJson.dispatch?.taskId
  if (!taskId) {
    console.error("[smoke] no taskId — aborting")
    await client.end()
    process.exit(1)
  }

  // 2. Poll until waiting_for_approval (or terminal)
  const startedAt = Date.now()
  let lastSeq = 0
  let approved = false
  async function nextEvents() {
    const r = await client.query(
      `SELECT seq, payload FROM cloud_agent_task_event
     WHERE "userId" = $1 AND "taskId" = $2 AND seq > $3 ORDER BY seq ASC`,
      [userId, taskId, lastSeq]
    )
    for (const row of r.rows) {
      const p = row.payload
      if (p.kind === "status")
        console.log(
          `  [#${row.seq}] status -> ${p.status}${p.phase ? ` (${p.phase})` : ""}`
        )
      else if (p.kind === "tool_call")
        console.log(`  [#${row.seq}] tool ${p.toolName}: ${p.label}`)
      else if (p.kind === "tool_result")
        console.log(
          `  [#${row.seq}] result ${p.status}${p.error ? ` — ${p.error.slice(0, 100)}` : ""}`
        )
      else if (p.kind === "file_change")
        console.log(`  [#${row.seq}] file ${p.change} ${p.path}`)
      else if (p.kind === "diff_update")
        console.log(
          `  [#${row.seq}] diff +${p.additions}/-${p.deletions} (${p.filesChanged} files)`
        )
      else if (p.kind === "approval_required")
        console.log(`  [#${row.seq}] APPROVAL_REQUIRED ${p.action}`)
      else if (p.kind === "preview_ready")
        console.log(`  [#${row.seq}] PREVIEW: ${p.url}`)
      else if (p.kind === "text_delta")
        console.log(`  [#${row.seq}] text: ${p.text.slice(0, 200)}`)
      else if (p.kind === "error")
        console.log(`  [#${row.seq}] ERROR: ${p.message}`)
      lastSeq = Number(row.seq)
    }
  }

  while (Date.now() - startedAt < 12 * 60 * 1000) {
    await nextEvents()
    const tr = await client.query(
      `SELECT status, "prUrl", "previewUrl", summary, error FROM cloud_agent_task WHERE "userId" = $1 AND id = $2`,
      [userId, taskId]
    )
    const task = tr.rows[0]
    if (!task) {
      console.log("[smoke] task vanished")
      break
    }
    if (task.status === "waiting_for_approval" && !approved) {
      console.log("[smoke] approving via dev bypass...")
      const ar = await fetch(
        "http://localhost:3000/api/internal-dev/cloud-agents/approve",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId, taskId, approved: true }),
        }
      )
      console.log("[smoke] approve response:", ar.status, await ar.text())
      approved = true
    }
    if (
      ["completed", "failed", "cancelled", "pr_ready"].includes(task.status)
    ) {
      console.log(`\n[smoke] FINAL: status=${task.status}`)
      if (task.prUrl) console.log(`  PR:        ${task.prUrl}`)
      if (task.previewUrl) console.log(`  preview:   ${task.previewUrl}`)
      if (task.summary) console.log(`  summary:   ${task.summary}`)
      if (task.error) console.log(`  error:     ${task.error}`)
      break
    }
    await new Promise((r) => setTimeout(r, 3000))
  }
} finally {
  await client.end()
}
