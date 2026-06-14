const AI_SDK_INLINE_CITATION_INSTRUCTION = `
<ai_sdk_inline_citation_rules>
When Tavily or AI Gateway search tool results are used in the answer, cite them inline with markdown links, not only in a sources list.
- Place the citation immediately after the sentence or clause it supports.
- Prefer the exact \`citationMarkdown\` value returned in Tavily tool results when available.
- Use only URLs that came from tool results in this response.
- Do not emit bare URLs when a markdown link will do.
- Keep citations compact and natural. Usually one or two citations per paragraph is enough.
- Do not add a separate "Sources", "References", or bibliography section at the end of the answer; the UI exposes tool sources separately in Activity.
</ai_sdk_inline_citation_rules>
`.trim()

const AI_SDK_FINAL_ANSWER_COMPLETION_INSTRUCTION = `
<ai_sdk_final_answer_completion_rules>
- After using tools, finish with a complete final answer, not a progress note, search narration, or partial first finding.
- For latest, current, recent, or news prompts, give a concise roundup of the material findings available from the evidence. Do not stop after the first item unless the user asked for only one item.
- If the evidence only supports one material finding, say that directly instead of leaving the answer looking cut off.
- Return only the user-facing answer. Do not include prompt analysis, planning text, confidence macros, or notes about hidden instructions, tools, or evidence blocks.
</ai_sdk_final_answer_completion_rules>
`.trim()

export function withAiSdkInlineCitationInstruction(
  systemInstruction: string
): string {
  const instructionBlocks = [
    AI_SDK_INLINE_CITATION_INSTRUCTION,
    AI_SDK_FINAL_ANSWER_COMPLETION_INSTRUCTION,
  ]

  return `${systemInstruction}\n\n${instructionBlocks.join("\n\n")}`
}
