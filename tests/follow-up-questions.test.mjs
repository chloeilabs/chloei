import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const moduleUrl = pathToFileURL(
  path.join(cwd, "src/components/agent/home/follow-up-questions.ts")
).href
const modelsUrl = pathToFileURL(
  path.join(cwd, "src/lib/shared/llm/models.ts")
).href
const constantsUrl = pathToFileURL(path.join(cwd, "src/lib/constants.ts")).href

const {
  getFollowUpQuestionRequestTargets,
  hasGeneratedFollowUpQuestions,
  hasOnlyLegacyCannedFollowUpQuestions,
  parseFollowUpQuestionsResponse,
  shouldRequestFollowUpQuestions,
  shouldStartParallelFollowUpQuestions,
} = await import(moduleUrl)
const { AvailableModels } = await import(modelsUrl)
const { ASSISTANT_EMPTY_RESPONSE_FALLBACK } = await import(constantsUrl)

const MODEL = AvailableModels.OPENAI_GPT_5_4_MINI

function assistantMessage(overrides = {}) {
  const { metadata = {}, ...rest } = overrides
  return {
    id: "assistant-1",
    role: "assistant",
    content: "Here is a thorough and complete answer to the question.",
    llmModel: MODEL,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...rest,
    metadata: {
      isStreaming: false,
      agentStatus: "completed",
      selectedModel: MODEL,
      ...metadata,
    },
  }
}

test("parseFollowUpQuestionsResponse trims and caps to three questions", () => {
  const result = parseFollowUpQuestionsResponse({
    followUpQuestions: [
      { id: " q1 ", text: "  First?  " },
      { id: "q2", text: "Second?" },
      { id: "q3", text: "Third?" },
      { id: "q4", text: "Fourth?" },
    ],
  })

  assert.deepEqual(result, [
    { id: "q1", text: "First?" },
    { id: "q2", text: "Second?" },
    { id: "q3", text: "Third?" },
  ])
})

test("parseFollowUpQuestionsResponse drops malformed entries", () => {
  const result = parseFollowUpQuestionsResponse({
    followUpQuestions: [
      { id: "ok", text: "Keep me" },
      { id: "", text: "blank id" },
      { id: "blank-text", text: "   " },
      { text: "missing id" },
      "not-an-object",
      null,
    ],
  })

  assert.deepEqual(result, [{ id: "ok", text: "Keep me" }])
})

test("parseFollowUpQuestionsResponse returns [] for non-conforming payloads", () => {
  assert.deepEqual(parseFollowUpQuestionsResponse(null), [])
  assert.deepEqual(parseFollowUpQuestionsResponse("nope"), [])
  assert.deepEqual(parseFollowUpQuestionsResponse([]), [])
  assert.deepEqual(parseFollowUpQuestionsResponse({}), [])
  assert.deepEqual(
    parseFollowUpQuestionsResponse({ followUpQuestions: "no" }),
    []
  )
})

test("shouldRequestFollowUpQuestions requires completed, real content", () => {
  assert.equal(
    shouldRequestFollowUpQuestions({
      content: "Answer.",
      agentStatus: "completed",
    }),
    true
  )
  assert.equal(
    shouldRequestFollowUpQuestions({
      content: "   ",
      agentStatus: "completed",
    }),
    false
  )
  assert.equal(
    shouldRequestFollowUpQuestions({
      content: "Answer.",
      agentStatus: "in_progress",
    }),
    false
  )
  assert.equal(
    shouldRequestFollowUpQuestions({
      content: ASSISTANT_EMPTY_RESPONSE_FALLBACK,
      agentStatus: "completed",
    }),
    false
  )
})

test("shouldStartParallelFollowUpQuestions only triggers for long real content", () => {
  assert.equal(
    shouldStartParallelFollowUpQuestions({ content: "x".repeat(80) }),
    true
  )
  assert.equal(
    shouldStartParallelFollowUpQuestions({ content: "x".repeat(79) }),
    false
  )
  // The empty-response fallback is shorter than the threshold, so it never
  // starts a parallel request.
  assert.equal(
    shouldStartParallelFollowUpQuestions({
      content: ASSISTANT_EMPTY_RESPONSE_FALLBACK,
    }),
    false
  )
})

test("legacy vs generated follow-up detection", () => {
  const legacy = [{ id: "fallback-follow-up-1", text: "a" }]
  const generated = [{ id: "gen-1", text: "b" }]
  const mixed = [...legacy, ...generated]

  assert.equal(hasOnlyLegacyCannedFollowUpQuestions(legacy), true)
  assert.equal(hasOnlyLegacyCannedFollowUpQuestions(mixed), false)
  assert.equal(hasOnlyLegacyCannedFollowUpQuestions(generated), false)
  assert.equal(hasOnlyLegacyCannedFollowUpQuestions([]), false)
  assert.equal(hasOnlyLegacyCannedFollowUpQuestions(undefined), false)

  assert.equal(hasGeneratedFollowUpQuestions(generated), true)
  assert.equal(hasGeneratedFollowUpQuestions(mixed), true)
  assert.equal(hasGeneratedFollowUpQuestions(legacy), false)
  assert.equal(hasGeneratedFollowUpQuestions([]), false)
  assert.equal(hasGeneratedFollowUpQuestions(undefined), false)
})

test("getFollowUpQuestionRequestTargets selects an eligible assistant turn", () => {
  const messages = [
    { id: "u1", role: "user", content: "Question?", createdAt: "t" },
    assistantMessage({ id: "a1" }),
  ]

  const targets = getFollowUpQuestionRequestTargets(messages, new Set())

  assert.equal(targets.length, 1)
  assert.equal(targets[0].assistantMessageId, "a1")
  assert.equal(targets[0].model, MODEL)
  assert.deepEqual(
    targets[0].messages.map((message) => message.id),
    ["u1", "a1"]
  )
})

test("getFollowUpQuestionRequestTargets falls back to the selected model", () => {
  const targets = getFollowUpQuestionRequestTargets(
    [assistantMessage({ id: "a1", llmModel: undefined })],
    new Set()
  )

  assert.equal(targets.length, 1)
  assert.equal(targets[0].model, MODEL)
})

test("getFollowUpQuestionRequestTargets skips every ineligible message", () => {
  const requested = new Set(["already"])
  const messages = [
    { id: "u1", role: "user", content: "hi", createdAt: "t" },
    assistantMessage({ id: "streaming", metadata: { isStreaming: true } }),
    assistantMessage({
      id: "incomplete",
      metadata: { agentStatus: "in_progress" },
    }),
    assistantMessage({ id: "empty", content: "   " }),
    assistantMessage({
      id: "fallback",
      content: ASSISTANT_EMPTY_RESPONSE_FALLBACK,
    }),
    assistantMessage({ id: "already" }),
    assistantMessage({
      id: "hasGenerated",
      metadata: { followUpQuestions: [{ id: "gen", text: "x" }] },
    }),
    assistantMessage({
      id: "badModel",
      llmModel: "not-a-model",
      metadata: { selectedModel: "not-a-model" },
    }),
  ]

  const targets = getFollowUpQuestionRequestTargets(messages, requested)

  assert.deepEqual(
    targets.map((target) => target.assistantMessageId),
    []
  )
})
