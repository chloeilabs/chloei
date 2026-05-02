const PSEUDO_TOOL_MARKER_PATTERN =
  /(?:<\s*\|\s*DSML\s*\||\|\s*DSML\s*\||tool_calls\s*>|invoke\s+name=|parameter\s+name=)/i
const PSEUDO_TOOL_BLOCK_START_PATTERN =
  /<\s*\|\s*DSML\s*\|\s*tool_calls\s*>/i
const PSEUDO_TOOL_BLOCK_END_PATTERN =
  /<\s*\|\s*DSML\s*\|\s*tool_calls\s*>/gi

function getLastPseudoToolBlockEndIndex(text: string): number | null {
  let lastEndIndex: number | null = null

  for (const match of text.matchAll(PSEUDO_TOOL_BLOCK_END_PATTERN)) {
    lastEndIndex = match.index + match[0].length
  }

  return lastEndIndex
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

    if (!isInsidePseudoToolBlock) {
      const startMatch = PSEUDO_TOOL_BLOCK_START_PATTERN.exec(combined)
      if (!startMatch) {
        return PSEUDO_TOOL_MARKER_PATTERN.test(combined) ? "" : combined
      }

      const beforeBlock = combined.slice(0, startMatch.index)
      const afterStart = combined.slice(startMatch.index + startMatch[0].length)
      const endIndex = getLastPseudoToolBlockEndIndex(afterStart)
      if (endIndex === null) {
        isInsidePseudoToolBlock = true
        return beforeBlock
      }

      return `${beforeBlock}${afterStart.slice(endIndex)}`
    }

    const endIndex = getLastPseudoToolBlockEndIndex(combined)
    if (endIndex === null) {
      return ""
    }

    isInsidePseudoToolBlock = false
    return combined.slice(endIndex)
  }
}
