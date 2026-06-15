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

test("prompt form research shortcut does not close the tools popover", async () => {
  const source = await readFile(promptFormPath, "utf8")
  const shortcutSource = source.match(
    /const handleResearchShortcut = \(event: KeyboardEvent\) => \{[\s\S]*?window\.addEventListener\("keydown", handleResearchShortcut\)/
  )?.[0]

  assert.ok(
    shortcutSource,
    "Expected PromptForm to define a research shortcut."
  )
  assert.match(
    shortcutSource,
    /setRunMode\(\(currentRunMode\) =>\s+currentRunMode === "research" \? "chat" : "research"\s+\)/,
    "Expected shortcut to toggle run mode directly."
  )
  assert.doesNotMatch(
    shortcutSource,
    /handleSetRunMode|setIsToolsOpen|shouldPreventToolsCloseAutoFocusRef/,
    "Expected shortcut not to reuse popover-closing menu behavior."
  )
})

test("prompt form preserves Research mode after submit", async () => {
  const source = await readFile(promptFormPath, "utf8")
  const submitSource = source.match(
    /const submitPrompt = useCallback\([\s\S]*?const handleSubmit = useCallback/
  )?.[0]

  assert.ok(submitSource, "Expected PromptForm to define submitPrompt.")
  assert.match(
    source,
    /usePersistentRunMode\(\)/,
    "Expected PromptForm to persist run mode across remounts."
  )
  assert.doesNotMatch(
    source,
    /useState<AgentRunMode>\("chat"\)/,
    "Expected PromptForm not to reset run mode to chat on remount."
  )
  assert.match(
    submitSource,
    /const activeRunMode = runMode[\s\S]*onSubmit\?\.\([\s\S]*activeRunMode/,
    "Expected submitPrompt to submit the active run mode."
  )
  assert.doesNotMatch(
    submitSource,
    /setRunMode\("chat"\)/,
    "Expected submitPrompt not to reset Research mode back to chat."
  )
})
