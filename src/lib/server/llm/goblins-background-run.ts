import type OpenAI from "openai"
import { z } from "zod"

import { createLogger } from "@/lib/logger"
import {
  GOBLINS_BUDGET_TIERS,
  GOBLINS_SEGMENT_BUDGET_MS,
} from "@/lib/server/agent-runtime-config"
import { getExaApiKey, getOpenAiApiKey } from "@/lib/server/env"
import {
  advanceGoblinsRunToNextTurn,
  appendGoblinsRunEvents,
  claimGoblinsRun,
  createGoblinsRun,
  finishGoblinsRun,
  type GoblinsRun,
  type GoblinsRunInputMessage,
  type GoblinsRunPendingToolCall,
  recordGoblinsRunToolResult,
  updateGoblinsRunPhase,
} from "@/lib/server/goblins-run-store"
import { resolveAgentFeatureFlags } from "@/lib/server/integration-flags"
import { getThreadForUser, upsertThreadForUser } from "@/lib/server/threads"
import {
  type ActivityTimelineEntry,
  type AgentStreamEvent,
  GOBLINS_MANAGER_MODEL,
  type Message,
  type MessageSource,
  sanitizeReasoningForDisplay,
  type Thread,
} from "@/lib/shared"

import {
  FINAL_SYNTHESIS_STEP_INSTRUCTION,
  FINAL_SYNTHESIS_USER_PROMPT,
} from "./agent-runtime"
import { createBackgroundResponse } from "./background-responses"
import {
  GOBLIN_DEFINITIONS,
  type GoblinDefinition,
  runGoblinTask,
} from "./goblins-agents"
import {
  buildGoblinsBackgroundManagerInstruction,
  COVERAGE_CHECK_TOOL_DESCRIPTION,
  COVERAGE_CHECK_TOOL_NAME,
  executeCoverageCheck,
} from "./goblins-runtime"
import {
  createSharedResearchState,
  type SharedResearchState,
} from "./openai-agents-exa-tools"
import { getOpenAiClient } from "./openai-raw-client"

const logger = createLogger("goblins-background-run")

const BACKGROUND_TIER = GOBLINS_BUDGET_TIERS.deep

// Raw Responses-API JSON schemas for the manager's local function tools. The
// goblin schema mirrors goblinAdaptiveInputSchema; keep them in sync.
const GOBLIN_TOOL_PARAMETERS_SCHEMA = {
  type: "object",
  properties: {
    input: {
      type: "string",
      description: "The focused, self-contained research task for this goblin.",
    },
    knownFindings: {
      type: ["string", "null"],
      description:
        "What earlier rounds already established (key facts + URLs already covered), so this goblin does not repeat work. Provide on second and later rounds.",
    },
  },
  required: ["input", "knownFindings"],
  additionalProperties: false,
} as const

const COVERAGE_CHECK_PARAMETERS_SCHEMA = {
  type: "object",
  properties: {
    question: { type: "string", description: "The user's question, verbatim." },
    findingsSummary: {
      type: "string",
      description: "Bullet summary of the findings gathered so far.",
    },
  },
  required: ["question", "findingsSummary"],
  additionalProperties: false,
} as const

function buildManagerToolDefinitions(): OpenAI.Responses.Tool[] {
  return [
    ...GOBLIN_DEFINITIONS.map((definition): OpenAI.Responses.Tool => ({
      type: "function",
      name: definition.subagentId,
      description: definition.toolDescription,
      parameters: GOBLIN_TOOL_PARAMETERS_SCHEMA as unknown as Record<
        string,
        unknown
      >,
      strict: true,
    })),
    {
      type: "function",
      name: COVERAGE_CHECK_TOOL_NAME,
      description: COVERAGE_CHECK_TOOL_DESCRIPTION,
      parameters: COVERAGE_CHECK_PARAMETERS_SCHEMA as unknown as Record<
        string,
        unknown
      >,
      strict: true,
    },
  ]
}

function dispatchSettings() {
  return {
    model: GOBLINS_MANAGER_MODEL,
    reasoning: {
      effort: BACKGROUND_TIER.managerReasoningEffort,
      summary: "auto",
    } as OpenAI.Reasoning,
    textVerbosity: "high" as const,
    parallelToolCalls: true,
    promptCacheKey: "goblins-manager",
    promptCacheRetention: "24h" as const,
    stream: true,
  }
}

