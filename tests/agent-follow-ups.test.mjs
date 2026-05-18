import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const moduleUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/agent-follow-ups.ts")
).href

const {
  createFollowUpQuestions,
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
