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
  "Read the latest user message and extract durable facts about the USER that are worth remembering across future conversations.",
  "",
  "Rules:",
  "- Only extract stable, user-specific facts: preferences, goals, projects, relationships, recurring routines, professional context, identity attributes, constraints.",
  "- Do NOT extract one-off transient questions, ephemeral state, or facts about third parties unrelated to the user.",
  "- Each fact must be a single sentence, third person, self-contained (no pronouns like 'they' without an antecedent).",
  "- Prefer atomic facts. Split compound statements.",
  "- Return an empty array if there is nothing worth remembering.",
].join("\n")

interface ExtractFactsParams {
  userMessage: string
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

  const { output } = await generateText({
    model: gateway(AGENT_MEMORY_LLM_MODEL),
    output: Output.object({ schema: factsSchema }),
    system: EXTRACTION_INSTRUCTION,
    prompt: `USER MESSAGE:\n${params.userMessage.trim()}`,
    abortSignal: params.signal,
  })

  return output.facts
    .map((fact) => fact.trim())
    .filter((fact) => fact.length > 0)
}
