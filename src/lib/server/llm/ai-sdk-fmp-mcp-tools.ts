import { createMCPClient, type ListToolsResult } from "@ai-sdk/mcp"
import { jsonSchema, type ToolSet } from "ai"

import { asRecord, asString } from "@/lib/cast"
import type { MessageSource, ToolName } from "@/lib/shared"

const FMP_MCP_TOOL_NAME = "fmp_mcp" as const
const FMP_MCP_SERVER_URL = "https://financialmodelingprep.com/mcp"
const FMP_MCP_LIST_TOOLS_PAGE_LIMIT = 20
const FMP_MCP_LIST_TOOLS_TIMEOUT_MS = 15_000

type FmpToolName = Extract<ToolName, typeof FMP_MCP_TOOL_NAME>
type FmpDiscoveredTool = ListToolsResult["tools"][number]

interface AiSdkFmpMcpToolCallMetadata {
  callId: string
  toolName: FmpToolName
  label: string
}

interface AiSdkFmpMcpToolResultMetadata {
  callId: string
  toolName: FmpToolName
  status: "success" | "error"
  sources: MessageSource[]
}

interface CuratedFmpToolConfig {
  remoteToolName: string
  baseLabel: string
  curatedDescription: string
  allowedEndpoints?: readonly string[]
  endpointLabels?: Readonly<Record<string, string>>
}

interface AiSdkFmpMcpToolsContext {
  tools: ToolSet
  close: () => Promise<void>
  isToolName: (value: unknown) => value is string
  getToolCallMetadata: (
    part:
      | {
          toolCallId: string
          toolName: string
          input: unknown
        }
      | undefined
  ) => AiSdkFmpMcpToolCallMetadata | null
  getToolResultMetadata: (
    part:
      | {
          toolCallId: string
          toolName: string
          output: unknown
        }
      | undefined
  ) => AiSdkFmpMcpToolResultMetadata | null
}

interface WrappedFmpTool {
  execute: (input: unknown, options: unknown) => Promise<unknown>
  description?: string
  inputSchema?: unknown
  outputSchema?: unknown
  toModelOutput?: unknown
  [key: string]: unknown
}

const FMP_CURATED_TOOLS: readonly CuratedFmpToolConfig[] = [
  {
    remoteToolName: "search",
    baseLabel: "FMP: company search",
    curatedDescription:
      "Search public companies and stock symbols with FMP. Only the `search-name` and `search-symbol` endpoints are enabled in Yurie.",
    allowedEndpoints: ["search-name", "search-symbol"],
    endpointLabels: {
      "search-name": "FMP: company search",
      "search-symbol": "FMP: symbol search",
    },
  },
  {
    remoteToolName: "quote",
    baseLabel: "FMP: quote",
    curatedDescription:
      "Get structured equity quote data with FMP. Only the `quote`, `quote-short`, `batch-quote`, and `batch-quote-short` endpoints are enabled in Yurie.",
    allowedEndpoints: [
      "quote",
      "quote-short",
      "batch-quote",
      "batch-quote-short",
    ],
    endpointLabels: {
      quote: "FMP: quote",
      "quote-short": "FMP: quote",
      "batch-quote": "FMP: quote",
      "batch-quote-short": "FMP: quote",
    },
  },
  {
    remoteToolName: "company",
    baseLabel: "FMP: company profile",
    curatedDescription:
      "Get company profile data with FMP. Only the `profile-symbol` and `profile-cik` endpoints are enabled in Yurie.",
    allowedEndpoints: ["profile-symbol", "profile-cik"],
    endpointLabels: {
      "profile-symbol": "FMP: company profile",
      "profile-cik": "FMP: company profile",
    },
  },
  {
    remoteToolName: "chart",
    baseLabel: "FMP: historical prices",
    curatedDescription:
      "Get historical and intraday equity price charts with FMP. Only stock chart endpoints are enabled in Yurie.",
    allowedEndpoints: [
      "historical-price-eod-dividend-adjusted",
      "historical-price-eod-full",
      "historical-price-eod-light",
      "historical-price-eod-non-split-adjusted",
      "intraday-1-hour",
      "intraday-1-min",
      "intraday-15-min",
      "intraday-30-min",
      "intraday-4-hour",
      "intraday-5-min",
    ],
    endpointLabels: {
      "historical-price-eod-dividend-adjusted": "FMP: historical prices",
      "historical-price-eod-full": "FMP: historical prices",
      "historical-price-eod-light": "FMP: historical prices",
      "historical-price-eod-non-split-adjusted": "FMP: historical prices",
      "intraday-1-hour": "FMP: historical prices",
      "intraday-1-min": "FMP: historical prices",
      "intraday-15-min": "FMP: historical prices",
      "intraday-30-min": "FMP: historical prices",
      "intraday-4-hour": "FMP: historical prices",
      "intraday-5-min": "FMP: historical prices",
    },
  },
  {
    remoteToolName: "statements",
    baseLabel: "FMP: financial statements",
    curatedDescription:
      "Get structured financial statements with FMP. Only the `income-statement`, `balance-sheet-statement`, and `cashflow-statement` endpoints are enabled in Yurie.",
    allowedEndpoints: [
      "income-statement",
      "balance-sheet-statement",
      "cashflow-statement",
    ],
    endpointLabels: {
      "income-statement": "FMP: income statement",
      "balance-sheet-statement": "FMP: balance sheet",
      "cashflow-statement": "FMP: cash flow",
    },
  },
] as const

