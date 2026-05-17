import {
  getPrivateReasoningCarryLength,
  sanitizeReasoningForDisplay,
} from "@/lib/shared"

interface InitialReasoningChunkSanitizer {
  (text: string): string
  flush: () => string
}

interface ReasoningDisplaySanitizer {
  (text: string): string
  flush: () => string
}

export function createInitialReasoningChunkSanitizer() {
  let bufferedPrefix = ""
  let didResolvePrefix = false

  const sanitize = ((text: string): string => {
    if (didResolvePrefix) {
      return text
    }

    const combined = `${bufferedPrefix}${text}`.replace(/\r\n/g, "\n")
    const inlineLabelWithContentPattern =
      /^\s*(?:thinking|reasoning)\s*:\s*([\s\S]+)$/i
    const multilineLabelWithContentPattern =
      /^\s*(?:thinking|reasoning)\s*\n+([\s\S]+)$/i
    const labelOnlyPattern = /^\s*(?:thinking|reasoning)\s*:?\s*$/i
    const partialLabelPattern =
      /^\s*(?:t|th|thi|thin|think|thinki|thinkin|thinking|r|re|rea|reas|reaso|reason|reasoni|reasonin|reasoning)\s*:?\s*$/i

    const labelWithContentMatch =
      inlineLabelWithContentPattern.exec(combined) ??
      multilineLabelWithContentPattern.exec(combined)
    if (labelWithContentMatch) {
      bufferedPrefix = ""
      didResolvePrefix = true
      return labelWithContentMatch[1] ?? ""
    }

    if (
      combined.trim().length === 0 ||
      labelOnlyPattern.test(combined) ||
      (combined.trim().length <= 10 && partialLabelPattern.test(combined))
    ) {
      bufferedPrefix = combined
      return ""
    }

    bufferedPrefix = ""
    didResolvePrefix = true
    return combined
  }) as InitialReasoningChunkSanitizer

  sanitize.flush = () => {
    const text = bufferedPrefix
    bufferedPrefix = ""
    didResolvePrefix = true
    return /^\s*(?:thinking|reasoning)\s*:?\s*$/i.test(text) ? "" : text
  }

  return sanitize
}

export function createReasoningDisplaySanitizer(): ReasoningDisplaySanitizer {
  const sanitizeInitialChunk = createInitialReasoningChunkSanitizer()
  let carry = ""

  const sanitize = ((text: string): string => {
    const withoutInitialLabel = sanitizeInitialChunk(text)
    if (withoutInitialLabel.length === 0) {
      return ""
    }

    const combined = `${carry}${withoutInitialLabel}`
    const carryLength = getPrivateReasoningCarryLength(combined)
    const publicText =
      carryLength > 0 ? combined.slice(0, -carryLength) : combined

    carry = carryLength > 0 ? combined.slice(-carryLength) : ""

    return sanitizeReasoningForDisplay(publicText)
  }) as ReasoningDisplaySanitizer

  sanitize.flush = () => {
    const text = sanitizeReasoningForDisplay(
      `${carry}${sanitizeInitialChunk.flush()}`
    )
    carry = ""
    return text
  }

  return sanitize
}