export interface CreateGoblinsBackgroundRunParams {
  userId: string
  threadId: string
  requestId?: string
  // The composed per-request system instruction (before manager augmentation).
  systemInstruction: string
  messages: { role: string; content: string }[]
}

export interface GoblinsBackgroundRunHandle {
  runId: string
  threadId: string
  assistantMessageId: string
  status: string
}

/**
 * Escalates a Goblins request into a durable background run: persists the run
 * record and dispatches manager turn 1 as an OpenAI background response. From
 * here the run advances on webhook deliveries and client polls only.
 */
export async function createGoblinsBackgroundRun(
  params: CreateGoblinsBackgroundRunParams
): Promise<GoblinsBackgroundRunHandle> {
  const input: GoblinsRunInputMessage[] = params.messages.flatMap((message) =>
    (message.role === "user" || message.role === "assistant") &&
    message.content.trim().length > 0
      ? [{ role: message.role, content: message.content }]
      : []
  )

  const run = await createGoblinsRun({
    id: crypto.randomUUID(),
    userId: params.userId,
    threadId: params.threadId,
    assistantMessageId: crypto.randomUUID(),
    systemInstruction: buildGoblinsBackgroundManagerInstruction(
      params.systemInstruction
    ),
    input,
  })

  logger.info("Created goblins background run.", {
    runId: run.id,
    requestId: params.requestId,
    threadId: params.threadId,
  })

  const client = getOpenAiClient(getOpenAiApiKey() ?? "")
  const dispatched = await createBackgroundResponse(client, {
    ...dispatchSettings(),
    instructions: run.systemInstruction,
    input: run.input.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    tools: buildManagerToolDefinitions(),
    metadata: { goblinsRunId: run.id },
  })

  await advanceGoblinsRunToNextTurn({
    runId: run.id,
    openaiResponseId: dispatched.id,
    previousResponseId: null,
    turn: 1,
  })

  return {
    runId: run.id,
    threadId: run.threadId,
    assistantMessageId: run.assistantMessageId,
    status: "awaiting_manager",
  }
}

const functionCallItemSchema = z.object({
  type: z.literal("function_call"),
  call_id: z.string(),
  name: z.string(),
  arguments: z.string(),
})

interface ExtractedTurnOutput {
  functionCalls: GoblinsRunPendingToolCall[]
  finalText: string
  reasoningSummary: string
}

function extractTurnOutput(response: {
  output?: unknown
  output_text?: string
}): ExtractedTurnOutput {
  const functionCalls: GoblinsRunPendingToolCall[] = []
  let finalText = ""
  let reasoningSummary = ""

  const output = Array.isArray(response.output) ? response.output : []
  for (const item of output) {
    const parsedCall = functionCallItemSchema.safeParse(item)
    if (parsedCall.success) {
      functionCalls.push({
        callId: parsedCall.data.call_id,
        name: parsedCall.data.name,
        arguments: parsedCall.data.arguments,
      })
      continue
    }

    const record = item as {
      type?: string
      content?: { type?: string; text?: string }[]
      summary?: { type?: string; text?: string }[]
    }
    if (record.type === "message" && Array.isArray(record.content)) {
      for (const part of record.content) {
        if (part.type === "output_text" && typeof part.text === "string") {
          finalText += part.text
        }
      }
    } else if (record.type === "reasoning" && Array.isArray(record.summary)) {
      for (const part of record.summary) {
        if (typeof part.text === "string") {
          reasoningSummary += `${part.text}\n\n`
        }
      }
    }
  }

  if (!finalText && typeof response.output_text === "string") {
    finalText = response.output_text
  }

  return { functionCalls, finalText, reasoningSummary: reasoningSummary.trim() }
}

const goblinArgumentsSchema = z.object({
  input: z.string(),
  knownFindings: z.string().nullable().optional(),
})

const coverageArgumentsSchema = z.object({
  question: z.string(),
  findingsSummary: z.string(),
})

