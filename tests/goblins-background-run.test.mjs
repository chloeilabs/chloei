import assert from "node:assert/strict"
import path from "node:path"
import { beforeEach, test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  setTestModuleStubs,
  toProjectFileUrl,
} from "./register-ts-path-hooks.mjs"
import { resetTestMocks, setTestMocks } from "./stubs/mock-state.mjs"

const cwd = fileURLToPath(new URL("..", import.meta.url))

setTestModuleStubs({
  "@openai/agents": toProjectFileUrl("tests/stubs/openai-agents.mjs"),
  "./openai-agents-exa-tools": toProjectFileUrl(
    "tests/stubs/openai-agents-exa-tools.mjs"
  ),
  "@/lib/logger": toProjectFileUrl("tests/stubs/logger.mjs"),
  "@/lib/server/agent-runtime-config": toProjectFileUrl(
    "tests/stubs/agent-runtime-config.mjs"
  ),
  "@/lib/server/env": toProjectFileUrl("tests/stubs/env.mjs"),
  "@/lib/server/goblins-run-store": toProjectFileUrl(
    "tests/stubs/goblins-run-store.mjs"
  ),
  "@/lib/server/threads": toProjectFileUrl("tests/stubs/threads.mjs"),
  "./openai-raw-client": toProjectFileUrl("tests/stubs/openai-raw-client.mjs"),
})

const { continueGoblinsRun } = await import(
  pathToFileURL(path.join(cwd, "src/lib/server/llm/goblins-background-run.ts"))
    .href
)

const makeRun = (overrides = {}) => ({
  id: "run-1",
  userId: "user-1",
  threadId: "thread-1",
  assistantMessageId: "assistant-1",
  status: "executing_tools",
  phase: { turn: 1 },
  openaiResponseId: "resp-1",
  previousResponseId: null,
  systemInstruction: "SYS",
  input: [{ role: "user", content: "Research the topic." }],
  toolResults: {},
  events: [],
  eventCount: 0,
  error: null,
  createdAt: "2026-07-03T00:00:00.000Z",
  updatedAt: "2026-07-03T00:00:00.000Z",
  expiresAt: "2026-07-03T03:00:00.000Z",
  ...overrides,
})

const goblinCallItem = (callId, input) => ({
  type: "function_call",
  call_id: callId,
  name: "goblin_web_researcher",
  arguments: JSON.stringify({ input, knownFindings: null }),
})

const textDeltaEvent = (delta) => ({
  type: "raw_model_stream_event",
  data: { type: "output_text_delta", delta },
})

beforeEach(() => {
  resetTestMocks()
})

test("a tool turn executes goblins and dispatches the next chained turn", async () => {
  const recordedBriefs = []
  const advances = []
  const created = []
  let claimed = 0

  setTestMocks({
    goblinsRunStore: {
      claim: (runId) => {
        claimed += 1
        return runId === "run-1" ? makeRun() : null
      },
      recordToolResult: (runId, callId, brief) => {
        recordedBriefs.push([callId, brief])
      },
      advance: (params) => {
        advances.push(params)
      },
    },
    rawResponses: {
      retrieve: (responseId) => {
        assert.equal(responseId, "resp-1")
        return {
          id: "resp-1",
          status: "completed",
          output: [
            {
              type: "reasoning",
              summary: [{ type: "summary_text", text: "Plan the research." }],
            },
            goblinCallItem("c1", "find sources"),
          ],
        }
      },
      create: (params) => {
        created.push(params)
        // createBackgroundResponse(stream:true) iterates the returned stream
        // until it sees a response id.
        return {
          controller: { abort() {} },
          async *[Symbol.asyncIterator]() {
            yield { response: { id: "resp-2", status: "queued" } }
          },
        }
      },
    },
    agents: {
      // The goblin's own SDK run streams its brief text.
      run: () => ({
        async *[Symbol.asyncIterator]() {
          yield textDeltaEvent("Goblin brief with findings.")
        },
        completed: Promise.resolve(),
        history: [],
        state: {
          usage: {
            requests: 1,
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            inputTokensDetails: [],
          },
        },
      }),
    },
  })

  await continueGoblinsRun("run-1", "resp-1")

  assert.equal(claimed, 1)
  assert.deepEqual(recordedBriefs, [["c1", "Goblin brief with findings."]])

  // Next manager turn chained onto resp-1 with the goblin's output.
  assert.equal(created.length, 1)
  const turn = created[0]
  assert.equal(turn.previous_response_id, "resp-1")
  assert.equal(turn.background, true)
  assert.equal(turn.store, true)
  assert.deepEqual(turn.input, [
    {
      type: "function_call_output",
      call_id: "c1",
      output: "Goblin brief with findings.",
    },
  ])
  assert.ok(Array.isArray(turn.tools) && turn.tools.length === 7)

  assert.deepEqual(advances, [
    {
      runId: "run-1",
      openaiResponseId: "resp-2",
      previousResponseId: "resp-1",
      turn: 2,
    },
  ])
})