const FMP_CURATED_TOOL_BY_NAME = new Map(
  FMP_CURATED_TOOLS.map((tool) => [tool.remoteToolName, tool] as const)
)

let cachedCuratedDefinitions: ListToolsResult | null = null
const loggedFmpMessages = new Set<string>()

function logFmpOnce(key: string, level: "warn" | "error", message: string) {
  if (loggedFmpMessages.has(key)) {
    return
  }

  loggedFmpMessages.add(key)
  const payload = `[fmp-mcp] ${message}`

  if (level === "error") {
    console.error(payload)
    return
  }

  console.warn(payload)
}

function getEndpointFromInput(input: unknown): string | null {
  return asString(asRecord(input)?.endpoint)?.trim() ?? null
}

function getLabelForToolCall(toolName: string, input: unknown): string {
  const config = FMP_CURATED_TOOL_BY_NAME.get(toolName)
  if (!config) {
    return `FMP: ${toolName}`
  }

  const endpoint = getEndpointFromInput(input)
  if (endpoint && config.endpointLabels?.[endpoint]) {
    return config.endpointLabels[endpoint]
  }

  return config.baseLabel
}

function isFmpToolError(value: unknown): boolean {
  const record = asRecord(value)
  if (!record) {
    return false
  }

  return record.isError === true
}

function dedupeToolsByName(
  tools: readonly FmpDiscoveredTool[]
): FmpDiscoveredTool[] {
  const seenNames = new Set<string>()
  const deduped: FmpDiscoveredTool[] = []

  for (const tool of tools) {
    if (seenNames.has(tool.name)) {
      continue
    }

    seenNames.add(tool.name)
    deduped.push(tool)
  }

  return deduped
}

async function listAllTools(client: {
  listTools: (options?: {
    params?: { cursor?: string }
    options?: { timeout?: number }
  }) => Promise<ListToolsResult>
}): Promise<ListToolsResult> {
  const allTools: FmpDiscoveredTool[] = []
  let cursor: string | undefined

  for (let page = 0; page < FMP_MCP_LIST_TOOLS_PAGE_LIMIT; page += 1) {
    const result = await client.listTools({
      ...(cursor ? { params: { cursor } } : {}),
      options: {
        timeout: FMP_MCP_LIST_TOOLS_TIMEOUT_MS,
      },
    })

    allTools.push(...result.tools)

    if (!result.nextCursor) {
      return {
        tools: dedupeToolsByName(allTools),
      }
    }

    cursor = result.nextCursor
  }

  logFmpOnce(
    "list-tools-page-limit",
    "warn",
    `Stopped tool discovery after ${String(FMP_MCP_LIST_TOOLS_PAGE_LIMIT)} pages.`
  )

  return {
    tools: dedupeToolsByName(allTools),
  }
}

async function getCuratedDefinitions(client: {
  listTools: (options?: {
    params?: { cursor?: string }
    options?: { timeout?: number }
  }) => Promise<ListToolsResult>
}): Promise<ListToolsResult> {
  if (cachedCuratedDefinitions) {
    return cachedCuratedDefinitions
  }

  const discoveredDefinitions = await listAllTools(client)
  const definitionsByName = new Map(
    discoveredDefinitions.tools.map((tool) => [tool.name, tool] as const)
  )
  const curatedTools: FmpDiscoveredTool[] = []

  for (const config of FMP_CURATED_TOOLS) {
    const definition = definitionsByName.get(config.remoteToolName)
    if (!definition) {
      logFmpOnce(
        `missing-tool:${config.remoteToolName}`,
        "warn",
        `Unable to find the expected FMP MCP tool "${config.remoteToolName}".`
      )
      continue
    }

    curatedTools.push({
      ...definition,
      description: config.curatedDescription,
    })
  }

  cachedCuratedDefinitions = {
    tools: curatedTools,
  }

  return cachedCuratedDefinitions
}

