import assert from "node:assert/strict"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import "./register-ts-path-hooks.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))
const moduleUrl = pathToFileURL(
  path.join(cwd, "src/components/agent/home/agent-stream-state.ts")
).href

const {
  applyAgentStreamEvent,
  createAgentStreamAccumulator,
  finalizeAgentStreamAccumulator,
} = await import(moduleUrl)

test("harness trace timeline preserves info and warning statuses", () => {
  const withInfo = applyAgentStreamEvent(createAgentStreamAccumulator(), {
    type: "harness_trace",
    stage: "plan",
    label: "Plan selected",
    status: "info",
  })
  const withWarning = applyAgentStreamEvent(withInfo, {
    type: "harness_trace",
    stage: "verification",
    label: "Evidence gap",
    status: "warning",
  })

  assert.deepEqual(
    withWarning.activityTimeline.map((entry) => entry.status),
    ["info", "warning"]
  )
})

test("finalizeAgentStreamAccumulator closes running harness traces", () => {
  const accumulator = applyAgentStreamEvent(createAgentStreamAccumulator(), {
    type: "harness_trace",
    stage: "tool_decision",
    label: "Choosing tools",
  })
  const finalized = finalizeAgentStreamAccumulator(accumulator, "success")

  assert.equal(finalized.activityTimeline[0]?.kind, "harness")
  assert.equal(finalized.activityTimeline[0]?.status, "success")
})
