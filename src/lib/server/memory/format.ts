import type { MemoryRecord } from "./types"

export function formatMemoryBlock(records: readonly MemoryRecord[]): string {
  if (records.length === 0) {
    return ""
  }

  const lines = [
    "# Long-Term User Memory",
    "",
    "These are durable facts about the authenticated user, learned from prior conversations.",
    "Treat them as background context. Do not surface them unless they are relevant to the current request.",
    "If a fact contradicts new information from the user, trust the user.",
    "",
  ]

  for (const record of records) {
    lines.push(`- ${record.fact}`)
  }

  return lines.join("\n")
}
