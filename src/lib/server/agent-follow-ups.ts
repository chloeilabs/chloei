import { randomUUID } from "node:crypto"

import type { GatewayProviderOptions } from "@ai-sdk/gateway"
import { z } from "zod"

import {
  type AgentRunMode,
  type FollowUpQuestion,
  type ModelType,
} from "@/lib/shared"
import {
  AGENT_REQUEST_MAX_MESSAGE_CHARS,
  AGENT_REQUEST_MAX_MESSAGES,
  AGENT_REQUEST_MAX_TOTAL_CHARS,
} from "@/lib/shared/agent-request-limits"

const FOLLOW_UP_QUESTION_LIMIT = 3
const FOLLOW_UP_QUESTION_MAX_CHARS = 160
const FOLLOW_UP_CONTEXT_MAX_CHARS = 16_000
const FOLLOW_UP_GENERATION_MODEL = "openai/gpt-5.1-instant"

const generatedFollowUpQuestionTextsSchema = z
  .array(z.string().trim().min(1).max(FOLLOW_UP_QUESTION_MAX_CHARS))
  .min(1)
  .max(4)

export const generatedFollowUpQuestionsSchema = z
  .object({
    questions: generatedFollowUpQuestionTextsSchema,
  })
  .strict()

const generatedFollowUpQuestionsResponseSchema = z
  .union([
    generatedFollowUpQuestionsSchema,
    z
      .object({
        follow_up_questions: generatedFollowUpQuestionTextsSchema,
      })
      .strict()
      .transform((value) => ({
        questions: value.follow_up_questions,
      })),
  ])

export const followUpQuestionsResponseSchema = z
  .object({
    followUpQuestions: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(200),
            text: z.string().trim().min(1).max(FOLLOW_UP_QUESTION_MAX_CHARS),
          })
          .strict()
      )
      .max(FOLLOW_UP_QUESTION_LIMIT),
  })
  .strict()

export interface FollowUpContextMessage {
  role: "user" | "assistant"
  content: string
}

export const followUpContextMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string().trim().min(1).max(AGENT_REQUEST_MAX_MESSAGE_CHARS),
  })
  .strict()

export const followUpRequestSchema = z
  .object({
    model: z.string().trim().min(1).max(200),
    runMode: z.enum(["chat", "research"]).optional(),
    threadId: z.string().trim().min(1).max(200).optional(),
    assistantMessageId: z.string().trim().min(1).max(200).optional(),
    messages: z
      .array(followUpContextMessageSchema)
      .min(2)
      .max(AGENT_REQUEST_MAX_MESSAGES),
  })
  .strict()

function normalizeQuestionText(text: string): string | null {
  const normalized = text
    .trim()
    .replace(/^(?:[-*•]|\d+[.)])\s+/u, "")
    .replace(/\s+/g, " ")

  if (!normalized || normalized.length > FOLLOW_UP_QUESTION_MAX_CHARS) {
    return null
  }

  return normalized
}

export function normalizeGeneratedFollowUpQuestionTexts(
  value: unknown
): string[] {
  const parsed = generatedFollowUpQuestionsResponseSchema.safeParse(value)
  if (!parsed.success) {
    return []
  }

  const seen = new Set<string>()
  const normalizedQuestions: string[] = []

  for (const question of parsed.data.questions) {
    const normalized = normalizeQuestionText(question)
    if (!normalized) {
      continue
    }

    const key = normalized.toLowerCase()
    if (seen.has(key)) {
      continue
    }

    seen.add(key)
    normalizedQuestions.push(normalized)
  }

  return normalizedQuestions.slice(0, FOLLOW_UP_QUESTION_LIMIT)
}

export function createFollowUpQuestions(
  texts: readonly string[],
  createId: () => string = randomUUID
): FollowUpQuestion[] {
  return texts.slice(0, FOLLOW_UP_QUESTION_LIMIT).flatMap((text) => {
    const normalized = normalizeQuestionText(text)
    return normalized ? [{ id: createId(), text: normalized }] : []
  })
}

export function validateFollowUpMessages(
  messages: readonly FollowUpContextMessage[]
): boolean {
  const totalChars = messages.reduce(
    (total, message) => total + message.content.length,
    0
  )
  const lastMessage = messages[messages.length - 1]

  return (
    totalChars <= AGENT_REQUEST_MAX_TOTAL_CHARS &&
    lastMessage?.role === "assistant" &&
    lastMessage.content.trim().length > 0
  )
}

function truncateContext(messages: readonly FollowUpContextMessage[]) {
  const recentMessages = messages.slice(-10)
  const lines = recentMessages.map((message) => {
    const label = message.role === "user" ? "User" : "Assistant"
    return `${label}: ${message.content.trim()}`
  })
  const joined = lines.join("\n\n")

  if (joined.length <= FOLLOW_UP_CONTEXT_MAX_CHARS) {
    return joined
  }

  return joined.slice(joined.length - FOLLOW_UP_CONTEXT_MAX_CHARS).trimStart()
}

export async function generateFollowUpQuestions(params: {
  aiGatewayApiKey: string
  messages: readonly FollowUpContextMessage[]
  model: ModelType
  runMode?: AgentRunMode
  signal?: AbortSignal
  userId: string
}): Promise<FollowUpQuestion[]> {
  const [{ createGateway }, { generateText, Output }, { aiGatewayFetch }] =
    await Promise.all([
      import("@ai-sdk/gateway"),
      import("ai"),
      import("./llm/gateway-client"),
    ])
  const gateway = createGateway({
    apiKey: params.aiGatewayApiKey,
    fetch: aiGatewayFetch,
  })
  const context = truncateContext(params.messages)

  const result = await generateText({
    model: gateway(FOLLOW_UP_GENERATION_MODEL),
    system:
      "You generate concise follow-up questions for a chat UI. Return only structured data. Each question must be useful, specific to the assistant's latest answer, written from the user's point of view, and short enough for a compact button. Each question must include a concrete term, entity, claim, or tradeoff from the latest answer. Do not use markdown, numbering, emojis, citations, repeated questions, or generic prompts like asking for an example without naming the topic.",
    prompt: [
      "Generate exactly three follow-up questions for the latest assistant response.",
      'Use this exact JSON shape: {"questions":["...","...","..."]}.',
      `Conversation mode: ${params.runMode ?? "chat"}.`,
      "Avoid questions the assistant already answered directly.",
      "Conversation:",
      context,
    ].join("\n\n"),
    output: Output.object({
      schema: generatedFollowUpQuestionsSchema,
    }),
    providerOptions: {
      gateway: {
        user: params.userId,
        tags: [
          "feature:follow_up_questions",
          `generation_model:${FOLLOW_UP_GENERATION_MODEL}`,
          `source_model:${params.model}`,
          `run_mode:${params.runMode ?? "chat"}`,
        ],
      } satisfies GatewayProviderOptions,
    },
    abortSignal: params.signal,
  })

  return createFollowUpQuestions(
    normalizeGeneratedFollowUpQuestionTexts(result.output)
  )
}
