interface PrivateReasoningReplacement {
  pattern: RegExp
  replacement: string
}

const PRIVATE_REASONING_REPLACEMENTS: readonly PrivateReasoningReplacement[] = [
  {
    pattern: /\bshared\s+context\s+file\s*:\s*soul\.md\b/gi,
    replacement: "private identity guidance",
  },
  {
    pattern: /\bsoul\.md\b/gi,
    replacement: "private identity guidance",
  },
  {
    pattern: /\bdefault_soul_fallback_instruction\b/gi,
    replacement: "private identity guidance",
  },
  {
    pattern:
      /\b(?:system|developer|application)\s+(?:prompt|message|instruction|instructions)\b/gi,
    replacement: "private instructions",
  },
  {
    pattern: /\bhidden\s+(?:prompt|prompts|instruction|instructions)\b/gi,
    replacement: "private instructions",
  },
  {
    pattern:
      /\b(?:operating instructions|auth user context|runtime date context|provider overlay|task mode overlay|long-term memory context|long-term memory capability)\b/gi,
    replacement: "private context",
  },
]

const PRIVATE_REASONING_TOKENS = [
  "shared context file: soul.md",
  "soul.md",
  "default_soul_fallback_instruction",
  "system prompt",
  "system message",
  "system instruction",
  "system instructions",
  "developer prompt",
  "developer message",
  "developer instruction",
  "developer instructions",
  "application prompt",
  "application message",
  "application instruction",
  "application instructions",
  "hidden prompt",
  "hidden prompts",
  "hidden instruction",
  "hidden instructions",
  "operating instructions",
  "auth user context",
  "runtime date context",
  "provider overlay",
  "task mode overlay",
  "long-term memory context",
  "long-term memory capability",
] as const

export function sanitizeReasoningForDisplay(text: string): string {
  return PRIVATE_REASONING_REPLACEMENTS.reduce(
    (current, { pattern, replacement }) =>
      current.replace(pattern, replacement),
    text
  )
}

export function getPrivateReasoningCarryLength(text: string): number {
  const lowerText = text.toLowerCase()
  let carryLength = 0

  for (const token of PRIVATE_REASONING_TOKENS) {
    const maxLength = Math.min(token.length - 1, lowerText.length)
    for (let length = maxLength; length > carryLength; length -= 1) {
      if (lowerText.endsWith(token.slice(0, length))) {
        carryLength = length
        break
      }
    }
  }

  return carryLength
}
