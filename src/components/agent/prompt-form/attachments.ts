import {
  type MessageAttachment,
  type MessageAttachmentKind,
} from "@/lib/shared"
import {
  AGENT_ATTACHMENT_MAX_BYTES,
  AGENT_MAX_ATTACHMENTS_PER_MESSAGE,
  AGENT_SUPPORTED_FILE_MEDIA_TYPES,
  AGENT_SUPPORTED_IMAGE_MEDIA_TYPES,
} from "@/lib/shared/agent-request-limits"

export const MAX_ATTACHMENTS = AGENT_MAX_ATTACHMENTS_PER_MESSAGE

/** `accept` attribute for the hidden file input. */
export const ACCEPTED_ATTACHMENT_TYPES = [
  ...AGENT_SUPPORTED_IMAGE_MEDIA_TYPES,
  ...AGENT_SUPPORTED_FILE_MEDIA_TYPES,
].join(",")

const IMAGE_MEDIA_TYPES = new Set<string>(AGENT_SUPPORTED_IMAGE_MEDIA_TYPES)
const FILE_MEDIA_TYPES = new Set<string>(AGENT_SUPPORTED_FILE_MEDIA_TYPES)

export function attachmentKindForMediaType(
  mediaType: string
): MessageAttachmentKind | null {
  if (IMAGE_MEDIA_TYPES.has(mediaType)) {
    return "image"
  }
  if (FILE_MEDIA_TYPES.has(mediaType)) {
    return "pdf"
  }
  return null
}

interface ReadAttachmentResult {
  attachment?: MessageAttachment
  error?: string
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => {
      reject(reader.error ?? new Error("Failed to read file"))
    }
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result)
      } else {
        reject(new Error("Unexpected file contents"))
      }
    }
    reader.readAsDataURL(file)
  })
}

export async function readAttachmentFile(
  file: File
): Promise<ReadAttachmentResult> {
  const kind = attachmentKindForMediaType(file.type)
  if (!kind) {
    return { error: `${file.name}: unsupported file type` }
  }

  if (file.size > AGENT_ATTACHMENT_MAX_BYTES) {
    const maxMb = Math.round(AGENT_ATTACHMENT_MAX_BYTES / (1024 * 1024))
    return { error: `${file.name}: exceeds the ${String(maxMb)} MB limit` }
  }

  try {
    const url = await readFileAsDataUrl(file)
    return {
      attachment: {
        id: globalThis.crypto.randomUUID(),
        kind,
        name: file.name,
        mediaType: file.type,
        url,
      },
    }
  } catch {
    return { error: `${file.name}: could not be read` }
  }
}
