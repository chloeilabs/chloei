import { createGateway } from "@ai-sdk/gateway"
import { Agent, type Dispatcher, Dispatcher1Wrapper } from "undici"

import { AI_GATEWAY_CLIENT_TIMEOUT_MS } from "@/lib/server/agent-runtime-config"

const aiGatewayDispatcher = new Dispatcher1Wrapper(
  new Agent({
    bodyTimeout: AI_GATEWAY_CLIENT_TIMEOUT_MS,
    headersTimeout: AI_GATEWAY_CLIENT_TIMEOUT_MS,
  })
)

type UndiciRequestInit = RequestInit & {
  dispatcher: Dispatcher
}

export const aiGatewayFetch: typeof fetch = (input, init) =>
  fetch(input, {
    ...init,
    dispatcher: aiGatewayDispatcher,
  } as UndiciRequestInit)

export function createConfiguredAiGateway(aiGatewayApiKey?: string) {
  return createGateway({
    ...(aiGatewayApiKey ? { apiKey: aiGatewayApiKey } : {}),
    fetch: aiGatewayFetch,
  })
}