function assertEndpointAllowed(
  config: CuratedFmpToolConfig,
  input: unknown
): void {
  if (!config.allowedEndpoints || config.allowedEndpoints.length === 0) {
    return
  }

  const endpoint = getEndpointFromInput(input)
  if (!endpoint) {
    throw new Error(
      `${config.baseLabel} requires an \`endpoint\` argument. Allowed endpoints: ${config.allowedEndpoints.join(", ")}.`
    )
  }

  if (!config.allowedEndpoints.includes(endpoint)) {
    throw new Error(
      `${config.baseLabel} only supports these endpoints in Yurie: ${config.allowedEndpoints.join(", ")}. Received: ${endpoint}.`
    )
  }
}

function restrictInputSchema(
  config: CuratedFmpToolConfig,
  inputSchema: unknown
): unknown {
  if (!config.allowedEndpoints || config.allowedEndpoints.length === 0) {
    return inputSchema
  }

  const schemaRecord = asRecord(asRecord(inputSchema)?.jsonSchema)
  const propertiesRecord = asRecord(schemaRecord?.properties)
  const endpointRecord = asRecord(propertiesRecord?.endpoint)
  if (!schemaRecord || !propertiesRecord || !endpointRecord) {
    return inputSchema
  }

  return jsonSchema({
    ...schemaRecord,
    properties: {
      ...propertiesRecord,
      endpoint: {
        ...endpointRecord,
        enum: [...config.allowedEndpoints],
        description: `Allowed endpoints in Yurie: ${config.allowedEndpoints.join(", ")}.`,
      },
    },
  })
}

function wrapCuratedTools(
  tools: ToolSet,
  remoteToolNames: readonly string[]
): ToolSet {
  const wrappedEntries = remoteToolNames.flatMap((toolName) => {
    const remoteTool = tools[toolName] as WrappedFmpTool | undefined
    const config = FMP_CURATED_TOOL_BY_NAME.get(toolName)
    if (!remoteTool || !config) {
      return []
    }

    const wrappedTool: WrappedFmpTool = {
      ...remoteTool,
      description: config.curatedDescription,
      inputSchema: restrictInputSchema(config, remoteTool.inputSchema),
      execute: async (input: unknown, options: unknown) => {
        assertEndpointAllowed(config, input)
        return remoteTool.execute(input, options)
      },
    }

    return [[toolName, wrappedTool] as const]
  })

  return Object.fromEntries(wrappedEntries) as ToolSet
}

export async function createAiSdkFmpMcpToolsContext(
  apiKey?: string
): Promise<AiSdkFmpMcpToolsContext | null> {
  const normalizedApiKey = apiKey?.trim()
  if (!normalizedApiKey) {
    return null
  }

  const url = new URL(FMP_MCP_SERVER_URL)
  url.searchParams.set("apikey", normalizedApiKey)

  let client: Awaited<ReturnType<typeof createMCPClient>> | null = null

  try {
    client = await createMCPClient({
      name: "yurie",
      transport: {
        type: "http",
        url: url.toString(),
        redirect: "error",
      },
    })

    const curatedDefinitions = await getCuratedDefinitions(client)
    if (curatedDefinitions.tools.length === 0) {
      logFmpOnce(
        "no-curated-fmp-tools",
        "warn",
        "FMP MCP is enabled but no curated tools are available."
      )
      await client.close()
      return null
    }

    const remoteToolNames = curatedDefinitions.tools.map((tool) => tool.name)
    const remoteTools = client.toolsFromDefinitions(
      curatedDefinitions
    ) as ToolSet
    const tools = wrapCuratedTools(remoteTools, remoteToolNames)
    const remoteToolNameSet = new Set(remoteToolNames)

    return {
      tools,
      close: async () => {
        await client?.close()
      },
      isToolName: (value: unknown): value is string =>
        typeof value === "string" && remoteToolNameSet.has(value),
      getToolCallMetadata: (part) => {
        if (!part || !remoteToolNameSet.has(part.toolName)) {
          return null
        }

        return {
          callId: part.toolCallId,
          toolName: FMP_MCP_TOOL_NAME,
          label: getLabelForToolCall(part.toolName, part.input),
        }
      },
      getToolResultMetadata: (part) => {
        if (!part || !remoteToolNameSet.has(part.toolName)) {
          return null
        }

        return {
          callId: part.toolCallId,
          toolName: FMP_MCP_TOOL_NAME,
          status: isFmpToolError(part.output) ? "error" : "success",
          sources: [],
        }
      },
    }
  } catch (error) {
    const message =
      asString(asRecord(error)?.message)?.trim() ??
      (error instanceof Error ? error.message.trim() : "Unknown MCP error.")

    logFmpOnce(
      `init-error:${message}`,
      "error",
      `Failed to initialize FMP MCP tools: ${message}`
    )

    try {
      await client?.close()
    } catch {}

    return null
  }
}
