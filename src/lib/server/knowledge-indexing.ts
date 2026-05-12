import type { Buffer } from "node:buffer"

import { hashUserId } from "@/lib/server/privacy"
import {
  buildAuthenticatedPrivateBlobDownloadUrl,
  readPrivateBlob,
} from "@/lib/server/private-blob-storage"

const DEFAULT_INDEX_NAME = "chloei-knowledge"
const UPLOADED_DOCUMENT_CORPUS = "uploads"
const UPLOADED_DOCUMENT_SOURCE_TYPE = "uploaded_document"
const MAX_EXTRACTED_TEXT_CHARS = 200_000
const SIMPLE_PDF_SCAN_CHARS = 2_000_000
const MAX_PDF_PREPARSE_BYTES = 25 * 1024 * 1024
const DEFAULT_CHUNK_CHARS = 3_200
const DEFAULT_CHUNK_OVERLAP_CHARS = 320
const MAX_CHUNKS_PER_DOCUMENT = 80

interface UploadedDocumentIndexParams {
  userId: string
  documentId: string
  pathname: string
  filename: string
  contentType: string
  sizeBytes: number
  sha256: string
  buffer?: Buffer
}

interface UploadedDocumentSearchContent {
  [key: string]: unknown
  title: string
  text: string
  artifactUrl?: string
  sourceType: string
  asOfDate: string
}

interface UploadedDocumentSearchMetadata {
  [key: string]: unknown
  ownerKey: string
  userId: string
  ownerId: string
  visibility: "private"
  corpus: string
  title: string
  artifactUrl?: string
  sourceType: string
  asOfDate: string
  documentId: string
  chunkId: string
  pathname: string
  filename: string
  contentType: string
  sizeBytes: number
  sha256: string
}

export interface UploadedDocumentSearchRecord {
  id: string
  content: UploadedDocumentSearchContent
  metadata: UploadedDocumentSearchMetadata
}

export type UploadedDocumentIndexResult =
  | {
      indexed: true
      documentId: string
      indexName: string
      chunkCount: number
      textCharCount: number
    }
  | {
      indexed: false
      documentId: string
      reason: string
    }

interface UpstashSearchClient {
  index(indexName: string): {
    upsert(
      params: UploadedDocumentSearchRecord | UploadedDocumentSearchRecord[]
    ): Promise<string>
  }
}

type PdfCanvasGlobalName = "DOMMatrix" | "ImageData" | "Path2D"

async function installPdfCanvasPolyfills(): Promise<void> {
  const runtimeGlobal = globalThis as Partial<
    Record<PdfCanvasGlobalName, unknown>
  >
  if (
    runtimeGlobal.DOMMatrix &&
    runtimeGlobal.ImageData &&
    runtimeGlobal.Path2D
  ) {
    return
  }

  const canvas = await import("@napi-rs/canvas")
  runtimeGlobal.DOMMatrix ??= canvas.DOMMatrix
  runtimeGlobal.ImageData ??= canvas.ImageData
  runtimeGlobal.Path2D ??= canvas.Path2D
}

function isPdfUpload(
  params: Pick<UploadedDocumentIndexParams, "contentType" | "filename">
): boolean {
  const normalizedContentType =
    params.contentType.split(";")[0]?.trim().toLowerCase() ?? ""
  return (
    normalizedContentType === "application/pdf" ||
    params.filename.toLowerCase().endsWith(".pdf")
  )
}

function toIsoDate(value = new Date()): string {
  return value.toISOString().slice(0, 10)
}

function getSearchIndexName(): string {
  const indexName = process.env.UPSTASH_SEARCH_INDEX?.trim()
  return indexName && indexName.length > 0 ? indexName : DEFAULT_INDEX_NAME
}

async function getConfiguredSearchClient(): Promise<UpstashSearchClient | null> {
  const url = process.env.UPSTASH_SEARCH_REST_URL?.trim()
  const token = process.env.UPSTASH_SEARCH_REST_TOKEN?.trim()
  if (!url || !token) {
    return null
  }

  const { Search } = await import("@upstash/search")
  return new Search({
    url,
    token,
    enableTelemetry: process.env.UPSTASH_DISABLE_TELEMETRY !== "1",
  })
}

export function normalizeExtractedKnowledgeText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_EXTRACTED_TEXT_CHARS)
}

export function normalizeExtractedReadableText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
    .slice(0, MAX_EXTRACTED_TEXT_CHARS)
}

