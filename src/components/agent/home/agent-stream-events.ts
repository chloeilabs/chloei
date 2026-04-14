import { asRecord, asString } from "@/lib/cast"
import {
  AGENT_RUN_STATUSES,
  type AgentRunStatus,
  type AgentStreamEvent,
  isToolName,
} from "@/lib/shared"

const AGENT_RUN_STATUS_SET: ReadonlySet<AgentRunStatus> = new Set(
  AGENT_RUN_STATUSES
)

function isAgentRunStatus(value: unknown): value is AgentRunStatus {
  return (
    typeof value === "string" &&
    AGENT_RUN_STATUS_SET.has(value as AgentRunStatus)
  )
}

function parseInteractionCheckpointFields(
  record: Record<string, unknown>
): Pick<AgentStreamEvent, "interactionId" | "lastEventId"> | null {
  const nextFields: Pick<AgentStreamEvent, "interactionId" | "lastEventId"> = {}

  if ("interactionId" in record) {
    const interactionId = asString(record.interactionId)?.trim()
    if (!interactionId) {
      return null
    }
    nextFields.interactionId = interactionId
  }

  if ("lastEventId" in record) {
    const lastEventId = asString(record.lastEventId)?.trim()
    if (!lastEventId) {
      return null
    }
    nextFields.lastEventId = lastEventId
  }

  return nextFields
}

export function parseStreamEventLine(line: string): AgentStreamEvent | null {
  if (!line) {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }

  const record = asRecord(parsed)
  if (!record) {
    return null
  }

  const type = asString(record.type)
  if (!type) {
    return null
  }

  const checkpointFields = parseInteractionCheckpointFields(record)
  if (!checkpointFields) {
    return null
  }

  if (type === "text_delta") {
    const delta = asString(record.delta)
    if (delta === null) {
      return null
    }

    return { type, delta, ...checkpointFields }
  }

  if (type === "reasoning_delta") {
    const delta = asString(record.delta)
    if (delta === null) {
      return null
    }

    return { type, delta, ...checkpointFields }
  }

  if (type === "tool_call") {
    const callIdRaw = record.callId
    const callId = asString(callIdRaw)
    if (callIdRaw !== null && callId === null) {
      return null
    }

    const toolName = record.toolName
    if (!isToolName(toolName)) {
      return null
    }

    const label = asString(record.label)?.trim()
    if (!label) {
      return null
    }

    const queryValue = record.query
    const query = asString(queryValue)?.trim()
    if (
      queryValue !== undefined &&
      queryValue !== null &&
      asString(queryValue) === null
    ) {
      return null
    }

    return {
      type,
      callId: callId ?? null,
      toolName,
      label,
      ...(query ? { query } : {}),
      ...checkpointFields,
    }
  }

  if (type === "tool_result") {
    const callIdRaw = record.callId
    const callId = asString(callIdRaw)
    if (callIdRaw !== null && callId === null) {
      return null
    }

    const status = asString(record.status)
    if (status !== "success" && status !== "error") {
      return null
    }

    return {
      type,
      callId: callId ?? null,
      status,
      ...checkpointFields,
    }
  }

  if (type === "source") {
    const sourceRecord = asRecord(record.source)
    if (!sourceRecord) {
      return null
    }

    const id = asString(sourceRecord.id)?.trim()
    const url = asString(sourceRecord.url)?.trim()
    const title = asString(sourceRecord.title)?.trim()
    if (!id || !url || !title) {
      return null
    }

    return {
      type,
      source: {
        id,
        url,
        title,
      },
      ...checkpointFields,
    }
  }

  if (type === "agent_status") {
    const status = record.status
    if (!isAgentRunStatus(status)) {
      return null
    }

    return {
      type,
      status,
      ...checkpointFields,
    }
  }

  return null
}

export async function getResponseErrorMessage(
  response: Response
): Promise<string> {
  const bodyText = await response.text().catch(() => "")
  if (!bodyText) {
    return `Request failed (${String(response.status)})`
  }

  try {
    const parsed = JSON.parse(bodyText) as unknown
    const record = asRecord(parsed)
    const error = asString(record?.error)
    if (error) {
      return error
    }
  } catch {
    // Ignore malformed JSON and fall back to raw text.
  }

  return bodyText
}

export async function readResponseStreamLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string, appendNewline: boolean) => void
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let lineBuffer = ""

  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }

    const chunk = decoder.decode(value, { stream: true })
    if (!chunk) {
      continue
    }

    lineBuffer += chunk

    const lines = lineBuffer.split("\n")
    lineBuffer = lines.pop() ?? ""

    for (const line of lines) {
      onLine(line, true)
    }
  }

  const finalChunk = decoder.decode()
  if (finalChunk) {
    lineBuffer += finalChunk
  }

  if (lineBuffer.length > 0) {
    onLine(lineBuffer, false)
  }
}