test("a re-drive skips tool calls that already have recorded briefs", async () => {
  let goblinRuns = 0
  const recordedBriefs = []

  setTestMocks({
    goblinsRunStore: {
      claim: () =>
        makeRun({
          toolResults: { c1: "Existing brief from a prior segment." },
        }),
      recordToolResult: (runId, callId, brief) => {
        recordedBriefs.push([callId, brief])
      },
      advance: () => {},
    },
    rawResponses: {
      retrieve: () => ({
        id: "resp-1",
        status: "completed",
        output: [goblinCallItem("c1", "find sources")],
      }),
      create: () => ({
        controller: { abort() {} },
        async *[Symbol.asyncIterator]() {
          yield { response: { id: "resp-2", status: "queued" } }
        },
      }),
    },
    agents: {
      run: () => {
        goblinRuns += 1
        throw new Error("goblin should not re-run")
      },
    },
  })

  await continueGoblinsRun("run-1", "resp-1")
  assert.equal(goblinRuns, 0)
  assert.deepEqual(recordedBriefs, [])
})

test("a final turn with text folds the answer into the thread and completes", async () => {
  const upserts = []
  const finishes = []

  setTestMocks({
    goblinsRunStore: {
      claim: () =>
        makeRun({
          phase: { turn: 3 },
          events: [
            {
              type: "subagent_call",
              callId: "c1",
              subagentId: "goblin_web_researcher",
              label: "Web Researcher",
              task: "find sources",
            },
            {
              type: "subagent_result",
              callId: "c1",
              subagentId: "goblin_web_researcher",
              status: "success",
            },
            {
              type: "source",
              source: {
                id: "s1",
                url: "https://example.com",
                title: "Example",
              },
            },
          ],
        }),
      finish: (runId, status) => {
        finishes.push([runId, status])
      },
    },
    rawResponses: {
      retrieve: () => ({
        id: "resp-3",
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Final answer." }],
          },
        ],
      }),
    },
    threads: {
      getThreadForUser: () => null,
      upsertThreadForUser: (userId, thread) => {
        upserts.push([userId, thread])
        return thread
      },
    },
  })

  await continueGoblinsRun("run-1", "resp-3")

  assert.deepEqual(finishes, [["run-1", "completed"]])
  assert.equal(upserts.length, 1)
  const [userId, thread] = upserts[0]
  assert.equal(userId, "user-1")
  assert.equal(thread.id, "thread-1")

  const assistantMessage = thread.messages.at(-1)
  assert.equal(assistantMessage.id, "assistant-1")
  assert.equal(assistantMessage.content, "Final answer.")
  assert.equal(assistantMessage.metadata.agentStatus, "completed")
  assert.deepEqual(assistantMessage.metadata.backgroundRun, {
    runId: "run-1",
    status: "completed",
  })
  assert.equal(assistantMessage.metadata.sources.length, 1)
  const timelineKinds = assistantMessage.metadata.activityTimeline.map(
    (entry) => entry.kind
  )
  assert.ok(timelineKinds.includes("subagent"))
  assert.ok(timelineKinds.includes("sources"))

  // The user's question was materialized into the thread (no client save).
  assert.equal(thread.messages[0].role, "user")
  assert.equal(thread.messages[0].content, "Research the topic.")
})

test("an unclaimable run is a no-op (another invocation owns the segment)", async () => {
  let retrieved = 0
  setTestMocks({
    goblinsRunStore: { claim: () => null },
    rawResponses: {
      retrieve: () => {
        retrieved += 1
        return {}
      },
    },
  })

  await continueGoblinsRun("run-1", "resp-1")
  assert.equal(retrieved, 0)
})
