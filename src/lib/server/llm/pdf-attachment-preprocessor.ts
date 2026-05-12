import { Buffer } from "node:buffer"

import { createGateway } from "@ai-sdk/gateway"
import { generateText } from "ai"

import { createLogger } from "@/lib/logger"
import {
  extractPdfTextForModelInput,
  normalizeExtractedReadableText,
} from "@/lib/server/knowledge-indexing"
import {
  type AgentRequestAttachment,
  getDataUrlMediaType,
  PDF_PREPROCESSOR_MODEL,
} from "@/lib/shared"

import type { AgentInputMessage } from "./agent-runtime-messages"
import { aiGatewayFetch } from "./gateway-client"
import { escapeAttachmentFilenameForPrompt } from "./image-vision-preprocessor-utils"

const logger = createLogger("pdf-attachment-preprocessor")

const PDF_DATA_URL_PREFIX_PATTERN = /^data:[^;,]+;base64,/i
const MAX_PDF_ATTACHMENT_TEXT_CHARS = 80_000
const PDF_PREPROCESSOR_PROMPT = [
  "Extract the readable text from this PDF for a downstream text-only language model.",
  "Preserve headings, labels, table rows, dates, and numbers when possible.",
  "Return only the extracted document text. Do not summarize or add commentary.",
].join(" ")

function getBase64Payload(dataUrl: string): string | null {
  const match = PDF_DATA_URL_PREFIX_PATTERN.exec(dataUrl.trim())
  return match ? dataUrl.trim().slice(match[0].length) : null
}

function decodePdfDataUrl(dataUrl: string): Buffer | null {
  if (getDataUrlMediaType(dataUrl) !== "application/pdf") {
    return null
  }

  const payload = getBase64Payload(dataUrl)
  return payload ? Buffer.from(payload, "base64") : null
}

function truncatePdfText(text: string): string {
  if (text.length <= MAX_PDF_ATTACHMENT_TEXT_CHARS) {
    return text
  }

  return `${text.slice(0, MAX_PDF_ATTACHMENT_TEXT_CHARS).trimEnd()}\n\n[PDF text truncated after ${String(MAX_PDF_ATTACHMENT_TEXT_CHARS)} characters.]`
}

function isUsablePdfText(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) {
    return false
  }

  if (!/[A-Za-z0-9]/.test(trimmed)) {
    return false
  }

  const rawPdfMarkers = [
    "%PDF-",
    "endobj",
    "endstream",
    "/FlateDecode",
    "/ASCII85Decode",
    "startxref",
    "%%EOF",
  ].filter((marker) => trimmed.includes(marker)).length

  if (rawPdfMarkers >= 2) {
    return false
  }

  return true
}

async function extractPdfTextLocally(params: {
  attachment: AgentRequestAttachment
}): Promise<string | null> {
  const { attachment } = params
  if (!attachment.dataUrl) {
    return null
  }

  const buffer = decodePdfDataUrl(attachment.dataUrl)
  if (!buffer) {
    return null
  }

  try {
    const text = await extractPdfTextForModelInput(buffer)
    return isUsablePdfText(text) ? truncatePdfText(text) : null
  } catch (error) {
    logger.warn("Local PDF text extraction failed.", {
      attachmentId: attachment.id,
      error,
      filename: attachment.filename,
    })
    return null
  }
}

async function extractPdfTextWithModel(params: {
  attachment: AgentRequestAttachment
  aiGatewayApiKey: string
  signal?: AbortSignal
}): Promise<string | null> {
  if (!params.attachment.dataUrl) {
    return null
  }

  const gatewayProvider = createGateway({
    apiKey: params.aiGatewayApiKey,
    fetch: aiGatewayFetch,
  })

  try {
    const result = await generateText({
      model: gatewayProvider(PDF_PREPROCESSOR_MODEL),
      abortSignal: params.signal,
      maxOutputTokens: 16_000,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: PDF_PREPROCESSOR_PROMPT,
            },
            {
              type: "file",
              data: params.attachment.dataUrl,
              mediaType: params.attachment.mediaType,
              filename: params.attachment.filename,
            },
          ],
        },
      ],
    })

    const text = normalizeExtractedReadableText(result.text)
    return text ? truncatePdfText(text) : null
  } catch (error) {
    logger.warn("Gateway PDF text extraction fallback failed.", {
      attachmentId: params.attachment.id,
      error,
      filename: params.attachment.filename,
      model: PDF_PREPROCESSOR_MODEL,
    })
    return null
  }
}

type PdfTextExtractor = (params: {
  attachment: AgentRequestAttachment
  aiGatewayApiKey: string
  signal?: AbortSignal
}) => Promise<string | null>

async function runPdfTextExtractor(
  extractor: PdfTextExtractor,
  params: Parameters<PdfTextExtractor>[0],
  step: "local" | "gateway"
): Promise<string | null> {
  try {
    const text = await extractor(params)
    if (!text) {
      return null
    }

    if (!isUsablePdfText(text)) {
      logger.warn("PDF text extraction produced unusable text.", {
        attachmentId: params.attachment.id,
        filename: params.attachment.filename,
        step,
      })
      return null
    }

    return text
  } catch (error) {
    logger.warn("PDF text extraction step failed.", {
      attachmentId: params.attachment.id,
      error,
      filename: params.attachment.filename,
      step,
    })
    return null
  }
}

async function describePdfAttachment(params: {
  attachment: AgentRequestAttachment
  aiGatewayApiKey: string
  signal?: AbortSignal
  extractPdfText?: PdfTextExtractor
  extractPdfTextWithModel?: PdfTextExtractor
}): Promise<string> {
  const text =
    (await runPdfTextExtractor(
      params.extractPdfText ?? extractPdfTextLocally,
      params,
      "local"
    )) ??
    (await runPdfTextExtractor(
      params.extractPdfTextWithModel ?? extractPdfTextWithModel,
      params,
      "gateway"
    ))

  if (text) {
    return text
  }

  return "PDF text extraction was unavailable for this attachment."
}

interface PreprocessPdfParams {
  messages: AgentInputMessage[]
  aiGatewayApiKey: string
  signal?: AbortSignal
  preservePdfAttachments?: boolean
  extractPdfText?: PdfTextExtractor
  extractPdfTextWithModel?: PdfTextExtractor
}

export async function preparePdfAttachmentsForModel(
  params: PreprocessPdfParams
): Promise<AgentInputMessage[]> {
  const result: AgentInputMessage[] = []

  for (const message of params.messages) {
    const attachments = message.attachments ?? []
    if (message.role !== "user" || attachments.length === 0) {
      result.push(message)
      continue
    }

    const pdfAttachments = attachments.filter(
      (attachment) => attachment.kind === "pdf"
    )
    if (pdfAttachments.length === 0) {
      result.push(message)
      continue
    }

    const remainingAttachments = params.preservePdfAttachments
      ? attachments
      : attachments.filter((attachment) => attachment.kind !== "pdf")
    const descriptions = await Promise.all(
      pdfAttachments.map((attachment) =>
        describePdfAttachment({
          attachment,
          aiGatewayApiKey: params.aiGatewayApiKey,
          signal: params.signal,
          extractPdfText: params.extractPdfText,
          extractPdfTextWithModel: params.extractPdfTextWithModel,
        })
      )
    )
    const descriptionBlocks = pdfAttachments
      .map((attachment, index) => {
        const description =
          descriptions[index] ??
          "PDF text extraction was unavailable for this attachment."
        return `<attached_pdf filename="${escapeAttachmentFilenameForPrompt(attachment.filename)}">\n${description}\n</attached_pdf>`
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
