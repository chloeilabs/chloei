import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const homeAgentUtilsUrl = pathToFileURL(
  path.join(cwd, "src/components/agent/home/home-agent-utils.ts")
).href
const agentRequestLimitsUrl = pathToFileURL(
  path.join(cwd, "src/lib/shared/agent-request-limits.ts")
).href

const { appendUserMessage, toRequestMessages } = await import(
  homeAgentUtilsUrl
)
const {
  AGENT_REQUEST_MAX_MESSAGE_CHARS,
  AGENT_REQUEST_MAX_MESSAGES,
  AGENT_REQUEST_MAX_TOTAL_CHARS,
} = await import(agentRequestLimitsUrl)

function createMessage(index, content = `message-${index}`) {
  return {
    id: `message-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content,
    createdAt: "2026-04-26T00:00:00.000Z",
  }
}

test("agent request messages are bounded to the server message count limit", () => {
  const messages = Array.from(
    { length: AGENT_REQUEST_MAX_MESSAGES + 10 },
    (_, index) => createMessage(index)
  )

  const requestMessages = toRequestMessages(messages)

  assert.equal(requestMessages.length, AGENT_REQUEST_MAX_MESSAGES)
  assert.equal(
    requestMessages.at(-1)?.content,
    `message-${AGENT_REQUEST_MAX_MESSAGES + 9}`
  )
})

test("agent request messages drop old context to stay within total payload limits", () => {
  const messages = Array.from({ length: 6 }, (_, index) =>
    createMessage(index, "x".repeat(10_000))
  )

  const requestMessages = toRequestMessages(messages)
  const totalChars = requestMessages.reduce(
    (total, message) => total + message.content.length,
    0
  )

  assert.equal(requestMessages.at(-1)?.content, "x".repeat(10_000))
  assert(totalChars <= AGENT_REQUEST_MAX_TOTAL_CHARS)
})

test("agent request messages trim oversized existing message content", () => {
  const requestMessages = toRequestMessages([
    createMessage(0, "x".repeat(AGENT_REQUEST_MAX_MESSAGE_CHARS + 100)),
  ])

  assert.equal(requestMessages.length, 1)
  assert.equal(
    requestMessages[0].content.length,
    AGENT_REQUEST_MAX_MESSAGE_CHARS
  )
  assert.match(requestMessages[0].content, /truncated/)
})

test("appended user messages preserve the requested run mode", () => {
  const messages = appendUserMessage(
    [],
    "Research Apple supply chain risk.",
    "anthropic/claude-sonnet-4.6",
    "research"
  )

  assert.equal(messages[0]?.metadata?.selectedModel, "anthropic/claude-sonnet-4.6")
  assert.equal(messages[0]?.metadata?.runMode, "research")
})

test("attached user messages persist metadata but request transient data separately", () => {
  const attachment = {
    id: "attachment-1",
    kind: "image",
    filename: "chart.png",
    mediaType: "image/png",
    sizeBytes: 5,
    detail: "auto",
    previewDataUrl: "data:image/jpeg;base64,abc=",
    dataUrl: "data:image/png;base64,aGVsbG8=",
  }
  const messages = appendUserMessage(
    [],
    "Analyze this chart.",
    "anthropic/claude-sonnet-4.6",
    "chat",
    [attachment]
  )
  const userMessage = messages[0]

  assert.equal(userMessage?.metadata?.attachments?.[0]?.filename, "chart.png")
  assert.equal(userMessage?.metadata?.attachments?.[0]?.dataUrl, undefined)

  assert.deepEqual(toRequestMessages(messages), [
    {
      role: "user",
      content: "Analyze this chart.",
    },
  ])

  const attachmentsByMessageId = new Map([[userMessage.id, [attachment]]])
  assert.deepEqual(toRequestMessages(messages, { attachmentsByMessageId }), [
    {
      role: "user",
      content: "Analyze this chart.",
      attachments: [attachment],
    },
  ])
})
