import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const moduleUrl = pathToFileURL(
  path.join(cwd, "src/lib/server/llm/agent-runtime-synthesis-gating.ts")
).href

const { shouldForceFinalSynthesisStep, shouldNudgeMidBudgetSynthesis } =
  await import(moduleUrl)

test("shouldForceFinalSynthesisStep fires only on the last step", () => {
  assert.equal(shouldForceFinalSynthesisStep(0, 20), false)
  assert.equal(shouldForceFinalSynthesisStep(18, 20), false)
  assert.equal(shouldForceFinalSynthesisStep(19, 20), true)
  assert.equal(shouldForceFinalSynthesisStep(20, 20), true)
})

test("shouldNudgeMidBudgetSynthesis kicks in around one-third budget", () => {
  // deep_research budget = 20 → threshold = floor(20/3) = 6
  assert.equal(shouldNudgeMidBudgetSynthesis(5, 20), false)
  assert.equal(shouldNudgeMidBudgetSynthesis(6, 20), true)
  assert.equal(shouldNudgeMidBudgetSynthesis(12, 20), true)
  // Don't double-fire on the final-synthesis step (that has its own instruction)
  assert.equal(shouldNudgeMidBudgetSynthesis(19, 20), false)
})

test("shouldNudgeMidBudgetSynthesis fires for chat_default budget too", () => {
  // chat_default budget = 12 → threshold = floor(12/3) = 4
  assert.equal(shouldNudgeMidBudgetSynthesis(3, 12), false)
  assert.equal(shouldNudgeMidBudgetSynthesis(4, 12), true)
  assert.equal(shouldNudgeMidBudgetSynthesis(10, 12), true)
  assert.equal(shouldNudgeMidBudgetSynthesis(11, 12), false)
})

test("shouldNudgeMidBudgetSynthesis is disabled for trivially small budgets", () => {
  assert.equal(shouldNudgeMidBudgetSynthesis(0, 3), false)
  assert.equal(shouldNudgeMidBudgetSynthesis(1, 3), false)
  assert.equal(shouldNudgeMidBudgetSynthesis(2, 3), false)
})
