// Stub for ./openai-agents-exa-tools used by agent-stream-mapping / goblins
// tests. The real module imports exa-js (CJS transitive deps that the test
// loader's resolver hook can't traverse). These helpers are pure and mirror the
// real shapes closely enough to exercise the mapper's branching.

export function isExaToolName(value) {
  return value === "exa_search" || value === "exa_get_contents"
}

export function getExaToolCallMetadata(part) {
  if (!part || !isExaToolName(part.toolName)) {
    return null
  }
  const query = part.toolName === "exa_search" ? part.input?.query : undefined
  return {
    callId: part.toolCallId,
    toolName: part.toolName,
    label: part.toolName === "exa_search" ? "Web search" : "Read pages",
    ...(query ? { query } : {}),
    operation: part.toolName === "exa_search" ? "search" : "get_contents",
    provider: "exa",
  }
}

export function getExaToolResultMetadata(part) {
  if (!part || !isExaToolName(part.toolName)) {
    return null
  }
  const results = part.output?.output?.results
  const sources = Array.isArray(results)
    ? results.map((result, index) => ({
        id: `${part.toolName}-${index}`,
        url: result.url,
        title: result.title ?? result.url,
      }))
    : []
  return {
    callId: part.toolCallId,
    toolName: part.toolName,
    status: "success",
    sources,
    operation: part.toolName === "exa_search" ? "search" : "get_contents",
    provider: "exa",
  }
}

export function createOpenAiAgentsExaTools() {
  return []
}

export function createSharedResearchState() {
  return { seenUrls: new Set(), contentByUrl: new Map() }
}