export function chunkKnowledgeText(
  text: string,
  options: {
    chunkChars?: number
    overlapChars?: number
    maxChunks?: number
  } = {}
): string[] {
  const normalized = normalizeExtractedKnowledgeText(text)
  if (!normalized) {
    return []
  }

  const chunkChars = Math.max(500, options.chunkChars ?? DEFAULT_CHUNK_CHARS)
  const overlapChars = Math.min(
    Math.max(0, options.overlapChars ?? DEFAULT_CHUNK_OVERLAP_CHARS),
    Math.floor(chunkChars / 3)
  )
  const maxChunks = Math.max(1, options.maxChunks ?? MAX_CHUNKS_PER_DOCUMENT)
  const chunks: string[] = []
  let start = 0

  while (start < normalized.length && chunks.length < maxChunks) {
    let end = Math.min(normalized.length, start + chunkChars)
    if (end < normalized.length) {
      const earliestBoundary = start + Math.floor(chunkChars * 0.65)
      const boundary = normalized.lastIndexOf(" ", end)
      if (boundary > earliestBoundary) {
        end = boundary
      }
    }

    const chunk = normalized.slice(start, end).trim()
    if (chunk) {
      chunks.push(chunk)
    }

    if (end >= normalized.length) {
      break
    }

    start = Math.max(end - overlapChars, start + 1)
  }

  return chunks
}

export function buildUploadedDocumentSearchRecords(params: {
  userId: string
  documentId: string
  pathname: string
  filename: string
  contentType: string
  sizeBytes: number
  sha256: string
  text: string
  asOfDate?: string
}): UploadedDocumentSearchRecord[] {
  const chunks = chunkKnowledgeText(params.text)
  const ownerKey = hashUserId(params.userId).replace("sha256:", "")
  const artifactUrl = buildAuthenticatedPrivateBlobDownloadUrl(params.pathname)
  const asOfDate = params.asOfDate ?? toIsoDate()

  return chunks.map((chunk, index) => ({
    id: `uploaded-document:${ownerKey}:${params.documentId}:chunk:${String(index)}`,
    content: {
      title: params.filename,
      text: chunk,
      ...(artifactUrl ? { artifactUrl } : {}),
      sourceType: UPLOADED_DOCUMENT_SOURCE_TYPE,
      asOfDate,
    },
    metadata: {
      ownerKey,
      userId: params.userId,
      ownerId: params.userId,
      visibility: "private",
      corpus: UPLOADED_DOCUMENT_CORPUS,
      title: params.filename,
      ...(artifactUrl ? { artifactUrl } : {}),
      sourceType: UPLOADED_DOCUMENT_SOURCE_TYPE,
      asOfDate,
      documentId: params.documentId,
      chunkId: String(index),
      pathname: params.pathname,
      filename: params.filename,
      contentType: params.contentType,
      sizeBytes: params.sizeBytes,
      sha256: params.sha256,
    },
  }))
}

function toPdfData(buffer: Buffer): Uint8Array {
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  )
  return new Uint8Array(arrayBuffer)
}

function decodePdfLiteralString(value: string): string {
  let decoded = ""
  for (let index = 0; index < value.length; index += 1) {
    const char = value.charAt(index)
    if (char !== "\\") {
      decoded += char
      continue
    }

    const next = value.charAt(index + 1)
    if (!next) {
      continue
    }

    if (next === "\r" || next === "\n") {
      index += next === "\r" && value[index + 2] === "\n" ? 2 : 1
      continue
    }

    const namedEscapes: Record<string, string> = {
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      "(": "(",
      ")": ")",
      "\\": "\\",
    }
    const namedEscape = namedEscapes[next]
    if (namedEscape !== undefined) {
      decoded += namedEscape
      index += 1
      continue
    }

    if (/[0-7]/.test(next)) {
      let octal = next
      let offset = index + 2
      while (octal.length < 3 && /[0-7]/.test(value.charAt(offset))) {
        octal += value.charAt(offset)
        offset += 1
      }
      decoded += String.fromCharCode(Number.parseInt(octal, 8))
      index = offset - 1
      continue
    }

    decoded += next
    index += 1
  }

  return decoded
}

