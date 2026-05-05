import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const runtimeUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/llm/agent-runtime-step-messages.ts")
).href

const { getCompatibleStepMessages, stripReasoningFromStepMessages } =
  await import(runtimeUrl)

test("stripReasoningFromStepMessages removes only assistant reasoning parts", () => {
  const userMessage = {
    role: "user",
    content: "Look up the current stock price.",
  }
  const assistantMessage = {
    role: "assistant",
    content: [
      {
        type: "reasoning",
        text: "I should call the finance tool.",
      },
      {
        type: "text",
        text: "I will check that.",
      },
      {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "finance_data",
        input: { operation: "quote", symbol: "AAPL" },
      },
    ],
  }
  const toolMessage = {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "finance_data",
        output: { type: "json", value: { price: 123 } },
      },
    ],
  }

  const stripped = stripReasoningFromStepMessages([
    userMessage,
    assistantMessage,
    toolMessage,
  ])

  assert.deepEqual(stripped, [
    userMessage,
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "I will check that.",
        },
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "finance_data",
          input: { operation: "quote", symbol: "AAPL" },
        },
      ],
    },
    toolMessage,
  ])
})

test("stripReasoningFromStepMessages drops reasoning-only assistant messages", () => {
  assert.deepEqual(
    stripReasoningFromStepMessages([
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "Internal reasoning only.",
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "finance_data",
            output: { type: "json", value: { ok: true } },
          },
        ],
      },
    ]),
    [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "finance_data",
            output: { type: "json", value: { ok: true } },
          },
        ],
      },
    ]
  )
})

test("getCompatibleStepMessages only overrides Grok prompts when reasoning is present", () => {
  const cleanMessages = [
    {
      role: "user",
      content: "Hello.",
    },
  ]
  const reasoningMessages = [
    {
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "Thinking.",
        },
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "finance_data",
          input: {},
        },
      ],
    },
  ]

  assert.equal(
    getCompatibleStepMessages("anthropic/claude-sonnet-4.6", reasoningMessages),
    undefined
  )
  assert.equal(
    getCompatibleStepMessages("xai/grok-4.3", cleanMessages),
    undefined
  )
  assert.deepEqual(
    getCompatibleStepMessages("xai/grok-4.3", reasoningMessages),
    [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "finance_data",
            input: {},
          },
        ],
      },
    ]
  )
})
