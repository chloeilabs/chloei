import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const promptFormPath = path.join(
  cwd,
  "src/components/agent/prompt-form/prompt-form.tsx"
)

test("prompt form drops the tools popover and research mode controls", async () => {
  const source = await readFile(promptFormPath, "utf8")

  assert.doesNotMatch(
    source,
    /runMode|usePersistentRunMode|Research|Telescope|Popover|setIsToolsOpen/,
    "Expected PromptForm to drop the Tools popover and Research mode controls."
  )
  assert.doesNotMatch(
    source,
    /<ModelSelector/,
    "Expected PromptForm to no longer render a model selector (GPT-5.4 Mini only)."
  )
})
