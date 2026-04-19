import { getTestMocks } from "./mock-state.mjs"

export async function getRequestSession(headers) {
  return (
    (await getTestMocks().authSession?.getRequestSession?.(headers)) ?? null
  )
}
