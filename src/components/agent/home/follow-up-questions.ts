import {
  type AgentRunMode,
  type FollowUpQuestion,
  isModelType,
  type Message as AgentMessage,
  type ModelType,
} from "@/lib/shared"

import type { AgentStreamAccumulator } from "./agent-stream-state"
import { EMPTY_ASSISTANT_RESPONSE_FALLBACK } from "./home-agent-utils"

const PARALLEL_FOLLOW_UP_MIN_CHARS = 80

// Older local threads may still contain canned suggestion ids from an earlier
// implementation. Treat those as absent so only generated follow-ups render.
const LEGACY_CANNED_FOLLOW_UP_ID_PREFIX = "fallback-follow-up"

interface FollowUpQuestionRequestTarget {
  assistantMessageId: string
  messages: AgentMessage[]
  model: ModelType
  runMode: AgentRunMode
}

type FollowUpQuestionRequestKind = "backfill" | "final" | "parallel"

export interface FollowUpQuestionRequestParams {
  assistantMessageId: string
  requestKind: FollowUpQuestionRequestKind
  messages: AgentMessage[]
  model: ModelType
  runMode: AgentRunMode
  threadId: string
}

function isFollowUpQuestion(value: unknown): value is FollowUpQuestion {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false
  }

  const question = value as Record<string, unknown>
  return (
    typeof question.id === "string" &&
    question.id.trim().length > 0 &&
    typeof question.text === "string" &&
    question.text.trim().length > 0
  )
}

export function parseFollowUpQuestionsResponse(
  payload: unknown
): FollowUpQuestion[] {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return []
  }

  const questions = (payload as Record<string, unknown>).followUpQuestions
  if (!Array.isArray(questions)) {
    return []
  }

  return questions
    .filter(isFollowUpQuestion)
    .slice(0, 3)
    .map((question) => ({
      id: question.id.trim(),
      text: question.text.trim(),
    }))
}

export function shouldRequestFollowUpQuestions(
  accumulator: AgentStreamAccumulator
): boolean {
  const content = accumulator.content.trim()

  return Boolean(
    content &&
    content !== EMPTY_ASSISTANT_RESPONSE_FALLBACK &&
    accumulator.agentStatus === "completed"
  )
}

export function shouldStartParallelFollowUpQuestions(
  accumulator: AgentStreamAccumulator
): boolean {
  const content = accumulator.content.trim()

  return (
    content.length >= PARALLEL_FOLLOW_UP_MIN_CHARS &&
    content !== EMPTY_ASSISTANT_RESPONSE_FALLBACK
  )
}

export function hasOnlyLegacyCannedFollowUpQuestions(
  questions: readonly FollowUpQuestion[] | undefined
): boolean {
  return Boolean(
    questions?.length &&
    questions.every((question) =>
      question.id.startsWith(LEGACY_CANNED_FOLLOW_UP_ID_PREFIX)
    )
  )
}

export function hasGeneratedFollowUpQuestions(
  questions: readonly FollowUpQuestion[] | undefined
): boolean {
  return Boolean(
    questions?.some(
      (question) => !question.id.startsWith(LEGACY_CANNED_FOLLOW_UP_ID_PREFIX)
    )
  )
}

export function getFollowUpQuestionRequestTargets(
  messages: AgentMessage[],
  requestedMessageIds: ReadonlySet<string>
): FollowUpQuestionRequestTarget[] {
  const targets: FollowUpQuestionRequestTarget[] = []

  messages.forEach((message, index) => {
    if (message.role !== "assistant") {
      return
    }

    const content = message.content.trim()
    const model = isModelType(message.llmModel)
      ? message.llmModel
      : message.metadata?.selectedModel

    if (
      !content ||
      content === EMPTY_ASSISTANT_RESPONSE_FALLBACK ||
      message.metadata?.isStreaming === true ||
      message.metadata?.agentStatus !== "completed" ||
      hasGeneratedFollowUpQuestions(message.metadata.followUpQuestions) ||
      requestedMessageIds.has(message.id) ||
      !isModelType(model)
    ) {
      return
    }

    targets.push({
      assistantMessageId: message.id,
      messages: messages.slice(0, index + 1),
      model,
      runMode: message.metadata.runMode ?? "chat",
    })
  })

  return targets
}
