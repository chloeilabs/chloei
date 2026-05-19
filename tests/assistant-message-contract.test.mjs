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
const messagesPath = path.join(
  cwd,
  "src/components/agent/messages/messages.tsx"
)

test("assistant actions appear only after streaming above follow-ups", async () => {
  const source = await readFile(assistantMessagePath, "utf8")

  assert.match(
    source,
    /<ArtifactDownloadList artifacts=\{downloadableArtifacts\} \/>[\s\S]*\{!isAssistantStreaming \? \([\s\S]*Copy response[\s\S]*Regenerate response[\s\S]*\) : null\}[\s\S]*isFollowUpQuestionsPending \? \([\s\S]*<FollowUpQuestionsPending \/>[\s\S]*<FollowUpQuestions/,
    "Expected response actions and pending follow-ups to be shown only after streaming and before resolved follow-up questions."
  )
  assert.match(
    source,
    /const isFollowUpQuestionsPending =[\s\S]*message\.metadata\?\.followUpQuestionsPending === true[\s\S]*followUpQuestions\.length === 0/,
    "Expected pending follow-ups to render immediately while generated questions are still unavailable."
  )
  assert.doesNotMatch(
    source,
    /group-hover\/assistant-message:opacity-100[\s\S]*Copy response/,
    "Expected Copy response to stay visible after streaming instead of appearing only on hover."
  )
})

test("assistant regenerate action reuses the prior user message", async () => {
  const source = await readFile(messagesPath, "utf8")

  assert.match(
    source,
    /const userMessage =[\s\S]*firstMessage && isUserMessage\(firstMessage\) \? firstMessage : null/,
    "Expected message groups to identify the user message that owns assistant responses."
  )
  assert.match(
    source,
    /const handleRegenerate =[\s\S]*onEditMessage\?\.\(\{[\s\S]*messageId: userMessage\.id,[\s\S]*newContent: userMessage\.content,[\s\S]*newModel: regenerateModel,[\s\S]*newRunMode: regenerateRunMode,[\s\S]*\}\)[\s\S]*onRegenerate=\{handleRegenerate\}/,
    "Expected regenerate to rerun the previous user prompt through the existing edit-regenerate path."
  )
})
