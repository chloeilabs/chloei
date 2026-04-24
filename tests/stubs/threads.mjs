import { getTestMocks } from "./mock-state.mjs"

export async function listThreadsForUser(userId) {
  return (await getTestMocks().threads?.listThreadsForUser?.(userId)) ?? []
}

export function parseThreadPayload(payload) {
  return getTestMocks().threads?.parseThreadPayload?.(payload) ?? payload
}

export async function upsertThreadForUser(userId, thread) {
  return (
    (await getTestMocks().threads?.upsertThreadForUser?.(userId, thread)) ??
    thread
  )
}

export async function deleteThreadForUser(userId, threadId) {
  return getTestMocks().threads?.deleteThreadForUser?.(userId, threadId)
}

export function isThreadStoreNotInitializedError(error) {
  return (
    getTestMocks().threads?.isThreadStoreNotInitializedError?.(error) ?? false
  )
}
