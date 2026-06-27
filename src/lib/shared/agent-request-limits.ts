export const AGENT_REQUEST_MAX_MESSAGES = 50
export const AGENT_REQUEST_MAX_MESSAGE_CHARS = 12_000
export const AGENT_REQUEST_MAX_TOTAL_CHARS = 48_000

// Attachments (vision / PDF analysis).
export const AGENT_MAX_ATTACHMENTS_PER_MESSAGE = 5
export const AGENT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024
// Base64 data URLs inflate raw bytes by ~4/3 plus a small header; cap the
// encoded string generously above AGENT_ATTACHMENT_MAX_BYTES.
export const AGENT_ATTACHMENT_MAX_DATA_URL_CHARS = 15 * 1024 * 1024
export const AGENT_SUPPORTED_IMAGE_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const
export const AGENT_SUPPORTED_FILE_MEDIA_TYPES = ["application/pdf"] as const
export const AGENT_SUPPORTED_ATTACHMENT_MEDIA_TYPES = [
  ...AGENT_SUPPORTED_IMAGE_MEDIA_TYPES,
  ...AGENT_SUPPORTED_FILE_MEDIA_TYPES,
] as const