async function executeLocalToolCall(params: {
  run: GoblinsRun
  call: GoblinsRunPendingToolCall
  sharedResearch: SharedResearchState
  hostedToolsEnabled: boolean
  signal: AbortSignal
  onEvents: (events: AgentStreamEvent[]) => Promise<void>
}): Promise<string> {
  const { run, call } = params

  if (call.name === COVERAGE_CHECK_TOOL_NAME) {
    const parsed = coverageArgumentsSchema.safeParse(
      JSON.parse(call.arguments) as unknown
    )
    await params.onEvents([
      { type: "goblins_phase", phase: "evaluate", label: "Checking coverage" },
    ])
    if (!parsed.success) {
      return JSON.stringify({ verdict: "complete", gaps: [] })
    }
    return executeCoverageCheck({
      question: parsed.data.question,
      findingsSummary: parsed.data.findingsSummary,
      requestId: run.id,
      signal: params.signal,
    })
  }

  const definition: GoblinDefinition | undefined = GOBLIN_DEFINITIONS.find(
    (candidate) => candidate.subagentId === call.name
  )
  if (!definition) {
    return `GOBLIN_ERROR: unknown tool ${call.name}.`
  }

  const parsed = goblinArgumentsSchema.safeParse(
    JSON.parse(call.arguments) as unknown
  )
  if (!parsed.success) {
    return `GOBLIN_ERROR: ${call.name} received invalid arguments.`
  }

  await params.onEvents([
    {
      type: "subagent_call",
      callId: call.callId,
      subagentId: definition.subagentId,
      label: definition.label,
      task: parsed.data.input,
    },
  ])

  let brief: string
  try {
    brief = await runGoblinTask(definition, {
      openAiApiKey: getOpenAiApiKey() ?? "",
      exaApiKey: getExaApiKey(),
      signal: params.signal,
      input: parsed.data.input,
      ...(parsed.data.knownFindings
        ? { knownFindings: parsed.data.knownFindings }
        : {}),
      adaptive: {
        tier: BACKGROUND_TIER,
        sharedResearch: params.sharedResearch,
      },
      ...(params.hostedToolsEnabled ? { hosted: {} } : {}),
      onSubEvent: (event) => {
        void params.onEvents([event])
      },
    })
    if (!brief) {
      brief = "No findings could be gathered for this task."
    }
  } catch (error) {
    brief = `GOBLIN_ERROR: ${definition.subagentId} failed (${
      error instanceof Error ? error.message : String(error)
    }). No findings gathered.`
  }

  const failed = brief.startsWith("GOBLIN_ERROR:")
  await params.onEvents([
    {
      type: "subagent_result",
      callId: call.callId,
      subagentId: definition.subagentId,
      status: failed ? "error" : "success",
      ...(failed ? { errorCode: "GOBLIN_FAILED" } : {}),
    },
  ])

  return brief
}

function buildTimelineFromEvents(events: AgentStreamEvent[]): {
  timeline: ActivityTimelineEntry[]
  sources: MessageSource[]
  reasoning: string
} {
  const timeline: ActivityTimelineEntry[] = []
  const sources: MessageSource[] = []
  const seenSourceUrls = new Set<string>()
  let reasoning = ""
  let order = 0

  for (const event of events) {
    const createdAt = new Date().toISOString()
    if (event.type === "goblins_phase") {
      timeline.push({
        id: `phase-${String(order)}`,
        kind: "phase",
        order: order++,
        createdAt,
        phase: event.phase,
        label: event.label,
        ...(event.tier ? { tier: event.tier } : {}),
        ...(event.round !== undefined ? { round: event.round } : {}),
      })
    } else if (event.type === "subagent_call") {
      timeline.push({
        id: `subagent-${event.callId ?? String(order)}`,
        kind: "subagent",
        order: order++,
        createdAt,
        callId: event.callId,
        subagentId: event.subagentId,
        label: event.label,
        ...(event.task ? { task: event.task } : {}),
        status: "success",
      })
    } else if (event.type === "subagent_result") {
      const entry = [...timeline]
        .reverse()
        .find(
          (candidate) =>
            candidate.kind === "subagent" && candidate.callId === event.callId
        )
      if (entry?.kind === "subagent") {
        entry.status = event.status
        if (event.errorCode) {
          entry.errorCode = event.errorCode
        }
      }
    } else if (event.type === "source") {
      if (!seenSourceUrls.has(event.source.url)) {
        seenSourceUrls.add(event.source.url)
        sources.push(event.source)
      }
    } else if (event.type === "reasoning_delta") {
      reasoning += event.delta
    }
  }

  if (sources.length > 0) {
    timeline.push({
      id: `sources-${String(order)}`,
      kind: "sources",
      order: order++,
      createdAt: new Date().toISOString(),
      sources,
    })
  }

  return {
    timeline,
    sources,
    reasoning: sanitizeReasoningForDisplay(reasoning).trim(),
  }
}

