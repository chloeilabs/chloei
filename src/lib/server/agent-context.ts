import {
  type AuthViewer,
  DEFAULT_OPERATING_INSTRUCTION,
  DEFAULT_SOUL_FALLBACK_INSTRUCTION,
} from "@/lib/shared"

import {
  createPromptSteeringBlocks,
  type PromptProvider,
  type PromptTaskMode,
} from "./agent-prompt-steering"

interface RuntimePromptContext {
  now: Date
  userTimeZone?: string
  provider?: PromptProvider
  taskMode?: PromptTaskMode
}

interface AgentContextOverrides {
  operatingInstruction?: string
  providerOverlaysEnabled?: boolean
  taskModeOverlaysEnabled?: boolean
}

function formatPromptBlock(label: string, body: string): string {
  return [`--- BEGIN ${label} ---`, body.trim(), `--- END ${label} ---`].join(
    "\n"
  )
}

function formatAuthUserContext(viewer: AuthViewer): string {
  const name = viewer.name.trim() || "(not provided)"
  const email = viewer.email.trim() || "(not provided)"

  return [
    "# Runtime Auth User Context",
    "",
    "This section is generated from the authenticated session for the current request.",
    "",
    `- User ID: ${viewer.id}`,
    `- Name: ${name}`,
    `- Email: ${email}`,
  ].join("\n")
}

function normalizeTimeZone(value: string | undefined): string | undefined {
  const candidate = value?.trim()
  if (!candidate) {
    return undefined
  }

  try {
    new Intl.DateTimeFormat("en-US", {
      dateStyle: "full",
      timeStyle: "long",
      timeZone: candidate,
    }).format(new Date())
    return candidate
  } catch {
    return undefined
  }
}

function formatZonedDateTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "full",
    timeStyle: "long",
    timeZone,
  }).format(date)
}

function formatRuntimeDateContext(context: RuntimePromptContext): string {
  const userTimeZone = normalizeTimeZone(context.userTimeZone)
  const serverTimeZone = normalizeTimeZone(
    Intl.DateTimeFormat().resolvedOptions().timeZone
  )

  return [
    "# Runtime Date Context",
    "",
    "This section is generated for the current request and is authoritative for interpreting recency.",
    "",
    `- Current UTC timestamp: ${context.now.toISOString()}`,
    ...(userTimeZone
      ? [
          `- User time zone: ${userTimeZone}`,
          `- Current user-local time: ${formatZonedDateTime(context.now, userTimeZone)}`,
        ]
      : []),
    ...(serverTimeZone ? [`- Server time zone: ${serverTimeZone}`] : []),
    "- Treat the current date/time above as authoritative for words like today, tomorrow, yesterday, latest, recent, this week, and this month.",
    "- Unless the user explicitly asks about a past period, do not rewrite current-information requests into older years or months.",
    "- When searching for current information, keep queries aligned with the current date context first and then narrow from evidence.",
    "- When the user seems mistaken about dates, correct them with explicit calendar dates.",
  ].join("\n")
}

function composeSystemInstruction(params: {
  authUserContext: string
  runtimeContext: RuntimePromptContext
  operatingInstruction?: string
  providerOverlaysEnabled?: boolean
  taskModeOverlaysEnabled?: boolean
}): string {
  const blocks = [
    formatPromptBlock(
      "OPERATING INSTRUCTIONS",
      params.operatingInstruction ?? DEFAULT_OPERATING_INSTRUCTION
    ),
    formatPromptBlock(
      "RUNTIME DATE CONTEXT",
      formatRuntimeDateContext(params.runtimeContext)
    ),
  ]

  const promptSteeringBlocks = createPromptSteeringBlocks({
    provider: params.runtimeContext.provider,
    taskMode: params.runtimeContext.taskMode,
    providerOverlaysEnabled: params.providerOverlaysEnabled,
    taskModeOverlaysEnabled: params.taskModeOverlaysEnabled,
  })

  for (const block of promptSteeringBlocks) {
    blocks.push(formatPromptBlock(block.label, block.body))
  }

  blocks.push(
    formatPromptBlock(
      "SHARED CONTEXT FILE: SOUL.md",
      DEFAULT_SOUL_FALLBACK_INSTRUCTION
    )
  )

  blocks.push(formatPromptBlock("AUTH USER CONTEXT", params.authUserContext))

  return blocks.join("\n\n")
}

export function buildAgentSystemInstruction(
  viewer: AuthViewer,
  runtimeContext: RuntimePromptContext,
  overrides: AgentContextOverrides = {}
): string {
  return composeSystemInstruction({
    authUserContext: formatAuthUserContext(viewer),
    runtimeContext,
    operatingInstruction: overrides.operatingInstruction,
    providerOverlaysEnabled: overrides.providerOverlaysEnabled,
    taskModeOverlaysEnabled: overrides.taskModeOverlaysEnabled,
  })
}
