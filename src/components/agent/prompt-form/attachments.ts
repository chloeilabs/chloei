import {
  AGENT_ATTACHMENT_MAX_PREVIEW_DATA_URL_CHARS,
  type AgentAttachmentMimeType,
  normalizeAgentAttachmentMimeType,
} from "@/lib/shared"

const IMAGE_PREVIEW_MAX_EDGE = 160

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
