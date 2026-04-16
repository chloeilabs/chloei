import { getTestMocks } from "./mock-state.mjs"

async function* createEmptyStream() {
  yield* []
}

export function startOpenRouterResponseStream(params) {
  return (
    getTestMocks().openRouterResponses?.startOpenRouterResponseStream?.(
      params
    ) ??
    createEmptyStream()
  )
}