async function finalizeGoblinsRun(
  run: GoblinsRun,
  finalText: string
): Promise<void> {
  const events = run.events
  const { timeline, sources, reasoning } = buildTimelineFromEvents(events)

  const assistantMessage: Message = {
    id: run.assistantMessageId,
    role: "assistant",
    content: finalText,
    llmModel: "goblins",
    createdAt: new Date().toISOString(),
    metadata: {
      selectedModel: "goblins",
      agentStatus: "completed",
      ...(reasoning ? { reasoning } : {}),
      ...(timeline.length > 0 ? { activityTimeline: timeline } : {}),
      ...(sources.length > 0 ? { sources } : {}),
      backgroundRun: { runId: run.id, status: "completed" },
    },
  }

  const existing = await getThreadForUser(run.userId, run.threadId)
  const now = new Date().toISOString()

  let thread: Thread
  if (existing) {
    const messages = [...existing.messages]
    const index = messages.findIndex(
      (message) =>
        message.metadata?.backgroundRun?.runId === run.id ||
        message.id === run.assistantMessageId
    )
    if (index >= 0) {
      messages[index] = assistantMessage
    } else {
      messages.push(assistantMessage)
    }
    thread = { ...existing, messages, updatedAt: now }
  } else {
    // The client never saved the thread (tab closed before the debounced PUT):
    // materialize it from the run's input so the answer is not lost.
    thread = {
      id: run.threadId,
      model: "goblins",
      messages: [
        ...run.input.map((message, index): Message => ({
          id: `${run.id}-input-${String(index)}`,
          role: message.role,
          content: message.content,
          llmModel: "goblins",
          createdAt: run.createdAt,
        })),
        assistantMessage,
      ],
      createdAt: run.createdAt,
      updatedAt: now,
    }
  }

  await upsertThreadForUser(run.userId, thread)
  await finishGoblinsRun(run.id, "completed")
  logger.info("Goblins background run completed.", {
    runId: run.id,
    threadId: run.threadId,
    eventCount: run.eventCount,
  })
}

export async function failGoblinsRun(
  runId: string,
  status: "failed" | "cancelled",
  error?: string
): Promise<void> {
  await finishGoblinsRun(runId, status, error)
  logger.warn("Goblins background run ended without completion.", {
    runId,
    status,
    error,
  })
}

/**
 * Runs one continuation segment for a background run: retrieve the completed
 * manager turn, execute its local tool calls (goblins + coverage_check),
 * dispatch the next chained turn — or fold the final answer into the thread.
 * Every wake source (webhook, client poll) funnels here; the lease claim makes
 * concurrent wake-ups safe.
 */
