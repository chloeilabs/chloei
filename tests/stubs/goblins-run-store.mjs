// Stub for @/lib/server/goblins-run-store (real module uses pg/kysely).
// Tests script lookups via mock-state.
import { getTestMocks } from "./mock-state.mjs"

export const GOBLINS_RUN_STATUSES = [
  "pending_dispatch",
  "awaiting_manager",
  "executing_tools",
  "completed",
  "failed",
  "cancelled",
  "expired",
]

export const GOBLINS_RUN_TERMINAL_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "expired",
]

export function isGoblinsRunTerminal(status) {
  return GOBLINS_RUN_TERMINAL_STATUSES.includes(status)
}

export function isGoblinsRunStoreNotInitializedError() {
  return false
}

export async function getGoblinsRunByResponseId(responseId) {
  const impl = getTestMocks().goblinsRunStore?.getByResponseId
  if (typeof impl === "function") {
    return impl(responseId)
  }
  return null
}

export async function getGoblinsRunForUser(userId, runId) {
  const impl = getTestMocks().goblinsRunStore?.getForUser
  if (typeof impl === "function") {
    return impl(userId, runId)
  }
  return null
}

export async function claimGoblinsRun(runId, leaseOwner) {
  const impl = getTestMocks().goblinsRunStore?.claim
  if (typeof impl === "function") {
    return impl(runId, leaseOwner)
  }
  return null
}

export async function createGoblinsRun(params) {
  const impl = getTestMocks().goblinsRunStore?.create
  if (typeof impl === "function") {
    return impl(params)
  }
  throw new Error("goblinsRunStore.create not scripted")
}

export async function appendGoblinsRunEvents(runId, events) {
  const impl = getTestMocks().goblinsRunStore?.appendEvents
  if (typeof impl === "function") {
    return impl(runId, events)
  }
}

export async function recordGoblinsRunToolResult(runId, callId, brief) {
  const impl = getTestMocks().goblinsRunStore?.recordToolResult
  if (typeof impl === "function") {
    return impl(runId, callId, brief)
  }
}

export async function updateGoblinsRunPhase(runId, phase) {
  const impl = getTestMocks().goblinsRunStore?.updatePhase
  if (typeof impl === "function") {
    return impl(runId, phase)
  }
}

export async function advanceGoblinsRunToNextTurn(params) {
  const impl = getTestMocks().goblinsRunStore?.advance
  if (typeof impl === "function") {
    return impl(params)
  }
}

export async function finishGoblinsRun(runId, status, error) {
  const impl = getTestMocks().goblinsRunStore?.finish
  if (typeof impl === "function") {
    return impl(runId, status, error)
  }
}
