import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const componentPath = path.join(cwd, "src/components/ui/shiki-code.tsx")

test("shiki code escapes fallback HTML when highlighting fails", async () => {
  const source = await readFile(componentPath, "utf8")

  assert.match(
    source,
    /function escapeHtml\(text: string\): string \{[\s\S]*replaceAll\("&", "&amp;"\)[\s\S]*replaceAll\("<", "&lt;"\)[\s\S]*replaceAll\(">", "&gt;"\)/,
    "Expected the code block fallback to escape HTML-sensitive characters."
  )

  assert.match(
    source,
    /setHighlightedCode\(`<pre><code>\$\{escapeHtml\(children\)\}<\/code><\/pre>`\)/,
    "Expected the fallback code block markup to use escaped code content."
  )
})
