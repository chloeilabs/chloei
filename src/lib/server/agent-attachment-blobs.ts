import { type Buffer } from "node:buffer"

import type { AgentRequestAttachment } from "@/lib/shared"

import { readPrivateBlob } from "./private-blob-storage"

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
          })
          if (!blob) {
            throw new Error("Blob-backed attachment could not be read.")
          }

          return {
            ...attachment,
            dataUrl: toDataUrl(attachment.mediaType, blob.buffer),
          }
        })
      )

      return {
        ...message,
        attachments: hydratedAttachments,
      }
    })
  )

  return hydratedMessages
}