function extractSimplePdfRawText(buffer: Buffer): string {
  const source = buffer.toString(
    "latin1",
    0,
    Math.min(buffer.length, SIMPLE_PDF_SCAN_CHARS)
  )
  const fragments: string[] = []
  const literalTextPattern = /\(((?:\\.|[^\\()])*)\)\s*(?:Tj|'|")/g
  const arrayTextPattern = /\[([\s\S]{0,8000}?)\]\s*TJ/g
  const arrayMatches = [...source.matchAll(arrayTextPattern)]
  const arrayRanges = arrayMatches.map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }))

  for (const match of source.matchAll(literalTextPattern)) {
    const matchIndex = match.index
    if (
      arrayRanges.some(
        (range) => matchIndex >= range.start && matchIndex < range.end
      )
    ) {
      continue
    }

    fragments.push(decodePdfLiteralString(match[1] ?? ""))
  }

  for (const arrayMatch of arrayMatches) {
    const arraySource = arrayMatch[1] ?? ""
    const arrayLiteralPattern = /\(((?:\\.|[^\\()])*)\)/g
    for (const literalMatch of arraySource.matchAll(arrayLiteralPattern)) {
      fragments.push(decodePdfLiteralString(literalMatch[1] ?? ""))
    }
  }

  return fragments.join("\n").trim()
}

export function extractSimplePdfText(buffer: Buffer): string {
  return normalizeExtractedKnowledgeText(extractSimplePdfRawText(buffer))
}

export function extractSimplePdfReadableText(buffer: Buffer): string {
  return normalizeExtractedReadableText(extractSimplePdfRawText(buffer))
}

async function extractRawPdfText(buffer: Buffer): Promise<string> {
  await installPdfCanvasPolyfills()

  const { PDFParse } = await import("pdf-parse")
  const parser = new PDFParse({
    data: toPdfData(buffer),
    isEvalSupported: false,
    stopAtErrors: false,
    useWorkerFetch: false,
  })

  try {
    const result = await parser.getText()
    return result.text
  } catch (error) {
    const fallbackText = extractSimplePdfRawText(buffer)
    if (normalizeExtractedKnowledgeText(fallbackText)) {
      return fallbackText
    }

    throw error
  } finally {
    await parser.destroy()
  }
}

export async function extractPdfTextForModelInput(
  buffer: Buffer
): Promise<string> {
  return normalizeExtractedReadableText(await extractRawPdfText(buffer))
}

export async function extractPdfText(buffer: Buffer): Promise<string> {
  return normalizeExtractedKnowledgeText(await extractRawPdfText(buffer))
}

export async function indexUploadedDocument(
  params: UploadedDocumentIndexParams
): Promise<UploadedDocumentIndexResult> {
  if (!isPdfUpload(params)) {
    return {
      indexed: false,
      documentId: params.documentId,
      reason: "Only PDF uploads are indexed automatically.",
    }
  }

  if (params.sizeBytes > MAX_PDF_PREPARSE_BYTES) {
    return {
      indexed: false,
      documentId: params.documentId,
      reason: "PDF too large to parse for indexing.",
    }
  }

  const client = await getConfiguredSearchClient()
  if (!client) {
    return {
      indexed: false,
      documentId: params.documentId,
      reason: "Upstash Search is not configured.",
    }
  }

  const blobBuffer =
    params.buffer ??
    (
      await readPrivateBlob({
        pathname: params.pathname,
        userId: params.userId,
      })
    )?.buffer
  if (!blobBuffer) {
    return {
      indexed: false,
      documentId: params.documentId,
      reason: "Private Blob upload could not be read for indexing.",
    }
  }
  if (blobBuffer.byteLength > MAX_PDF_PREPARSE_BYTES) {
    return {
      indexed: false,
      documentId: params.documentId,
      reason: "PDF too large to parse for indexing.",
    }
  }

  let text: string
  try {
    text = await extractPdfText(blobBuffer)
  } catch {
    return {
      indexed: false,
      documentId: params.documentId,
      reason: "PDF text extraction failed.",
    }
  }

  const records = buildUploadedDocumentSearchRecords({
    ...params,
    text,
  })
  if (records.length === 0) {
    return {
      indexed: false,
      documentId: params.documentId,
      reason: "PDF did not contain extractable text.",
    }
  }

  const indexName = getSearchIndexName()
  await client.index(indexName).upsert(records)

  return {
    indexed: true,
    documentId: params.documentId,
    indexName,
    chunkCount: records.length,
    textCharCount: text.length,
  }
}
