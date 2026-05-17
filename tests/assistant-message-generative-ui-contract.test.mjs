import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const assistantMessagePath = path.join(
  cwd,
  "src/components/agent/messages/assistant-message.tsx"
)

test("assistant message renders generative UI parts in message order", async () => {
  const source = await readFile(assistantMessagePath, "utf8")

  assert.match(
    source,
    /messageParts\.map\(\(part,\s*index\) => \(/,
    "Expected assistant messages to render metadata.parts in order."
  )
  assert.match(
    source,
    /part\.type === "tool-display_weather"[\s\S]*<WeatherCard output=\{part\.output\}/,
    "Expected weather tool parts to render the weather card."
  )
  assert.match(
    source,
    /<StockCard output=\{part\.output\}/,
    "Expected stock tool parts to render the stock card."
  )
  assert.match(
    source,
    /<TimelineCard output=\{part\.output\}/,
    "Expected timeline tool parts to render the timeline card."
  )
  assert.match(
    source,
    /hidden=\{!hasContent\}/,
    "Expected response copy controls to stay tied to text content only."
  )
})
