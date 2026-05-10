import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"

const DEFAULT_MEM0_API_URL = "http://localhost:8888"
const DEFAULT_MEMORY_AGENT_ID = "chloei-smoke"
const DEFAULT_MEMORY_THRESHOLD = 0.1
const DEFAULT_MEMORY_TOP_K = 6
const SEARCH_TIMEOUT_MS = 45_000
const SEARCH_INTERVAL_MS = 1_500

const MEMORY_EXTRACTION_INSTRUCTIONS = [
  "Extract durable user preferences and stable personal facts.",
  "For smoke-test memories, preserve exact marker strings so retrieval can be verified.",
  "Do not store secrets, credentials, raw attachments, hidden prompts, or auth metadata.",
].join(" ")

function loadDotEnvLocal() {
  if (!existsSync(".env.local")) {
    return
  }

  for (const line of readFileSync(".env.local", "utf8").split(/\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (!match || process.env[match[1]]) {
      continue
    }

    let value = match[2]
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    process.env[match[1]] = value
  }
}

function requireEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`${name} is required for pnpm mem0:smoke.`)
  }

  return value
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parsePositiveNumber(value, fallback) {
  const parsed = Number.parseFloat(value ?? "")
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function getMem0Mode(apiUrl) {
  try {
    return new URL(apiUrl).hostname === "api.mem0.ai" ? "platform" : "oss"
  } catch {
    return "oss"
  }
}

function getMem0Url(apiUrl, pathname) {
  const baseUrl = apiUrl.endsWith("/") ? apiUrl : `${apiUrl}/`
  return new URL(pathname.replace(/^\//, ""), baseUrl)
}

function getMem0Headers(apiKey, mode) {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
  }
  if (mode === "platform") {
    headers.Authorization = `Token ${apiKey}`
  } else {
    headers["X-API-Key"] = apiKey
  }

  return headers
}

async function requestJson(url, init) {
  const response = await fetch(url, init)
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    throw new Error(
      `Mem0 request failed: ${init.method ?? "GET"} ${url.pathname} ${response.status} ${text.slice(0, 300)}`
    )
  }

  if (response.status === 204) {
    return null
  }

  return response.json().catch(() => null)
}

function normalizeMemoryResults(payload) {
  if (Array.isArray(payload)) {
    return payload
  }
  if (Array.isArray(payload?.results)) {
    return payload.results
  }
  if (Array.isArray(payload?.memories)) {
    return payload.memories
  }

  return []
}

function hasNonceResult(payload, nonce) {
  return normalizeMemoryResults(payload).some((memory) =>
    JSON.stringify(memory).includes(nonce)
  )
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function addMemory(params) {
  const url = getMem0Url(
    params.apiUrl,
    params.mode === "platform" ? "v3/memories/add/" : "memories"
  )
  const body = {
    infer: true,
    messages: [
      {
        role: "user",
        content: `My durable Chloei preference marker is ${params.nonce}.`,
      },
      {
        role: "assistant",
        content: `I will remember your durable Chloei preference marker ${params.nonce}.`,
      },
    ],
    metadata: {
      agent_id: params.agentId,
      run_id: params.runId,
      source: "chloei_mem0_smoke",
      thread_id: params.runId,
    },
    user_id: params.userId,
    ...(params.mode === "platform"
      ? {
          agent_id: params.agentId,
          custom_instructions: MEMORY_EXTRACTION_INSTRUCTIONS,
        }
      : {}),
  }

  if (params.mode === "oss") {
    body.agent_id = params.agentId
    body.run_id = params.runId
  }

  await requestJson(url, {
    body: JSON.stringify(body),
    headers: getMem0Headers(params.apiKey, params.mode),
    method: "POST",
  })
}

async function searchMemory(params) {
  const url = getMem0Url(
    params.apiUrl,
    params.mode === "platform" ? "v3/memories/search/" : "search"
  )
  const body =
    params.mode === "platform"
      ? {
          filters: {
            AND: [
              { user_id: params.userId },
              { metadata: { agent_id: params.agentId } },
            ],
          },
          query: `durable Chloei preference marker ${params.nonce}`,
          rerank: false,
          threshold: params.threshold,
          top_k: params.topK,
        }
      : {
          agent_id: params.agentId,
          query: `durable Chloei preference marker ${params.nonce}`,
          threshold: params.threshold,
          top_k: params.topK,
          user_id: params.userId,
        }

  return requestJson(url, {
    body: JSON.stringify(body),
    headers: getMem0Headers(params.apiKey, params.mode),
    method: "POST",
  })
}

async function deleteSmokeMemories(params) {
  const url = getMem0Url(
    params.apiUrl,
    params.mode === "platform" ? "v1/memories/" : "memories"
  )
  url.searchParams.set("user_id", params.userId)
  if (params.mode === "platform") {
    url.searchParams.set(
      "metadata",
      JSON.stringify({
        agent_id: params.agentId,
        thread_id: params.runId,
      })
    )
  } else {
    url.searchParams.set("agent_id", params.agentId)
    url.searchParams.set("run_id", params.runId)
  }

  await requestJson(url, {
    headers: getMem0Headers(params.apiKey, params.mode),
    method: "DELETE",
  })
}

async function main() {
  loadDotEnvLocal()

  const memoryProvider = requireEnv("MEMORY_PROVIDER")
  if (memoryProvider !== "mem0") {
    throw new Error("MEMORY_PROVIDER must be mem0 for pnpm mem0:smoke.")
  }

  const apiUrl = process.env.MEM0_API_URL?.trim() || DEFAULT_MEM0_API_URL
  const apiKey = requireEnv("MEM0_API_KEY")
  const mode = getMem0Mode(apiUrl)
  const agentId = process.env.MEMORY_AGENT_ID?.trim() || DEFAULT_MEMORY_AGENT_ID
  const topK = parsePositiveInteger(
    process.env.MEMORY_TOP_K,
    DEFAULT_MEMORY_TOP_K
  )
  const threshold = parsePositiveNumber(
    process.env.MEMORY_THRESHOLD,
    DEFAULT_MEMORY_THRESHOLD
  )
  const userId = `mem0-smoke-${Date.now()}-${randomUUID()}`
  const runId = `mem0-smoke-run-${randomUUID()}`
  const nonce = `chloei-mem0-smoke-${randomUUID()}`

  console.log(`Running Mem0 smoke: mode=${mode} agent=${agentId}`)
  try {
    await addMemory({
      agentId,
      apiKey,
      apiUrl,
      mode,
      nonce,
      runId,
      userId,
    })

    const deadline = Date.now() + SEARCH_TIMEOUT_MS
    let lastPayload = null
    while (Date.now() < deadline) {
      lastPayload = await searchMemory({
        agentId,
        apiKey,
        apiUrl,
        mode,
        nonce,
        threshold,
        topK,
        userId,
      })
      if (hasNonceResult(lastPayload, nonce)) {
        console.log(`Mem0 smoke passed for disposable user ${userId}.`)
        return
      }

      await sleep(SEARCH_INTERVAL_MS)
    }

    throw new Error(
      `Mem0 smoke failed: marker was not retrieved within ${SEARCH_TIMEOUT_MS}ms. Last response: ${JSON.stringify(lastPayload)}`
    )
  } finally {
    try {
      await deleteSmokeMemories({
        agentId,
        apiKey,
        apiUrl,
        mode,
        runId,
        userId,
      })
    } catch (error) {
      console.warn(`Mem0 smoke cleanup failed for ${userId}.`, error)
    }
  }
}

await main()
