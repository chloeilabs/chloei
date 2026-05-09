import { randomUUID } from "node:crypto"
import net from "node:net"

import { tool } from "ai"
import { z } from "zod"

import { asRecord, asString } from "@/lib/cast"
import { hashUserId } from "@/lib/server/privacy"
import type { MessageSource, ToolName } from "@/lib/shared"

const BROWSER_RESEARCH_TOOL_NAME = "browser_research" as const
const BROWSER_RESEARCH_LABEL = "Browsing website"
const DEFAULT_TIMEOUT_SECONDS = 60
const MAX_PAGE_TEXT_CHARS = 8_000

type BrowserResearchToolName = Extract<
  ToolName,
  typeof BROWSER_RESEARCH_TOOL_NAME
>

interface BrowserResearchOutput {
  requestId: string
  objective: string
  startUrl: string
  finalUrl: string
  title: string
  excerpt: string
  sessionId: string
  sourceUrl: string
}

interface BrowserResearchErrorPayload {
  message: string
  code?: string
}

interface BrowserResearchToolResultPayload {
  output?: BrowserResearchOutput
  error?: BrowserResearchErrorPayload
}

interface AiSdkBrowserResearchToolCallMetadata {
  callId: string
  toolName: BrowserResearchToolName
  label: string
  query?: string
  operation?: string
  provider?: string
}

interface AiSdkBrowserResearchToolResultMetadata {
  callId: string
  toolName: BrowserResearchToolName
  status: "success" | "error"
  sources: MessageSource[]
  operation?: string
  provider?: string
  errorCode?: string
  retryable?: boolean
}

interface CreateAiSdkBrowserResearchToolsOptions {
  enabled: boolean
  userId?: string
  requestId?: string
}

const browserResearchInputSchema = z.object({
  objective: z.string().trim().min(1).max(800),
  startUrl: z.url(),
  allowedDomains: z.array(z.string().trim().min(1).max(255)).min(1).max(5),
  consent: z.literal(true),
})

const SECRET_PATTERN =
  /(password|passcode|one[-\s]?time|otp|mfa|2fa|secret|token|api key|credential|ssn|social security|card number|routing number|account number)/i

function toOptionalString(value: unknown): string | undefined {
  const normalized = asString(value)?.trim()
  if (!normalized) {
    return undefined
  }

  return normalized
}

function normalizeDomain(value: string): string | null {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^\*\./, "")
    .replace(/^\.+|\.+$/g, "")

  if (!normalized || normalized.includes("*") || normalized.includes(":")) {
    return null
  }

  return normalized
}

function isPrivateIpAddress(hostname: string): boolean {
  const ipVersion = net.isIP(hostname)
  if (ipVersion === 0) {
    return false
  }

  if (ipVersion === 6) {
    const normalized = hostname.toLowerCase()
    return (
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80:")
    )
  }

  const octets = hostname.split(".").map((part) => Number(part))
  const [first, second] = octets
  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  )
}

export function isAllowedBrowserResearchUrl(params: {
  startUrl: string
  allowedDomains: readonly string[]
}): boolean {
  let url: URL
  try {
    url = new URL(params.startUrl)
  } catch {
    return false
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return false
  }

  const hostname = url.hostname.toLowerCase()
  if (
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    isPrivateIpAddress(hostname)
  ) {
    return false
  }

  return params.allowedDomains.some((domain) => {
    const normalizedDomain = normalizeDomain(domain)
    return (
      normalizedDomain !== null &&
      (hostname === normalizedDomain ||
        hostname.endsWith(`.${normalizedDomain}`))
    )
  })
}

function getErrorPayload(error: unknown): BrowserResearchErrorPayload {
  const record = asRecord(error)
  const message =
    asString(record?.message)?.trim() ??
    (error instanceof Error ? error.message.trim() : "")
  const code = toOptionalString(record?.code)

  return {
    message:
      message && message.length > 0
        ? message
        : "Browser research request failed.",
    ...(code ? { code } : {}),
  }
}

function parseToolResultPayload(
  value: unknown
): BrowserResearchToolResultPayload | null {
  const normalized = asRecord(value)
  if (!normalized) {
    return null
  }

  return {
    ...(asRecord(normalized.output)
      ? { output: normalized.output as BrowserResearchOutput }
      : {}),
    ...(asRecord(normalized.error)
      ? { error: normalized.error as BrowserResearchErrorPayload }
      : {}),
  }
}

function toSourcesFromOutput(output: BrowserResearchOutput): MessageSource[] {
  return [
    {
      id: `${BROWSER_RESEARCH_TOOL_NAME}-${output.requestId}`,
      url: output.sourceUrl,
      title: output.title || output.sourceUrl,
    },
  ]
}

