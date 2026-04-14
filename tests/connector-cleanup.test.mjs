import assert from "node:assert/strict"
import test from "node:test"

import {
  classifyThreadCleanupAction,
  CONNECTOR_TOOL_NAMES,
} from "../scripts/remove-connectors.mjs"

test("cleanup classifier deletes threads with structured connector tool activity", () => {
  const decision = classifyThreadCleanupAction({
    id: "thread-1",
    agentConfig: {},
    messages: [
      {
        id: "assistant-1",
        llmModel: "openrouter",
        metadata: {
          toolInvocations: [
            {
              toolName: CONNECTOR_TOOL_NAMES[0],
            },
          ],
        },
      },
    ],
  })

  assert.equal(decision.action, "delete")
  assert.ok(decision.reasons.includes("connector_tool_activity"))
})

test("cleanup classifier rewrites config-only threads", () => {
  const decision = classifyThreadCleanupAction({
    id: "thread-2",
    agentConfig: {
      selectedToolkits: ["github"],
    },
    messages: [
      {
        id: "assistant-1",
        llmModel: "openrouter",
        metadata: {},
      },
    ],
  })

  assert.deepEqual(decision, {
    action: "rewrite",
    reasons: ["legacy_connector_config"],
  })
})

test("cleanup classifier deletes generated legacy trigger threads", () => {
  const legacyTriggerThreadId = ["comp", "osio-trigger-", "example"].join("")

  const decision = classifyThreadCleanupAction({
    id: legacyTriggerThreadId,
    agentConfig: {
      selectedToolkits: ["github"],
    },
    messages: [],
  })

  assert.equal(decision.action, "delete")
  assert.ok(decision.reasons.includes("legacy_trigger_thread"))
})

test("cleanup classifier preserves clean threads", () => {
  const decision = classifyThreadCleanupAction({
    id: "thread-3",
    agentConfig: {},
    messages: [
      {
        id: "assistant-1",
        llmModel: "openrouter",
        metadata: {
          toolInvocations: [
            {
              toolName: "web_search",
            },
          ],
        },
      },
    ],
  })

  assert.deepEqual(decision, {
    action: "ignore",
    reasons: [],
  })
})
