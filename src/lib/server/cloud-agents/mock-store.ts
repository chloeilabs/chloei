import { randomUUID } from "node:crypto"

import { isE2eMockModeEnabled } from "@/lib/server/e2e-test-mode"
import {
  type CloudAgentArtifact,
  type CloudAgentEnvironment,
  type CloudAgentEvent,
  type CloudAgentTask,
  type CloudAgentTaskEvent,
} from "@/lib/shared/cloud-agents"

import { CloudAgentNotFoundError } from "./errors"
import type {
  CloudAgentArtifactCreateInput,
  CloudAgentEnvironmentCreateInput,
  CloudAgentEnvironmentUpdateInput,
} from "./payloads"

interface MockState {
  environments: Map<string, Map<string, CloudAgentEnvironment>>
  tasks: Map<string, Map<string, CloudAgentTask>>
  events: Map<string, CloudAgentTaskEvent[]>
  eventSeq: number
  artifacts: Map<string, CloudAgentArtifact[]>
}

declare global {
  var chloeiCloudAgentMockState: MockState | undefined
}

function getState(): MockState {
  globalThis.chloeiCloudAgentMockState ??= {
    environments: new Map(),
    tasks: new Map(),
    events: new Map(),
    eventSeq: 0,
    artifacts: new Map(),
  }
  return globalThis.chloeiCloudAgentMockState
}

export function isCloudAgentMockModeEnabled(): boolean {
  return isE2eMockModeEnabled() || process.env.CLOUD_AGENT_MOCK_STORE === "1"
}

function getUserEnvironmentMap(
  userId: string
): Map<string, CloudAgentEnvironment> {
  const state = getState()
  let userEnvs = state.environments.get(userId)
  if (!userEnvs) {
    userEnvs = new Map()
    state.environments.set(userId, userEnvs)
  }
  return userEnvs
}

function getUserTaskMap(userId: string): Map<string, CloudAgentTask> {
  const state = getState()
  let userTasks = state.tasks.get(userId)
  if (!userTasks) {
    userTasks = new Map()
    state.tasks.set(userId, userTasks)
  }
  return userTasks
}

function nowIso(): string {
  return new Date().toISOString()
}

export function mockListEnvironments(userId: string): CloudAgentEnvironment[] {
  return [...getUserEnvironmentMap(userId).values()].sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
  )
}

export function mockGetEnvironment(
  userId: string,
  environmentId: string
): CloudAgentEnvironment | null {
  return getUserEnvironmentMap(userId).get(environmentId) ?? null
}

export function mockCreateEnvironment(
  userId: string,
  input: CloudAgentEnvironmentCreateInput
): CloudAgentEnvironment {
  const id = randomUUID()
  const now = nowIso()
  const environment: CloudAgentEnvironment = {
    id,
    name: input.name,
    repoProvider: input.repoProvider,
    repoOwner: input.repoOwner,
    repoName: input.repoName,
    baseBranch: input.baseBranch,
    ...(input.setupCommand ? { setupCommand: input.setupCommand } : {}),
    ...(input.testCommand ? { testCommand: input.testCommand } : {}),
    ...(input.devCommand ? { devCommand: input.devCommand } : {}),
    networkPolicy: input.networkPolicy,
    ...(input.vercelProjectId
      ? { vercelProjectId: input.vercelProjectId }
      : {}),
    sandboxRuntime: input.sandboxRuntime,
    createdAt: now,
    updatedAt: now,
  }
  getUserEnvironmentMap(userId).set(id, environment)
  return environment
}

export function mockUpdateEnvironment(
  userId: string,
  environmentId: string,
  input: CloudAgentEnvironmentUpdateInput
): CloudAgentEnvironment {
  const map = getUserEnvironmentMap(userId)
  const existing = map.get(environmentId)
  if (!existing) {
    throw new CloudAgentNotFoundError("environment", environmentId)
  }
  const merged: CloudAgentEnvironment = {
    ...existing,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.baseBranch !== undefined ? { baseBranch: input.baseBranch } : {}),
    ...(input.setupCommand !== undefined
      ? input.setupCommand
        ? { setupCommand: input.setupCommand }
        : (() => {
            const { setupCommand: _omit, ...rest } = existing
            void _omit
            return rest
          })()
      : {}),
    ...(input.testCommand !== undefined
      ? input.testCommand
        ? { testCommand: input.testCommand }
        : (() => {
            const { testCommand: _omit, ...rest } = existing
            void _omit
            return rest
          })()
      : {}),
    ...(input.devCommand !== undefined
      ? input.devCommand
        ? { devCommand: input.devCommand }
        : (() => {
            const { devCommand: _omit, ...rest } = existing
            void _omit
            return rest
          })()
      : {}),
    ...(input.networkPolicy !== undefined
      ? { networkPolicy: input.networkPolicy }
      : {}),
    ...(input.vercelProjectId !== undefined
      ? input.vercelProjectId
        ? { vercelProjectId: input.vercelProjectId }
        : (() => {
            const { vercelProjectId: _omit, ...rest } = existing
            void _omit
            return rest
          })()
      : {}),
    ...(input.sandboxRuntime !== undefined
      ? { sandboxRuntime: input.sandboxRuntime }
      : {}),
    updatedAt: nowIso(),
  }
  map.set(environmentId, merged)
  return merged
}

