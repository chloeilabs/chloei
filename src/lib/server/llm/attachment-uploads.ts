import OpenAI, { toFile } from "openai"

import { createLogger } from "@/lib/logger"

const logger = createLogger("attachment-uploads")

// Memoized raw OpenAI client, keyed by API key. The Agents SDK doesn't expose
// the Files API, so attachment uploads need a direct client. Kept in this
// (route-only) module so the raw `openai` import stays out of the shared agent
// runtime modules.
let rawClient: OpenAI | undefined
let rawClientKey: string | undefined

function getOpenAiClient(apiKey: string): OpenAI {
  if (!rawClient || rawClientKey !== apiKey) {
    rawClient = new OpenAI({ apiKey })
    rawClientKey = apiKey
  }
  return rawClient
}

// Structural view of a request attachment we may upload. We mutate `fileId` in
// place so the same objects flow on to the model call with the id set.
interface UploadableAttachment {
  id: string
  kind: "image" | "pdf"
  name: string
  mediaType: string
  url?: string
  fileId?: string
}

interface UploadableMessage {
  attachments?: UploadableAttachment[]
}

// Decodes the base64 payload of a `data:<media>;base64,<b64>` URL. Client
// attachments are always base64 data URLs; anything else is skipped (left
// inline).
function decodeBase64DataUrl(url: string): Buffer | null {
  const commaIndex = url.indexOf(",")
  if (commaIndex < 0 || !url.slice(0, commaIndex).includes(";base64")) {
    return null
  }
  try {
    return Buffer.from(url.slice(commaIndex + 1), "base64")
  } catch {
    return null
  }
}

/**
 * Uploads any base64 attachment that doesn't yet have a `fileId` to the OpenAI
 * Files API, sets `fileId` on it in place (so the model call references the file
 * by id instead of resending base64), and returns the `{ attachmentId: fileId }`
 * map so the client can persist the id and reuse it on later turns — the file is
 * uploaded once and its tokens stay prompt-cacheable across turns. Failures
 * degrade gracefully: the attachment keeps its base64 `url` and is sent inline.
 */
export async function resolveAttachmentFileIds(params: {
  openAiApiKey: string
  messages: UploadableMessage[]
  requestId?: string
}): Promise<Record<string, string>> {
  const pending: UploadableAttachment[] = []
  for (const message of params.messages) {
    for (const attachment of message.attachments ?? []) {
      if (
        !attachment.fileId &&
        typeof attachment.url === "string" &&
        attachment.url.startsWith("data:")
      ) {
        pending.push(attachment)
      }
    }
  }
  if (pending.length === 0) {
    return {}
  }

  const client = getOpenAiClient(params.openAiApiKey)
  const fileIdsByAttachmentId: Record<string, string> = {}

  await Promise.all(
    pending.map(async (attachment) => {
      const bytes = decodeBase64DataUrl(attachment.url ?? "")
      if (!bytes) {
        return
      }
      try {
        const uploaded = await client.files.create({
          file: await toFile(bytes, attachment.name, {
            type: attachment.mediaType,
          }),
          // Images referenced by file_id must be uploaded with the "vision"
          // purpose; documents (PDFs) use "user_data".
          purpose: attachment.kind === "image" ? "vision" : "user_data",
        })
        attachment.fileId = uploaded.id
        fileIdsByAttachmentId[attachment.id] = uploaded.id
      } catch (error) {
        logger.warn(
          "Attachment upload to Files API failed; falling back to inline base64.",
          { requestId: params.requestId, error }
        )
      }
    })
  )

  return fileIdsByAttachmentId
}
