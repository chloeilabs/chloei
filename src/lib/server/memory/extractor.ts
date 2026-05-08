import { createGateway } from "@ai-sdk/gateway"
import { generateText, Output } from "ai"
import { z } from "zod"

import { aiGatewayFetch } from "@/lib/server/llm/gateway-client"

import { AGENT_MEMORY_LLM_MODEL } from "./config"

const factsSchema = z.object({
  facts: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(500)
        .describe(
          "A single, self-contained fact about the user written in third person."
        )
    )
    .max(8),
})

const EXTRACTION_INSTRUCTION = [
  "You are a memory extractor for a personal AI assistant.",
  "Read the latest user/assistant exchange and extract durable facts about the USER that are worth remembering across future conversations.",
  "",
  "Rules:",
  "- Only extract stable, user-specific facts: preferences, goals, projects, relationships, recurring routines, professional context, identity attributes, constraints.",
  "- Do NOT extract one-off transient questions, ephemeral state, or facts about third parties unrelated to the user.",
  "- Do NOT include the assistant's answers as facts.",
  "- Each fact must be a single sentence, third person, self-contained (no pronouns like 'they' without an antecedent).",
  "- Prefer atomic facts. Split compound statements.",
  "- Return an empty array if there is nothing worth remembering.",
].join("\n")

interface ExtractFactsParams {
  userMessage: string
  assistantMessage?: string
  aiGatewayApiKey: string
  signal?: AbortSignal
}

export async function extractMemoryFacts(
  params: ExtractFactsParams
): Promise<string[]> {
  const gateway = createGateway({
    apiKey: params.aiGatewayApiKey,
    fetch: aiGatewayFetch,
  })

  const conversation = [
    `USER MESSAGE:\n${params.userMessage.trim()}`,
    params.assistantMessage?.trim()
      ? `ASSISTANT REPLY:\n${params.assistantMessage.trim()}`
      : null,
  ]
    .filter(Boolean)
    .join("\n\n")

  const { output } = await generateText({
    model: gateway(AGENT_MEMORY_LLM_MODEL),
    output: Output.object({ schema: factsSchema }),
    system: EXTRACTION_INSTRUCTION,
    prompt: conversation,
    abortSignal: params.signal,
  })

  return output.facts
    .map((fact) => fact.trim())
    .filter((fact) => fact.length > 0)
}