export async function continueGoblinsRun(
  runId: string,
  responseId: string
): Promise<void> {
  const leaseOwner = crypto.randomUUID()
  const run = await claimGoblinsRun(runId, leaseOwner)
  if (!run) {
    logger.info("Goblins run segment already claimed; skipping.", { runId })
    return
  }

  try {
    const client = getOpenAiClient(getOpenAiApiKey() ?? "")

    // A crash between dispatch and persist may have left an orphaned response;
    // cancel it before re-driving so the chain stays linear.
    if (
      run.phase.step === "dispatching_turn" &&
      run.phase.dispatchedResponseId &&
      run.phase.dispatchedResponseId !== responseId
    ) {
      await client.responses
        .cancel(run.phase.dispatchedResponseId)
        .catch(() => undefined)
    }

    const response = await client.responses.retrieve(responseId)
    if (response.status === "failed" || response.status === "cancelled") {
      await failGoblinsRun(
        runId,
        response.status === "cancelled" ? "cancelled" : "failed",
        response.error?.message
      )
      return
    }

    const { functionCalls, finalText, reasoningSummary } =
      extractTurnOutput(response)

    const consolidated: AgentStreamEvent[] = []
    if (reasoningSummary) {
      consolidated.push({ type: "reasoning_delta", delta: reasoningSummary })
    }

    // Final turn: no tool calls means the manager wrote the answer.
    if (functionCalls.length === 0) {
      if (finalText) {
        consolidated.push({ type: "text_delta", delta: finalText })
        await appendGoblinsRunEvents(runId, consolidated)
        await finalizeGoblinsRun(
          { ...run, events: [...run.events, ...consolidated] },
          finalText
        )
        return
      }

      // No tools and no text — force one last no-tools synthesis turn unless
      // we already tried that.
      if (run.phase.turn > BACKGROUND_TIER.managerMaxTurns + 1) {
        await failGoblinsRun(runId, "failed", "Manager produced no answer.")
        return
      }
      await appendGoblinsRunEvents(runId, consolidated)
      await dispatchNextTurn(run, client, responseId, [
        {
          role: "user",
          content: FINAL_SYNTHESIS_USER_PROMPT,
        },
      ])
      return
    }

    await appendGoblinsRunEvents(runId, consolidated)
    await updateGoblinsRunPhase(runId, {
      turn: run.phase.turn,
      pendingToolCalls: functionCalls,
    })

    // Execute the batch in parallel, skipping calls a previous (crashed)
    // segment already completed.
    const hostedToolsEnabled = (await resolveAgentFeatureFlags())
      .goblinsHostedTools
    const sharedResearch = createSharedResearchState()
    const signal = AbortSignal.timeout(GOBLINS_SEGMENT_BUDGET_MS)
    const onEvents = async (events: AgentStreamEvent[]) => {
      await appendGoblinsRunEvents(runId, events)
    }

    const results = await Promise.all(
      functionCalls.map(async (call) => {
        const existing = run.toolResults[call.callId]
        if (existing !== undefined) {
          return { call, brief: existing }
        }
        const brief = await executeLocalToolCall({
          run,
          call,
          sharedResearch,
          hostedToolsEnabled,
          signal,
          onEvents,
        })
        await recordGoblinsRunToolResult(runId, call.callId, brief)
        return { call, brief }
      })
    )

    const turnCapReached = run.phase.turn >= BACKGROUND_TIER.managerMaxTurns
    await dispatchNextTurn(
      run,
      client,
      responseId,
      results.map(({ call, brief }) => ({
        type: "function_call_output" as const,
        call_id: call.callId,
        output: brief,
      })),
      turnCapReached
    )
  } catch (error) {
    logger.error("Goblins run segment failed.", {
      runId,
      error: error instanceof Error ? error.message : String(error),
    })
    // Leave the lease to expire; a later wake source re-drives the segment.
    throw error instanceof Error
      ? error
      : new Error("Goblins run segment failed.")
  }
}

async function dispatchNextTurn(
  run: GoblinsRun,
  client: OpenAI,
  previousResponseId: string,
  input: OpenAI.Responses.ResponseCreateParams["input"],
  finalSynthesis = false
): Promise<void> {
  await updateGoblinsRunPhase(run.id, {
    turn: run.phase.turn,
    step: "dispatching_turn",
  })

  const turnInput = finalSynthesis
    ? [
        ...(Array.isArray(input) ? input : []),
        { role: "user" as const, content: FINAL_SYNTHESIS_USER_PROMPT },
      ]
    : input

  const dispatched = await createBackgroundResponse(client, {
    ...dispatchSettings(),
    instructions: finalSynthesis
      ? `${run.systemInstruction}\n\n${FINAL_SYNTHESIS_STEP_INSTRUCTION}`
      : run.systemInstruction,
    input: turnInput,
    ...(finalSynthesis ? {} : { tools: buildManagerToolDefinitions() }),
    previousResponseId,
    metadata: { goblinsRunId: run.id },
  })

  await updateGoblinsRunPhase(run.id, {
    turn: run.phase.turn,
    step: "dispatching_turn",
    dispatchedResponseId: dispatched.id,
  })

  await advanceGoblinsRunToNextTurn({
    runId: run.id,
    openaiResponseId: dispatched.id,
    previousResponseId,
    turn: run.phase.turn + 1,
  })

  logger.info("Dispatched goblins background manager turn.", {
    runId: run.id,
    turn: run.phase.turn + 1,
    responseId: dispatched.id,
    finalSynthesis,
  })
}
