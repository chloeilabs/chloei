import { generateText } from "ai"

import { createLogger } from "@/lib/logger"
import {
  type AgentRequestAttachment,
  VISION_PREPROCESSOR_MODEL,
} from "@/lib/shared"

import type { AgentInputMessage } from "./agent-runtime-messages"
import { createConfiguredAiGateway } from "./gateway-client"
import { escapeAttachmentFilenameForPrompt } from "./image-vision-preprocessor-utils"

const PREPROCESSOR_PROMPT =
  "Describe this image in detail for someone who cannot see it. Transcribe any visible text exactly. Note key visual elements, layout, colors, and anything else relevant for analysis. Be thorough but concise."

const logger = createLogger("image-vision-preprocessor")

interface DescribeImageParams {
  attachment: AgentRequestAttachment
  aiGatewayApiKey?: string
  signal?: AbortSignal
}

export async function describeAttachmentImage(
  params: DescribeImageParams
): Promise<string> {
  if (!params.attachment.dataUrl) {
    throw new Error("Image attachment payload is missing.")
  }

  const gatewayProvider = createConfiguredAiGateway(params.aiGatewayApiKey)

  const result = await generateText({
    model: gatewayProvider(VISION_PREPROCESSOR_MODEL),
    abortSignal: params.signal,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: PREPROCESSOR_PROMPT,
          },
          {
            type: "image",
            image: params.attachment.dataUrl,
            mediaType: params.attachment.mediaType,
          },
        ],
      },
    ],
  })

  const text = result.text.trim()
  if (!text) {
    logger.warn("Vision preprocessor returned empty description.", {
      filename: params.attachment.filename,
    })
    return "(empty image description)"
  }

  return text
}

interface PreprocessParams {
  messages: AgentInputMessage[]
  aiGatewayApiKey?: string
  signal?: AbortSignal
}

export async function describeImagesForTextOnlyModel(
  params: PreprocessParams
): Promise<AgentInputMessage[]> {
  const result: AgentInputMessage[] = []

  for (const message of params.messages) {
    const attachments = message.attachments ?? []
    if (message.role !== "user" || attachments.length === 0) {
      result.push(message)
      continue
    }

    const imageAttachments = attachments.filter(
      (attachment) => attachment.kind === "image"
    )
    if (imageAttachments.length === 0) {
      result.push(message)
      continue
    }

    const remainingAttachments = attachments.filter(
      (attachment) => attachment.kind !== "image"
    )

    const descriptions = await Promise.all(
      imageAttachments.map((attachment) =>
        describeAttachmentImage({
          attachment,
          aiGatewayApiKey: params.aiGatewayApiKey,
          signal: params.signal,
        }).catch((error: unknown) => {
          logger.warn("Vision preprocessor failed for an image.", {
            filename: attachment.filename,
            error,
          })
          return "(image description unavailable)"
        })
      )
    )

    const descriptionBlocks = imageAttachments
      .map((attachment, index) => {
        const description =
          descriptions[index] ?? "(image description unavailable)"
        return `<attached_image filename="${escapeAttachmentFilenameForPrompt(attachment.filename)}">\n${description}\n</attached_image>`
      })
      .join("\n\n")

    const content = message.content
      ? `${message.content}\n\n${descriptionBlocks}`
      : descriptionBlocks

    result.push({
      role: "user",
      content,
      ...(remainingAttachments.length > 0
        ? { attachments: remainingAttachments }
        : {}),
    })
  }

  return result
}
