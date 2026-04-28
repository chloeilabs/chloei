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

test("prompt form gates submit while attachment files are still reading", async () => {
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
    /isFormPending \|\|\s+isReadingAttachments\s+\) \{\s+return/,
    "Expected submit handling to return while attachment reads are in flight."
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
