const PSEUDO_TOOL_MARKER_PATTERN =
  /(?:<\s*\|\s*DSML\s*\||\|\s*DSML\s*\||tool_calls\s*>|invoke\s+name=|parameter\s+name=)/i
const PSEUDO_TOOL_BLOCK_START_PATTERN = /<\s*\|\s*DSML\s*\|\s*tool_calls\s*>/i
const PSEUDO_TOOL_BLOCK_END_PATTERN = /<\s*\|\s*DSML\s*\|\s*tool_calls\s*>/gi
const PSEUDO_TOOL_MARKER_PREFIXES = [
  "<|DSML|tool_calls>",
  "<|DSML|invoke",
  "<|DSML|parameter",
  "|DSML|",
  "tool_calls>",
  "invoke name=",
  "parameter name=",
] as const
const PSEUDO_TOOL_MARKER_PREFIX_MAX_CHARS = 64

function getLastPseudoToolBlockEndIndex(text: string): number | null {
  let lastEndIndex: number | null = null

  for (const match of text.matchAll(PSEUDO_TOOL_BLOCK_END_PATTERN)) {
    lastEndIndex = match.index + match[0].length
  }

  return lastEndIndex
}

function normalizeMarkerPrefix(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase()
}

function isPotentialPseudoToolMarkerPrefix(value: string): boolean {
  const trimmed = value.trimStart()
  const normalized = normalizeMarkerPrefix(trimmed)
  if (!normalized) {
    return false
  }

  const couldMatchMarker = PSEUDO_TOOL_MARKER_PREFIXES.some((prefix) =>
    normalizeMarkerPrefix(prefix).startsWith(normalized)
  )
  if (!couldMatchMarker) {
    return false
  }

  if (trimmed.startsWith("<") || trimmed.startsWith("|")) {
    return true
  }

  return (
    normalized.startsWith("tool") ||
    normalized.startsWith("invo") ||
    normalized.startsWith("para")
  )
}

function splitTrailingPseudoToolMarkerPrefix(text: string): {
  output: string
  prefix: string
} {
  const minStart = Math.max(
    0,
    text.length - PSEUDO_TOOL_MARKER_PREFIX_MAX_CHARS
  )

  for (let start = minStart; start < text.length; start += 1) {
    const prefix = text.slice(start)
    if (isPotentialPseudoToolMarkerPrefix(prefix)) {
      const trimmedPrefix = prefix.trimStart()
      const leadingWhitespace = prefix.slice(
        0,
        prefix.length - trimmedPrefix.length
      )
      return {
        output: `${text.slice(0, start)}${leadingWhitespace}`,
        prefix: trimmedPrefix,
      }
    }
  }

  return { output: text, prefix: "" }
}

export function createToolCallTextSanitizer() {
  let isInsidePseudoToolBlock = false
  let bufferedPrefix = ""

  return (text: string): string => {
    if (!text) {
      return ""
    }

    const combined = `${bufferedPrefix}${text}`
    bufferedPrefix = ""
    const returnWithBufferedPrefix = (value: string): string => {
      const split = splitTrailingPseudoToolMarkerPrefix(value)
      bufferedPrefix = split.prefix
      return split.output
    }

    if (!isInsidePseudoToolBlock) {
      const startMatch = PSEUDO_TOOL_BLOCK_START_PATTERN.exec(combined)
      if (!startMatch) {
        const markerMatch = PSEUDO_TOOL_MARKER_PATTERN.exec(combined)
        return markerMatch
          ? returnWithBufferedPrefix(combined.slice(0, markerMatch.index))
          : returnWithBufferedPrefix(combined)
      }

      const beforeBlock = combined.slice(0, startMatch.index)
      const afterStart = combined.slice(startMatch.index + startMatch[0].length)
      const endIndex = getLastPseudoToolBlockEndIndex(afterStart)
      if (endIndex === null) {
        isInsidePseudoToolBlock = true
        return returnWithBufferedPrefix(beforeBlock)
      }

      return returnWithBufferedPrefix(
        `${beforeBlock}${afterStart.slice(endIndex)}`
      )
    }

    const endIndex = getLastPseudoToolBlockEndIndex(combined)
    if (endIndex === null) {
      const split = splitTrailingPseudoToolMarkerPrefix(combined)
      bufferedPrefix = split.prefix
      return ""
    }

    isInsidePseudoToolBlock = false
    return returnWithBufferedPrefix(combined.slice(endIndex))
  }
}