async function runBrowserResearch(params: {
  apiKey: string
  projectId?: string
  objective: string
  startUrl: string
  allowedDomains: string[]
  userId?: string
  requestId?: string
}): Promise<BrowserResearchToolResultPayload> {
  if (SECRET_PATTERN.test(params.objective)) {
    return {
      error: {
        message:
          "Browser research cannot collect credentials, account secrets, or sensitive authentication material.",
        code: "BROWSER_RESEARCH_SENSITIVE_OBJECTIVE",
      },
    }
  }

  if (
    !isAllowedBrowserResearchUrl({
      startUrl: params.startUrl,
      allowedDomains: params.allowedDomains,
    })
  ) {
    return {
      error: {
        message: "Browser research URL is outside the consented allowlist.",
        code: "BROWSER_RESEARCH_URL_NOT_ALLOWED",
      },
    }
  }

  const [{ Browserbase }, { chromium }] = await Promise.all([
    import("@browserbasehq/sdk"),
    import("playwright-core"),
  ])
  const client = new Browserbase({
    apiKey: params.apiKey,
  })
  const session = await client.sessions.create({
    ...(params.projectId ? { projectId: params.projectId } : {}),
    timeout: DEFAULT_TIMEOUT_SECONDS,
    userMetadata: {
      requestId: params.requestId,
      userKey: params.userId ? hashUserId(params.userId) : undefined,
      tool: BROWSER_RESEARCH_TOOL_NAME,
    },
    browserSettings: {
      blockAds: true,
      logSession: false,
      recordSession: false,
      solveCaptchas: false,
    },
  })

  const browser = await chromium.connectOverCDP(session.connectUrl)
  try {
    const context = browser.contexts()[0] ?? (await browser.newContext())
    const page = context.pages()[0] ?? (await context.newPage())
    page.setDefaultTimeout(15_000)

    await page.goto(params.startUrl, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    })
    await page
      .waitForLoadState("networkidle", { timeout: 5_000 })
      .catch(() => undefined)

    const title = (await page.title()).trim()
    const bodyText = await page
      .locator("body")
      .innerText({ timeout: 5_000 })
      .catch(() => "")
    const excerpt = bodyText
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_PAGE_TEXT_CHARS)
    const finalUrl = page.url()

    return {
      output: {
        requestId: randomUUID(),
        objective: params.objective,
        startUrl: params.startUrl,
        finalUrl,
        title: title || finalUrl,
        excerpt,
        sessionId: session.id,
        sourceUrl: finalUrl,
      },
    }
  } finally {
    await browser.close().catch(() => undefined)
  }
}

export function isAiSdkBrowserResearchToolName(
  value: unknown
): value is BrowserResearchToolName {
  return value === BROWSER_RESEARCH_TOOL_NAME
}

export function createAiSdkBrowserResearchTools(
  options: CreateAiSdkBrowserResearchToolsOptions
) {
  const apiKey = process.env.BROWSERBASE_API_KEY?.trim()
  if (!options.enabled || !apiKey) {
    return {}
  }

  const projectId = process.env.BROWSERBASE_PROJECT_ID?.trim()

  return {
    browser_research: tool({
      description:
        "Use a consented Browserbase browser session for dynamic or authenticated websites that cannot be handled by normal search/extract tools. Only use when the user explicitly consents, provides a startUrl, and supplies allowedDomains. Never collect credentials or account secrets.",
      inputSchema: browserResearchInputSchema,
      execute: async (input) => {
        try {
          return await runBrowserResearch({
            apiKey,
            ...(projectId ? { projectId } : {}),
            objective: input.objective,
            startUrl: input.startUrl,
            allowedDomains: input.allowedDomains,
            userId: options.userId,
            requestId: options.requestId,
          })
        } catch (error) {
          return {
            error: getErrorPayload(error),
          } satisfies BrowserResearchToolResultPayload
        }
      },
    }),
  }
}

export function getAiSdkBrowserResearchToolCallMetadata(
  part:
    | {
        toolCallId: string
        toolName: string
        input: unknown
      }
    | undefined
): AiSdkBrowserResearchToolCallMetadata | null {
  if (part?.toolName !== BROWSER_RESEARCH_TOOL_NAME) {
    return null
  }

  return {
    callId: part.toolCallId,
    toolName: BROWSER_RESEARCH_TOOL_NAME,
    label: BROWSER_RESEARCH_LABEL,
    ...(toOptionalString(asRecord(part.input)?.startUrl)
      ? { query: toOptionalString(asRecord(part.input)?.startUrl) }
      : {}),
    operation: "browse",
    provider: "browserbase",
  }
}

export function getAiSdkBrowserResearchToolResultMetadata(
  part:
    | {
        toolCallId: string
        toolName: string
        output: unknown
      }
    | undefined
): AiSdkBrowserResearchToolResultMetadata | null {
  if (part?.toolName !== BROWSER_RESEARCH_TOOL_NAME) {
    return null
  }

  const payload = parseToolResultPayload(part.output)
  if (!payload) {
    return {
      callId: part.toolCallId,
      toolName: BROWSER_RESEARCH_TOOL_NAME,
      status: "error",
      sources: [],
      operation: "browse",
      provider: "browserbase",
      errorCode: "INVALID_TOOL_OUTPUT",
      retryable: false,
    }
  }

  if (payload.error) {
    return {
      callId: part.toolCallId,
      toolName: BROWSER_RESEARCH_TOOL_NAME,
      status: "error",
      sources: [],
      operation: "browse",
      provider: "browserbase",
      errorCode: payload.error.code,
      retryable: true,
    }
  }

  return {
    callId: part.toolCallId,
    toolName: BROWSER_RESEARCH_TOOL_NAME,
    status: "success",
    sources: payload.output ? toSourcesFromOutput(payload.output) : [],
    operation: "browse",
    provider: "browserbase",
    retryable: false,
  }
}
