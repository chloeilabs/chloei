import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  setTestModuleStubs,
  toProjectFileUrl,
} from "./register-ts-path-hooks.mjs"
import { resetTestMocks, setTestMocks } from "./stubs/mock-state.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const moduleUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/agent-follow-ups.ts")
).href

setTestModuleStubs({
  openai: toProjectFileUrl("tests/stubs/openai.mjs"),
})

const {
  createFollowUpQuestions,
  generateFollowUpQuestions,
  normalizeGeneratedFollowUpQuestionTexts,
  validateFollowUpMessages,
} = await import(moduleUrl)

test("follow-up helpers normalize generated questions for chip display", () => {
  const normalized = normalizeGeneratedFollowUpQuestionTexts({
    questions: [
      "  1. What evidence supports this?  ",
      "Can you give an example?",
      "What should I do next?",
      "What should I do next?",
    ],
  })

  assert.deepEqual(normalized, [
    "What evidence supports this?",
    "Can you give an example?",
    "What should I do next?",
  ])

  assert.deepEqual(
    createFollowUpQuestions(normalized, () => "follow-up-id"),
    [
      { id: "follow-up-id", text: "What evidence supports this?" },
      { id: "follow-up-id", text: "Can you give an example?" },
      { id: "follow-up-id", text: "What should I do next?" },
    ]
  )

  assert.deepEqual(
    normalizeGeneratedFollowUpQuestionTexts({
      follow_up_questions: [
        "How did Augustus consolidate power?",
        "What caused the Western Empire to fall?",
        "How did Byzantine institutions preserve Roman law?",
      ],
    }),
    [
      "How did Augustus consolidate power?",
      "What caused the Western Empire to fall?",
      "How did Byzantine institutions preserve Roman law?",
    ]
  )
})

test("follow-up helpers reject malformed generated question payloads", () => {
  assert.deepEqual(
    normalizeGeneratedFollowUpQuestionTexts({
      questions: ["One?", "Two?", "Three?", "Four?", "Five?"],
    }),
    []
  )
  assert.deepEqual(normalizeGeneratedFollowUpQuestionTexts({}), [])
  assert.deepEqual(normalizeGeneratedFollowUpQuestionTexts(null), [])
})

test("follow-up context validation requires the latest assistant response", () => {
  assert.equal(
    validateFollowUpMessages([
      { role: "user", content: "Question" },
      { role: "assistant", content: "Answer" },
    ]),
    true
  )
  assert.equal(
    validateFollowUpMessages([
      { role: "assistant", content: "Answer" },
      { role: "user", content: "Another question" },
    ]),
    false
  )
})

test("follow-up generation uses the OpenAI Responses API for structured questions", async () => {
  resetTestMocks()

  let recordedParams = null
  setTestMocks({
    openai: {
      async responsesCreate(params) {
        recordedParams = params
        return {
          output_text: JSON.stringify({
            questions: [
              "How does the repair-after-conflict point work in practice?",
              "What tradeoff matters most for commitment over time?",
              "How would care over time change the recommendation?",
            ],
          }),
        }
      },
    },
  })

  const followUps = await generateFollowUpQuestions({
    openAiApiKey: "test-openai-key",
    messages: [
      { role: "user", content: "Explain love" },
      {
        role: "assistant",
        content:
          "Love includes intimacy, commitment, repair after conflict, and care over time.",
      },
    ],
    model: "gpt-5.4-mini",
    userId: "user-1",
  })

  assert.equal(recordedParams?.model, "gpt-5.4-mini")
  assert.equal(recordedParams?.text?.format?.type, "json_schema")
  assert.equal(recordedParams?.text?.format?.name, "follow_up_questions")
  assert.equal(followUps.length, 3)
})
