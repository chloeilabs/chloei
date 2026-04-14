const AI_SDK_INLINE_CITATION_INSTRUCTION = `
<ai_sdk_inline_citation_rules>
When Tavily tool results are used in the answer, cite them inline with markdown links, not only in a sources list.
- Place the citation immediately after the sentence or clause it supports.
- Prefer the exact \`citationMarkdown\` value returned in Tavily tool results when available.
- Use only URLs that came from tool results in this response.
- Do not emit bare URLs when a markdown link will do.
- Keep citations compact and natural. Usually one or two citations per paragraph is enough.
</ai_sdk_inline_citation_rules>
`.trim()

const AI_SDK_FMP_TOOLING_INSTRUCTION = `
<ai_sdk_fmp_tool_rules>
When FMP MCP tools are available:
- Prefer FMP for structured financial facts such as quotes, company profile data, historical prices, and financial statements.
- Prefer Tavily or other web tools for news, explanations, and source-backed claims that need clickable citations.
- Do not invent inline citations or source cards for FMP data unless the tool result itself clearly provides a canonical URL.
- Use the minimum mix of tools needed, then synthesize the answer around the evidence.
</ai_sdk_fmp_tool_rules>
`.trim()

export function withAiSdkInlineCitationInstruction(
  systemInstruction: string,
  options: {
    fmpEnabled?: boolean
  } = {}
): string {
  const instructionBlocks = [
    AI_SDK_INLINE_CITATION_INSTRUCTION,
    options.fmpEnabled ? AI_SDK_FMP_TOOLING_INSTRUCTION : null,
  ].filter((block): block is string => Boolean(block))

  return `${systemInstruction}\n\n${instructionBlocks.join("\n\n")}`
}
