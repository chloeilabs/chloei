import { Buffer } from "node:buffer"
import { createHash, randomUUID } from "node:crypto"
import path from "node:path"

import { z } from "zod"

import { hashUserId } from "@/lib/server/privacy"

const SAFE_FILENAME_PATTERN = /[^A-Za-z0-9._-]+/g
const MAX_FILENAME_CHARS = 120
const ATTACHMENT_ID_SCHEMA = z.uuid()

interface PrivateBlobUploadResult {
  pathname: string
  url: string
  downloadUrl: string
  sha256: string
  sizeBytes: number
  contentType: string
}

interface PrivateBlobReadResult {
  buffer: Buffer
  contentType: string
  sizeBytes: number
  etag: string
}

export function isPrivateBlobConfigured(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN?.trim())
}

export function getPrivateBlobUserPrefix(userId: string): string {
  return `users/${hashUserId(userId).replace("sha256:", "")}`
}

export function normalizeBlobPathname(pathname: string): string | null {
  const normalized = pathname.trim().replaceAll("\\", "/")
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.startsWith("~/") ||
    normalized.includes("\0") ||
    /^[A-Za-z]:\//.test(normalized)
  ) {
    return null
  }

  const segments = normalized.split("/")
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null
  }

  return segments.join("/")
}

export function isUserOwnedBlobPathname(params: {
  pathname: string
  userId: string
}): boolean {
  const normalized = normalizeBlobPathname(params.pathname)
  return normalized
    ? normalized.startsWith(`${getPrivateBlobUserPrefix(params.userId)}/`)
    : false
}

function sanitizeFilename(filename: string): string {
  const parsed = path.parse(filename.trim() || "attachment")
  const baseName = (parsed.name || "attachment")
    .replace(SAFE_FILENAME_PATTERN, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_FILENAME_CHARS)
  const extension = parsed.ext.replace(SAFE_FILENAME_PATTERN, "").slice(0, 16)
  return `${baseName || "attachment"}${extension}`
}

export function buildPrivateBlobAttachmentPathname(params: {
  userId: string
  filename: string
  attachmentId?: string
}): string {
  const requestedAttachmentId = params.attachmentId?.trim()
  const attachmentId =
    requestedAttachmentId && requestedAttachmentId.length > 0
      ? ATTACHMENT_ID_SCHEMA.parse(requestedAttachmentId)
      : randomUUID()
  return `${getPrivateBlobUserPrefix(params.userId)}/attachments/${attachmentId}/${sanitizeFilename(params.filename)}`
}

export function buildAuthenticatedPrivateBlobDownloadUrl(
  pathname: string
): string | null {
  const normalized = normalizeBlobPathname(pathname)
  if (!normalized) {
    return null
  }

  return `/api/uploads/${normalized
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`
}

export async function uploadPrivateBlob(params: {
  pathname: string
  body: Buffer | Uint8Array | ArrayBuffer | Blob
  contentType: string
  signal?: AbortSignal
}): Promise<PrivateBlobUploadResult> {
  const pathname = normalizeBlobPathname(params.pathname)
  if (!pathname) {
    throw new Error("Invalid blob pathname.")
  }

  const buffer =
    params.body instanceof Buffer
      ? params.body
      : params.body instanceof Blob
        ? Buffer.from(await params.body.arrayBuffer())
        : params.body instanceof ArrayBuffer
          ? Buffer.from(params.body)
          : Buffer.from(params.body)
  const sha256 = createHash("sha256").update(buffer).digest("hex")
  const { put } = await import("@vercel/blob")
  const result = await put(pathname, buffer, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: false,
    cacheControlMaxAge: 60,
    contentType: params.contentType,
    abortSignal: params.signal,
  })

  const downloadUrl = buildAuthenticatedPrivateBlobDownloadUrl(result.pathname)
  if (!downloadUrl) {
    throw new Error("Invalid private blob download pathname.")
  }

  return {
    pathname: result.pathname,
    url: result.url,
    downloadUrl,
    sha256,
    sizeBytes: buffer.byteLength,
    contentType: result.contentType,
  }
}

async function streamToBuffer(
  stream: ReadableStream<Uint8Array>
): Promise<Buffer> {
  const chunks: Buffer[] = []
  const reader = stream.getReader()

  let next = await reader.read()
  while (!next.done) {
    const { value } = next
    chunks.push(Buffer.from(value))
    next = await reader.read()
  }

  return Buffer.concat(chunks)
}

export async function readPrivateBlob(params: {
  pathname: string
  userId: string
  signal?: AbortSignal
}): Promise<PrivateBlobReadResult | null> {
  const pathname = normalizeBlobPathname(params.pathname)
  if (
    !pathname ||
    !isUserOwnedBlobPathname({ pathname, userId: params.userId })
  ) {
    return null
  }

  const { get } = await import("@vercel/blob")
  const result = await get(pathname, {
    access: "private",
    useCache: false,
    abortSignal: params.signal,
  })
  if (result?.statusCode !== 200) {
    return null
  }

  return {
    buffer: await streamToBuffer(result.stream),
    contentType: result.blob.contentType,
    sizeBytes: result.blob.size,
    etag: result.blob.etag,
  }
}
