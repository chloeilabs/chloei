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
- Prefer the normalized \`finance_data\` tool for structured financial facts such as quotes, company profile data, historical prices, financial statements, SEC company facts, and FRED macro/rates data.
- When answering provider/capability availability questions, use \`finance_data\` \`provider_status\` and do not run follow-up probes for providers reported unavailable.
- For quote/profile requests, use \`finance_data\` provider \`auto\` before search; this can use structured Stooq quote data and SEC company submissions when FMP is unavailable.
- For statement requests, use \`finance_data\` \`financial_statements\` provider \`auto\` with \`statementType\` set to \`income\`, \`balance_sheet\`, or \`cash_flow\` before search; this can use SEC company facts when FMP is unavailable. Use code execution for the arithmetic when margins, growth rates, free cash flow, leverage ratios, or comparisons are requested.
- For 10-K/10-Q prompts asking for cash flow, capex, liabilities, debt, assets, equity, or balance-sheet items, call \`finance_data\` first. The statement result includes SEC company-facts and filing source URLs when available; cite those directly. Search EDGAR pages only for narrative context or facts missing from structured data.
- Use legacy FMP MCP tools only when a needed FMP operation is not exposed through \`finance_data\`.
- Prefer native \`web_search\` for broad, fresh web discovery.
- Prefer Tavily for controlled retrieval, extraction, and clickable inline citations from specific pages.
- Do not invent inline citations or source cards for FMP data unless the tool result itself clearly provides a canonical URL.
- Use code execution only for calculation or validation.
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
