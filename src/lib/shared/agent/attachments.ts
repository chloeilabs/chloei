export const AGENT_ATTACHMENT_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const

export const AGENT_ATTACHMENT_PDF_MIME_TYPE = "application/pdf" as const

export const AGENT_ATTACHMENT_MIME_TYPES = [
  AGENT_ATTACHMENT_PDF_MIME_TYPE,
  ...AGENT_ATTACHMENT_IMAGE_MIME_TYPES,
] as const

export const AGENT_IMAGE_DETAIL_VALUES = [
  "auto",
  "low",
  "high",
  "original",
] as const

export const AGENT_ATTACHMENT_MAX_FILES = 4
export const AGENT_ATTACHMENT_MAX_FILE_BYTES = 4 * 1024 * 1024
export const AGENT_ATTACHMENT_MAX_TOTAL_BYTES = 8 * 1024 * 1024
export const AGENT_ATTACHMENT_MAX_PREVIEW_DATA_URL_CHARS = 80_000
export const AGENT_ATTACHMENT_MAX_DATA_URL_CHARS =
  Math.ceil(AGENT_ATTACHMENT_MAX_FILE_BYTES * 1.4) + 200

export type AgentAttachmentImageMimeType =
  (typeof AGENT_ATTACHMENT_IMAGE_MIME_TYPES)[number]
export type AgentAttachmentMimeType =
  (typeof AGENT_ATTACHMENT_MIME_TYPES)[number]
export type AgentAttachmentKind = "image" | "pdf"
export type AgentImageDetail = (typeof AGENT_IMAGE_DETAIL_VALUES)[number]

export interface AgentAttachmentMetadata {
  id: string
  kind: AgentAttachmentKind
  filename: string
  mediaType: AgentAttachmentMimeType
  sizeBytes: number
  detail?: AgentImageDetail
  previewDataUrl?: string
}

export interface AgentRequestAttachment extends AgentAttachmentMetadata {
  dataUrl: string
}

const IMAGE_MIME_TYPE_SET: ReadonlySet<string> = new Set(
  AGENT_ATTACHMENT_IMAGE_MIME_TYPES
)
const ATTACHMENT_MIME_TYPE_SET: ReadonlySet<string> = new Set(
  AGENT_ATTACHMENT_MIME_TYPES
)
const IMAGE_DETAIL_SET: ReadonlySet<string> = new Set(AGENT_IMAGE_DETAIL_VALUES)
const DATA_URL_BASE64_PREFIX_PATTERN = /^data:([^;,]+);base64,/i
const BASE64_PAYLOAD_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

export function isSupportedAgentAttachmentMimeType(value: unknown): boolean {
  return normalizeAgentAttachmentMimeType(value) !== null
}

export function normalizeAgentAttachmentMimeType(
  value: unknown
): AgentAttachmentMimeType | null {
  if (typeof value !== "string") {
    return null
  }

  const normalized = value.toLowerCase()
  return ATTACHMENT_MIME_TYPE_SET.has(normalized)
    ? (normalized as AgentAttachmentMimeType)
    : null
}

export function isAgentImageDetail(value: unknown): value is AgentImageDetail {
  return typeof value === "string" && IMAGE_DETAIL_SET.has(value)
}

export function getAgentAttachmentKind(mediaType: string): AgentAttachmentKind {
  const normalized = normalizeAgentAttachmentMimeType(mediaType)
  if (!normalized) {
    throw new Error("Unsupported attachment media type.")
  }

  return IMAGE_MIME_TYPE_SET.has(normalized) ? "image" : "pdf"
}

export function getAgentAttachmentAcceptAttribute(): string {
  return [
    ".pdf",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".gif",
    ...AGENT_ATTACHMENT_MIME_TYPES,
  ].join(",")
}

export function getDataUrlMediaType(dataUrl: string): string | null {
  const match = DATA_URL_BASE64_PREFIX_PATTERN.exec(dataUrl.trim())
  return match?.[1]?.toLowerCase() ?? null
}

function getDataUrlBase64Payload(dataUrl: string): string | null {
  const match = DATA_URL_BASE64_PREFIX_PATTERN.exec(dataUrl.trim())
  if (!match) {
    return null
  }

  return dataUrl.trim().slice(match[0].length)
}

export function isAgentAttachmentPreviewDataUrl(
  value: unknown
): value is string {
  if (typeof value !== "string") {
    return false
  }

  const dataUrl = value.trim()
  if (
    dataUrl.length === 0 ||
    dataUrl.length > AGENT_ATTACHMENT_MAX_PREVIEW_DATA_URL_CHARS
  ) {
    return false
  }

  const mediaType = getDataUrlMediaType(dataUrl)
  if (!mediaType || !IMAGE_MIME_TYPE_SET.has(mediaType)) {
    return false
  }

  const payload = getDataUrlBase64Payload(dataUrl)
  return (
    payload !== null &&
    payload.length > 0 &&
    payload.length % 4 === 0 &&
    BASE64_PAYLOAD_PATTERN.test(payload)
  )
}

export function toAgentAttachmentMetadata(
  attachment: AgentRequestAttachment
): AgentAttachmentMetadata {
  return {
    id: attachment.id,
    kind: attachment.kind,
    filename: attachment.filename,
    mediaType: attachment.mediaType,
    sizeBytes: attachment.sizeBytes,
    ...(attachment.detail ? { detail: attachment.detail } : {}),
    ...(attachment.previewDataUrl
      ? { previewDataUrl: attachment.previewDataUrl }
      : {}),
  }
}