export function mockDeleteEnvironment(
  userId: string,
  environmentId: string
): void {
  getUserEnvironmentMap(userId).delete(environmentId)
  for (const task of getUserTaskMap(userId).values()) {
    if (task.environmentId === environmentId) {
      getUserTaskMap(userId).delete(task.id)
    }
  }
}

export function mockListTasks(params: {
  userId: string
  environmentId?: string
}): CloudAgentTask[] {
  return [...getUserTaskMap(params.userId).values()]
    .filter(
      (task) =>
        !params.environmentId || task.environmentId === params.environmentId
    )
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
}

export function mockGetTask(
  userId: string,
  taskId: string
): CloudAgentTask | null {
  return getUserTaskMap(userId).get(taskId) ?? null
}

export function mockCountActiveTasks(userId: string): number {
  return [...getUserTaskMap(userId).values()].filter(
    (task) =>
      task.status !== "completed" &&
      task.status !== "failed" &&
      task.status !== "cancelled"
  ).length
}

export function mockCreateTask(params: {
  userId: string
  environmentId: string
  prompt: string
}): CloudAgentTask {
  const id = randomUUID()
  const now = nowIso()
  const task: CloudAgentTask = {
    id,
    environmentId: params.environmentId,
    prompt: params.prompt,
    status: "queued",
    createdAt: now,
    updatedAt: now,
  }
  getUserTaskMap(params.userId).set(id, task)
  return task
}

export interface MockUpdateTaskInput {
  status?: CloudAgentTask["status"]
  phase?: string | null
  branch?: string | null
  sandboxId?: string | null
  snapshotId?: string | null
  prUrl?: string | null
  previewUrl?: string | null
  summary?: string | null
  error?: string | null
}

export function mockUpdateTask(
  userId: string,
  taskId: string,
  update: MockUpdateTaskInput
): CloudAgentTask {
  const map = getUserTaskMap(userId)
  const existing = map.get(taskId)
  if (!existing) {
    throw new CloudAgentNotFoundError("task", taskId)
  }
  const merged: CloudAgentTask = {
    ...existing,
    updatedAt: nowIso(),
  }
  if (update.status !== undefined) merged.status = update.status
  if (update.phase !== undefined) merged.phase = update.phase ?? undefined
  if (update.branch !== undefined) merged.branch = update.branch ?? undefined
  if (update.sandboxId !== undefined)
    merged.sandboxId = update.sandboxId ?? undefined
  if (update.snapshotId !== undefined)
    merged.snapshotId = update.snapshotId ?? undefined
  if (update.prUrl !== undefined) merged.prUrl = update.prUrl ?? undefined
  if (update.previewUrl !== undefined)
    merged.previewUrl = update.previewUrl ?? undefined
  if (update.summary !== undefined) merged.summary = update.summary ?? undefined
  if (update.error !== undefined) merged.error = update.error ?? undefined
  if (
    update.status === "completed" ||
    update.status === "failed" ||
    update.status === "cancelled"
  ) {
    merged.completedAt = nowIso()
  }
  map.set(taskId, merged)
  return merged
}

export function mockAppendEvent(params: {
  userId: string
  taskId: string
  payload: CloudAgentEvent
}): CloudAgentTaskEvent {
  const state = getState()
  const key = `${params.userId}:${params.taskId}`
  const list = state.events.get(key) ?? []
  state.eventSeq += 1
  const event: CloudAgentTaskEvent = {
    id: randomUUID(),
    taskId: params.taskId,
    seq: state.eventSeq,
    payload: params.payload,
    createdAt: nowIso(),
  }
  list.push(event)
  state.events.set(key, list)
  return event
}

export function mockListEvents(params: {
  userId: string
  taskId: string
  afterSeq?: number
  limit?: number
}): CloudAgentTaskEvent[] {
  const state = getState()
  const list = state.events.get(`${params.userId}:${params.taskId}`) ?? []
  const limit = Math.min(Math.max(params.limit ?? 200, 1), 1000)
  const after = params.afterSeq ?? 0
  return list.filter((event) => event.seq > after).slice(0, limit)
}

export function mockCreateArtifact(params: {
  userId: string
  taskId: string
  input: CloudAgentArtifactCreateInput
}): CloudAgentArtifact {
  const state = getState()
  const key = `${params.userId}:${params.taskId}`
  const list = state.artifacts.get(key) ?? []
  const artifact: CloudAgentArtifact = {
    id: randomUUID(),
    taskId: params.taskId,
    kind: params.input.kind,
    label: params.input.label,
    ...(params.input.mediaType ? { mediaType: params.input.mediaType } : {}),
    ...(params.input.sizeBytes !== undefined
      ? { sizeBytes: params.input.sizeBytes }
      : {}),
    ...(params.input.url ? { url: params.input.url } : {}),
    ...(params.input.blobPathname
      ? { blobPathname: params.input.blobPathname }
      : {}),
    metadata: params.input.metadata,
    createdAt: nowIso(),
  }
  list.push(artifact)
  state.artifacts.set(key, list)
  return artifact
}

export function mockListArtifacts(params: {
  userId: string
  taskId: string
}): CloudAgentArtifact[] {
  const state = getState()
  return state.artifacts.get(`${params.userId}:${params.taskId}`) ?? []
}

export function resetCloudAgentMockStore(): void {
  globalThis.chloeiCloudAgentMockState = undefined
}
