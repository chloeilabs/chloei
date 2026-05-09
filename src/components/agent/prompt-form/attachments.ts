import { z } from "zod"

import {
  AGENT_ATTACHMENT_MAX_PREVIEW_DATA_URL_CHARS,
  AGENT_ATTACHMENT_MIME_TYPES,
  AGENT_IMAGE_DETAIL_VALUES,
  type AgentAttachmentKind,
  type AgentAttachmentMimeType,
  type AgentRequestAttachment,
  normalizeAgentAttachmentMimeType,
} from "@/lib/shared"

const IMAGE_PREVIEW_MAX_EDGE = 160
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/i

const UploadAttachmentResponseSchema = z.object({
  attachment: z.object({
    id: z.string().trim().min(1),
    kind: z.enum(["image", "pdf"] satisfies [
      AgentAttachmentKind,
      ...AgentAttachmentKind[],
    ]),
    filename: z.string().trim().min(1),
    mediaType: z.enum(AGENT_ATTACHMENT_MIME_TYPES),
    sizeBytes: z.number().int().nonnegative(),
    detail: z.enum(AGENT_IMAGE_DETAIL_VALUES).optional(),
    previewDataUrl: z.string().optional(),
    blobPathname: z.string().trim().min(1).optional(),
    sha256: z.string().trim().regex(SHA256_HEX_PATTERN).optional(),
    downloadUrl: z.string().trim().min(1).optional(),
  }),
})

export function formatFileSize(sizeBytes: number): string {
  if (sizeBytes < 1024) {
    return `${String(sizeBytes)} B`
  }

  if (sizeBytes < 1024 * 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`
  }

  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (event) => {
      const result = event.target?.result
      if (typeof result === "string") {
        resolve(result)
        return
      }

      reject(new Error("File could not be read."))
    }
    reader.onerror = () => {
      reject(new Error("File could not be read."))
    }
    reader.readAsDataURL(file)
  })
}

export async function createImagePreviewDataUrl(
  dataUrl: string
): Promise<string | undefined> {
  if (typeof window === "undefined") {
    return undefined
  }

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const nextImage = new window.Image()
      nextImage.onload = () => {
        resolve(nextImage)
      }
      nextImage.onerror = () => {
        reject(new Error("Image preview failed."))
      }
      nextImage.src = dataUrl
    })
    const longestEdge = Math.max(image.naturalWidth, image.naturalHeight)
    if (!longestEdge) {
      return undefined
    }

    const scale = Math.min(1, IMAGE_PREVIEW_MAX_EDGE / longestEdge)
    const width = Math.max(1, Math.round(image.naturalWidth * scale))
    const height = Math.max(1, Math.round(image.naturalHeight * scale))
    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext("2d")
    if (!context) {
      return undefined
    }

    context.drawImage(image, 0, 0, width, height)
    const previewDataUrl = canvas.toDataURL("image/jpeg", 0.72)
    return previewDataUrl.length <= AGENT_ATTACHMENT_MAX_PREVIEW_DATA_URL_CHARS
      ? previewDataUrl
      : undefined
  } catch {
    return undefined
  }
}

export function getNormalizedFileMediaType(
  file: File
): AgentAttachmentMimeType | null {
  return normalizeAgentAttachmentMimeType(file.type)
}

export async function uploadAttachmentFile(params: {
  file: File
  attachmentId: string
  previewDataUrl?: string
}): Promise<AgentRequestAttachment> {
  const formData = new FormData()
  formData.set("file", params.file)
  formData.set("attachmentId", params.attachmentId)

  const response = await fetch("/api/uploads", {
    method: "POST",
    body: formData,
  })
  if (!response.ok) {
    throw new Error("Attachment upload failed.")
  }

  const payload = UploadAttachmentResponseSchema.safeParse(
    await response.json()
  )
  if (!payload.success) {
    throw new Error("Attachment upload response was invalid.")
  }
  const attachment = payload.data.attachment

  return {
    ...attachment,
    ...(params.previewDataUrl ? { previewDataUrl: params.previewDataUrl } : {}),
  }
}
