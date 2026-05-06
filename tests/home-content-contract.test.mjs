import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const homeContentPath = path.join(
  cwd,
  "src/components/agent/home/home-content.tsx"
)

test("home animated prompt forwards attachments from the initial prompt", async () => {
  const source = await readFile(homeContentPath, "utf8")

  assert.match(
    source,
    /attachments:\s*AgentRequestAttachment\[\]\s*=\s*\[\]/,
    "Expected the animated initial prompt submit handler to accept attachments."
  )

  const forwardedCalls = source.match(
    /handlePromptSubmit\(message,\s*model,\s*_isStreaming,\s*runMode,\s*attachments\)/g
  )
  assert.equal(
    forwardedCalls?.length,
    3,
    "Expected every animated prompt branch to forward attachments."
  )
})

test("prompt submissions queue while the submit lock is still active", async () => {
  const source = await readFile(
    path.join(cwd, "src/components/agent/home/use-agent-session.ts"),
    "utf8"
  )

  assert.match(
    source,
    /if \(submitLockRef\.current\) \{[\s\S]*setQueuedSubmission\(\{[\s\S]*message: trimmedMessage,[\s\S]*return[\s\S]*\}/,
    "Expected follow-up submissions during the stream cleanup window to be queued."
  )
  assert.doesNotMatch(
    source,
    /if \(queue && submitLockRef\.current\)/,
    "Expected queueing to depend on the actual submit lock, not only the PromptForm streaming prop."
  )
})
