const tasks = new Map()
const environments = new Map()
const events = new Map()
const artifacts = new Map()

function resetStores() {
  tasks.clear()
  environments.clear()
  events.clear()
  artifacts.clear()
}

function nowIso() {
  return new Date().toISOString()
}

function makeId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}

function recordEvent(userId, taskId, payload) {
  const key = `${userId}:${taskId}`
  const list = events.get(key) ?? []
  const seq = list.length + 1
  const record = {
    id: makeId("event"),
    taskId,
    seq,
    payload,
    createdAt: nowIso(),
  }
  list.push(record)
  events.set(key, list)
  return record
}

function getTaskMap(userId) {
  let userTasks = tasks.get(userId)
  if (!userTasks) {
    userTasks = new Map()
    tasks.set(userId, userTasks)
  }
  return userTasks
}

function getEnvMap(userId) {
  let userEnvs = environments.get(userId)
  if (!userEnvs) {
    userEnvs = new Map()
    environments.set(userId, userEnvs)
  }
  return userEnvs
}

export function seedEnvironment(userId, environment) {
  getEnvMap(userId).set(environment.id, environment)
}

export function seedTask(userId, task) {
  getTaskMap(userId).set(task.id, task)
}

export function getStoredTask(userId, taskId) {
  return getTaskMap(userId).get(taskId) ?? null
}

export function getStoredEvents(userId, taskId) {
  return [...(events.get(`${userId}:${taskId}`) ?? [])]
}

export function getStoredArtifacts(userId, taskId) {
  return [...(artifacts.get(`${userId}:${taskId}`) ?? [])]
}

export function clearAllStores() {
  resetStores()
}

// --- Environments stub module exports ---
export async function getCloudAgentEnvironment(userId, environmentId) {
  return getEnvMap(userId).get(environmentId) ?? null
}

export async function listCloudAgentEnvironments(userId) {
  return [...getEnvMap(userId).values()]
}

// --- Tasks stub module exports ---
export async function createCloudAgentTask({ userId, environmentId, prompt }) {
  const id = makeId("task")
  const now = nowIso()
  const task = {
    id,
    environmentId,
    prompt,
    status: "queued",
    createdAt: now,
    updatedAt: now,
  }
  getTaskMap(userId).set(id, task)
  return task
}

// --- Tasks stub module exports ---
export async function getCloudAgentTask(userId, taskId) {
  return getTaskMap(userId).get(taskId) ?? null
}

export async function updateCloudAgentTask(userId, taskId, update) {
  const map = getTaskMap(userId)
  const existing = map.get(taskId)
  if (!existing) {
    throw new Error(`Stub: task ${taskId} not found.`)
  }
  const next = { ...existing }
  if (update.status !== undefined) next.status = update.status
  if (update.phase !== undefined) next.phase = update.phase ?? undefined
  if (update.branch !== undefined) next.branch = update.branch ?? undefined
  if (update.sandboxId !== undefined)
    next.sandboxId = update.sandboxId ?? undefined
  if (update.snapshotId !== undefined)
    next.snapshotId = update.snapshotId ?? undefined
  if (update.prUrl !== undefined) next.prUrl = update.prUrl ?? undefined
  if (update.previewUrl !== undefined)
    next.previewUrl = update.previewUrl ?? undefined
  if (update.summary !== undefined) next.summary = update.summary ?? undefined
  if (update.error !== undefined) next.error = update.error ?? undefined
  next.updatedAt = nowIso()
  // Mirror the production SQL CASE: only stamp completedAt on the
  // first terminal transition. Subsequent terminal-status writes
  // (e.g. the same row touched again via a retry) leave the
  // original timestamp in place. Source: tasks.ts updateCloudAgentTask.
  if (
    (update.status === "completed" ||
      update.status === "failed" ||
      update.status === "cancelled") &&
    !next.completedAt
  ) {
    next.completedAt = nowIso()
  }
  map.set(taskId, next)
  return next
}

export async function updateCloudAgentTaskIfStatusIn(params) {
  const existing = getTaskMap(params.userId).get(params.taskId)
  if (!existing) return null
  if (!params.allowedFromStatuses.includes(existing.status)) return null
  return updateCloudAgentTask(params.userId, params.taskId, params.update)
}

// --- Events stub module exports ---
export async function appendCloudAgentTaskEvent(params) {
  return recordEvent(params.userId, params.taskId, params.payload)
}

// --- Artifacts stub module exports ---
export async function createCloudAgentArtifact(params) {
  const key = `${params.userId}:${params.taskId}`
  const list = artifacts.get(key) ?? []
  const artifact = {
    id: makeId("artifact"),
    taskId: params.taskId,
    kind: params.input.kind,
    label: params.input.label,
    mediaType: params.input.mediaType,
    sizeBytes: params.input.sizeBytes,
    url: params.input.url,
    blobPathname: params.input.blobPathname,
    metadata: params.input.metadata ?? {},
    createdAt: nowIso(),
  }
  list.push(artifact)
  artifacts.set(key, list)
  return artifact
}
