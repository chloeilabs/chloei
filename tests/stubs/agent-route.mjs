import { getTestMocks } from "./mock-state.mjs"

function defaultJsonErrorResponse(params) {
  const requestId = params.requestId ?? "request-1"
  const errorCode = params.errorCode ?? "UNKNOWN_ERROR"

  return Response.json(
    {
      error: params.error,
      errorCode,
      requestId,
    },
    {
      status: params.status,
      headers: {
        "X-Error-Code": errorCode,
        "X-Request-Id": requestId,
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
    selectedModel: "anthropic/claude-sonnet-4.6",
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
