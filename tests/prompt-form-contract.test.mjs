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

test("prompt form queues submit while attachment files are still reading", async () => {
  const source = await readFile(promptFormPath, "utf8")

  assert.match(
    source,
    /const \[isReadingAttachments, setIsReadingAttachments\] = useState\(false\)/,
    "Expected PromptForm to track in-flight attachment reads."
  )
  assert.match(
    source,
    /isFormPending \|\|\s+isReadingAttachments \|\|\s+!resolvedSelectedModel/,
    "Expected submit disabled state to include attachment reads."
  )
  assert.match(
    source,
    /const submitAfterAttachmentsRef = useRef\(false\)/,
    "Expected PromptForm to track submit intent during attachment reads."
  )
  assert.match(
    source,
    /if \(isReadingAttachmentsRef\.current\) \{\s+submitAfterAttachmentsRef\.current = true\s+return\s+\}/,
    "Expected submit handling to queue submits while attachment reads are in flight."
  )
})

test("prompt form always handles browser drag/drop defaults", async () => {
  const source = await readFile(promptFormPath, "utf8")

  assert.match(
    source,
    /onDragOver=\{\(event\) => \{\s+event\.preventDefault\(\)\s+if \(isFormPending \|\| isReadingAttachments\)/,
    "Expected drag over to prevent browser navigation before pending checks."
  )
  assert.match(
    source,
    /onDrop=\{\(event\) => \{\s+event\.preventDefault\(\)\s+setIsDragActive\(false\)\s+if \(isFormPending \|\| isReadingAttachments\)/,
    "Expected drop to reset drag state before pending checks."
  )
})

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
