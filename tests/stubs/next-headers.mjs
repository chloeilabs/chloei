import { getTestMocks } from "./mock-state.mjs"

export async function headers() {
  return getTestMocks().nextHeaders ?? new Headers()
}
