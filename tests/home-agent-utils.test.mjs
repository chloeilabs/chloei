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

const { appendUserMessage, toRequestMessages } = await import(homeAgentUtilsUrl)
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

test("appended user messages record the selected model", () => {
  const messages = appendUserMessage(
    [],
    "Research Apple supply chain risk.",
    "gpt-5.4-mini"
  )

  assert.equal(messages[0]?.metadata?.selectedModel, "gpt-5.4-mini")
})

const sampleImageAttachment = {
  id: "att-1",
  kind: "image",
  name: "chart.png",
  mediaType: "image/png",
  url: "data:image/png;base64,AAAA",
}

test("appended user messages carry attachments in metadata", () => {
  const messages = appendUserMessage(
    [],
    "Describe this",
    "gpt-5.5-2026-04-23",
    [sampleImageAttachment]
  )

  assert.deepEqual(messages[0]?.metadata?.attachments, [sampleImageAttachment])
})

test("attachment-only user messages (empty content) are still appended", () => {
  const messages = appendUserMessage([], "", "gpt-5.5-2026-04-23", [
    sampleImageAttachment,
  ])

  assert.equal(messages.length, 1)
  assert.equal(messages[0]?.content, "")
  assert.equal(messages[0]?.metadata?.attachments?.length, 1)
})

test("request messages include attachments and keep attachment-only turns", () => {
  const [request] = toRequestMessages([
    {
      id: "m-att",
      role: "user",
      content: "",
      createdAt: "2026-04-26T00:00:00.000Z",
      metadata: { attachments: [sampleImageAttachment] },
    },
  ])

  assert.equal(request.content, "")
  assert.equal(request.attachments?.length, 1)
  assert.equal(request.attachments?.[0]?.url, sampleImageAttachment.url)
})

test("request messages drop attachments that are missing a data url", () => {
  const requestMessages = toRequestMessages([
    {
      id: "m-nourl",
      role: "user",
      content: "Look here",
      createdAt: "2026-04-26T00:00:00.000Z",
      metadata: {
        attachments: [{ ...sampleImageAttachment, url: undefined }],
      },
    },
  ])

  assert.equal(requestMessages.length, 1)
  assert.equal(requestMessages[0].content, "Look here")
  assert.equal(requestMessages[0].attachments, undefined)
})
