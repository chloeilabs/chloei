import { getTestMocks } from "./mock-state.mjs"

async function* createEmptyStream() {
  yield* []
}

export function startGatewayResponseStream(params) {
  return (
    getTestMocks().gatewayResponses?.startGatewayResponseStream?.(params) ??
    createEmptyStream()
  )
}
