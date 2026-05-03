const PSEUDO_TOOL_MARKER_PATTERN =
  /(?:<\s*\|\s*DSML\s*\||\|\s*DSML\s*\||tool_calls\s*>|invoke\s+name=|parameter\s+name=)/i
const PSEUDO_TOOL_BLOCK_BOUNDARY_PATTERN =
  /<\s*\|\s*DSML\s*\|\s*tool_calls\s*>/i
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

export interface ToolCallTextSanitizer {
  (text: string): string
  flush: () => string
}

function getPseudoToolBlockBoundary(text: string): RegExpExecArray | null {
  return PSEUDO_TOOL_BLOCK_BOUNDARY_PATTERN.exec(text)
}

function getPseudoToolMarkerMatch(text: string): RegExpExecArray | null {
  const match = PSEUDO_TOOL_MARKER_PATTERN.exec(text)
  if (!match) {
    return null
  }

  if (match[0].toLowerCase().includes("dsml")) {
    return match
  }

  return text.slice(0, match.index).trim().length === 0 ? match : null
}

function isDsmlPseudoToolMarker(match: RegExpExecArray): boolean {
  return match[0].toLowerCase().includes("dsml")
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

export function createToolCallTextSanitizer(): ToolCallTextSanitizer {
  let isInsidePseudoToolBlock = false
  let bufferedPrefix = ""

  const sanitize = ((text: string): string => {
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

    let remaining = combined
    let output = ""

    while (remaining) {
      if (!isInsidePseudoToolBlock) {
        const blockBoundary = getPseudoToolBlockBoundary(remaining)
        const markerMatch = getPseudoToolMarkerMatch(remaining)
        if (!blockBoundary) {
          output +=
            markerMatch && isDsmlPseudoToolMarker(markerMatch)
              ? remaining.slice(0, markerMatch.index)
              : remaining
          return returnWithBufferedPrefix(output)
        }

        if (markerMatch && markerMatch.index < blockBoundary.index) {
          output += remaining.slice(0, markerMatch.index)
          return returnWithBufferedPrefix(output)
        }

        output += remaining.slice(0, blockBoundary.index)
        remaining = remaining.slice(
          blockBoundary.index + blockBoundary[0].length
        )
        isInsidePseudoToolBlock = true
      }

      const endBoundary = getPseudoToolBlockBoundary(remaining)
      if (!endBoundary) {
        bufferedPrefix = splitTrailingPseudoToolMarkerPrefix(remaining).prefix
        return output
      }

      remaining = remaining.slice(endBoundary.index + endBoundary[0].length)
      isInsidePseudoToolBlock = false
    }

    return returnWithBufferedPrefix(output)
  }) as ToolCallTextSanitizer

  sanitize.flush = (): string => {
    const flushed = isInsidePseudoToolBlock ? "" : bufferedPrefix
    bufferedPrefix = ""
    isInsidePseudoToolBlock = false
    return flushed
  }

  return sanitize
}
