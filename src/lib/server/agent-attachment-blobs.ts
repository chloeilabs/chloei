import { type Buffer } from "node:buffer"

import { createLogger } from "@/lib/logger"
import {
  type AgentRequestAttachment,
  normalizeAgentAttachmentMimeType,
} from "@/lib/shared"

import { readPrivateBlob } from "./private-blob-storage"

const logger = createLogger("agent-attachment-blobs")

function toDataUrl(contentType: string, buffer: Buffer): string {
  return `data:${contentType};base64,${buffer.toString("base64")}`
}

export async function hydrateBlobBackedAttachments(params: {
  messages: {
    role: "system" | "user" | "assistant"
    content: string
    attachments?: AgentRequestAttachment[]
  }[]
  userId?: string
  signal?: AbortSignal
}) {
  const { userId } = params
  if (!userId) {
    return params.messages
  }

  const hydratedMessages = await Promise.all(
    params.messages.map(async (message) => {
      const attachments = message.attachments
      if (!attachments?.length) {
        return message
      }

      const hydratedAttachments = await Promise.all(
        attachments.map(async (attachment) => {
          if (attachment.dataUrl || !attachment.blobPathname) {
            return attachment
          }

          const blob = await readPrivateBlob({
            pathname: attachment.blobPathname,
            userId,
            signal: params.signal,
          }).catch(() => null)
          if (!blob) {
            logger.warn(
              "Blob-backed attachment could not be hydrated; omitting attachment.",
              {
                attachmentId: attachment.id,
                errorCode: "ATTACHMENT_BLOB_READ_FAILED",
                mediaType: attachment.mediaType,
              }
            )
            return null
          }

          const mediaType =
            normalizeAgentAttachmentMimeType(blob.contentType) ??
            attachment.mediaType

          return {
            ...attachment,
            mediaType,
            dataUrl: toDataUrl(mediaType, blob.buffer),
          }
        })
      )

      return {
        ...message,
        attachments: hydratedAttachments.filter(
          (attachment): attachment is AgentRequestAttachment =>
            attachment !== null
        ),
      }
    })
  )

  return hydratedMessages
}
