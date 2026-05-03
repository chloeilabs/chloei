import { asRecord, asString } from "@/lib/cast"
import { parseHttpErrorResponse } from "@/lib/http-error"
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

function parseOptionalToolMetadata(record: Record<string, unknown>) {
  const parseOptionalString = (key: "operation" | "provider" | "errorCode") => {
    const value = record[key]
    if (value === undefined || value === null) {
      return undefined
    }

    const trimmed = asString(value)?.trim()
    if (!trimmed) {
      return null
    }

    return trimmed
  }

  const operation = parseOptionalString("operation")
  if (operation === null) return null

  const provider = parseOptionalString("provider")
  if (provider === null) return null

  const attempt = record.attempt
  if (
    attempt !== undefined &&
    attempt !== null &&
    (typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1)
  ) {
    return null
  }

  const durationMs = record.durationMs
  if (
    durationMs !== undefined &&
    durationMs !== null &&
    (typeof durationMs !== "number" ||
      !Number.isFinite(durationMs) ||
      durationMs < 0)
  ) {
    return null
  }

  const errorCode = parseOptionalString("errorCode")
  if (errorCode === null) return null

  const retryable = record.retryable
  if (
    retryable !== undefined &&
    retryable !== null &&
    typeof retryable !== "boolean"
  ) {
    return null
  }

  return {
    ...(operation ? { operation } : {}),
    ...(provider ? { provider } : {}),
    ...(typeof attempt === "number" ? { attempt } : {}),
    ...(typeof durationMs === "number" ? { durationMs } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(typeof retryable === "boolean" ? { retryable } : {}),
  }
}

function parseOptionalStringField(
  record: Record<string, unknown>,
  key: string
): string | null | undefined {
  const value = record[key]
  if (value === undefined || value === null) {
    return undefined
  }

  const stringValue = asString(value)
  if (stringValue === null) {
    return null
  }

  const trimmed = stringValue.trim()
  return trimmed.length > 0 ? trimmed : null
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

    const toolMetadata = parseOptionalToolMetadata(record)
    if (!toolMetadata) {
      return null
    }

    return {
      type,
      callId: callId ?? null,
      toolName,
      label,
      ...(query ? { query } : {}),
      ...toolMetadata,
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

    const toolName = record.toolName
    if (toolName !== undefined && toolName !== null && !isToolName(toolName)) {
      return null
    }

    const toolMetadata = parseOptionalToolMetadata(record)
    if (!toolMetadata) {
      return null
    }

    return {
      type,
      callId: callId ?? null,
      ...(isToolName(toolName) ? { toolName } : {}),
      status,
      ...toolMetadata,
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

  if (type === "harness_trace") {
    const stage = asString(record.stage)?.trim()
    if (
      stage !== "evidence" &&
      stage !== "final_synthesis" &&
      stage !== "plan" &&
      stage !== "tool_decision" &&
      stage !== "verification"
    ) {
      return null
    }

    const label = asString(record.label)?.trim()
    if (!label) {
      return null
    }

    const detail = parseOptionalStringField(record, "detail")
    if (detail === null) {
      return null
    }

    const status = parseOptionalStringField(record, "status")
    if (status === null) {
      return null
    }

    if (
      status !== undefined &&
      status !== "error" &&
      status !== "info" &&
      status !== "success" &&
      status !== "warning"
    ) {
      return null
    }

    return {
      type,
      stage,
      label,
      ...(detail !== undefined ? { detail } : {}),
      ...(status !== undefined ? { status } : {}),
      ...checkpointFields,
    }
  }

  return null
}

export async function getResponseErrorMessage(
  response: Response
): Promise<string> {
  return (await parseHttpErrorResponse(response)).message
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
