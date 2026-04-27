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
    /handlePromptSubmit\(message,\s*model,\s*queue,\s*runMode,\s*attachments\)/g
  )
  assert.equal(
    forwardedCalls?.length,
    4,
    "Expected every animated prompt branch to forward attachments."
  )
})
