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

test("prompt form drops the tools popover and legacy run-mode controls", async () => {
  const source = await readFile(promptFormPath, "utf8")

  // The legacy Tools popover / persisted run-mode plumbing stays banned. The
  // flag-gated "Deep research" background toggle (goblins model only) is the
  // one intentional research control.
  assert.doesNotMatch(
    source,
    /runMode|usePersistentRunMode|Popover|setIsToolsOpen/,
    "Expected PromptForm to drop the Tools popover and run-mode controls."
  )
  assert.doesNotMatch(
    source,
    /<ModelSelector/,
    "Expected PromptForm to no longer render a model selector (GPT-5.4 Mini only)."
  )
})
