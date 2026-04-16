import { getTestMocks } from "./mock-state.mjs"

function defaultJsonErrorResponse(params) {
  return Response.json(
    { error: params.error },
    {
      status: params.status,
      headers: {
        "X-Request-Id": params.requestId,
      },
    }
  )
}

export function resolveRequestId(request) {
  return getTestMocks().agentRoute?.resolveRequestId?.(request) ?? "request-1"
}

export function resolveUserTimeZone(request) {
  return getTestMocks().agentRoute?.resolveUserTimeZone?.(request)
}

export function createJsonErrorResponse(params) {
  return (
    getTestMocks().agentRoute?.createJsonErrorResponse?.(params) ??
    defaultJsonErrorResponse(params)
  )
}

export function parseAgentStreamRequest(params) {
  return getTestMocks().agentRoute?.parseAgentStreamRequest?.(params) ?? {
    parsedRequest: {
      messages: params.body?.messages ?? [],
    },
    selectedModel: "qwen/qwen3.6-plus",
  }
}

export function createAgentStreamResponse(params) {
  return (
    getTestMocks().agentRoute?.createAgentStreamResponse?.(params) ??
    new Response("stream", {
      status: 200,
    })
  )
}
