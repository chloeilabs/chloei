export function createInitialReasoningChunkSanitizer() {
  let bufferedPrefix = ""
  let didResolvePrefix = false

  return (text: string): string => {
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
      (combined.length <= 16 && partialLabelPattern.test(combined))
    ) {
      bufferedPrefix = combined
      return ""
    }

    bufferedPrefix = ""
    didResolvePrefix = true
    return combined
  }
}
