"use client"

import type {
  CloudAgentArtifact,
  CloudAgentEnvironment,
  CloudAgentTask,
  CloudAgentTaskEvent,
} from "@/lib/shared/cloud-agents"

interface ApiErrorBody {
  error?: string
  errorCode?: string
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let body: ApiErrorBody = {}
    try {
      body = (await response.json()) as ApiErrorBody
    } catch {
      // ignore non-json error bodies
    }
    throw new Error(
      body.error ??
        `Cloud agent request failed with status ${String(response.status)}.`
    )
  }
  return (await response.json()) as T
}

export interface CloudAgentListEnvironmentsResponse {
  environments: CloudAgentEnvironment[]
}

export interface CloudAgentCreateEnvironmentInput {
  name: string
  repoOwner: string
  repoName: string
  baseBranch?: string
  setupCommand?: string
  testCommand?: string
  devCommand?: string
  vercelProjectId?: string
}

export async function listCloudAgentEnvironments(): Promise<
  CloudAgentEnvironment[]
> {
  const response = await fetch("/api/cloud-agents/environments", {
    method: "GET",
    cache: "no-store",
  })
  const body = await readJson<CloudAgentListEnvironmentsResponse>(response)
  return body.environments
}

export async function createCloudAgentEnvironment(
  input: CloudAgentCreateEnvironmentInput
): Promise<CloudAgentEnvironment> {
  const response = await fetch("/api/cloud-agents/environments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  const body = await readJson<{ environment: CloudAgentEnvironment }>(response)
  return body.environment
}

export async function deleteCloudAgentEnvironment(
  environmentId: string
): Promise<void> {
  const response = await fetch(
    `/api/cloud-agents/environments/${encodeURIComponent(environmentId)}`,
    { method: "DELETE" }
  )
  await readJson<Record<string, never>>(response)
}

export interface CloudAgentListTasksResponse {
  tasks: CloudAgentTask[]
}

export async function listCloudAgentTasks(
  environmentId?: string
): Promise<CloudAgentTask[]> {
  const url = environmentId
    ? `/api/cloud-agents/tasks?environmentId=${encodeURIComponent(environmentId)}`
    : "/api/cloud-agents/tasks"
  const response = await fetch(url, { method: "GET", cache: "no-store" })
  const body = await readJson<CloudAgentListTasksResponse>(response)
  return body.tasks
}

export interface CloudAgentCreateTaskInput {
  environmentId: string
  prompt: string
}

export async function createCloudAgentTask(
  input: CloudAgentCreateTaskInput
): Promise<CloudAgentTask> {
  const response = await fetch("/api/cloud-agents/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  const body = await readJson<{ task: CloudAgentTask }>(response)
  return body.task
}

export interface CloudAgentTaskDetailResponse {
  task: CloudAgentTask
  artifacts: CloudAgentArtifact[]
}

export async function getCloudAgentTaskDetail(
  taskId: string
): Promise<CloudAgentTaskDetailResponse> {
  const response = await fetch(
    `/api/cloud-agents/tasks/${encodeURIComponent(taskId)}`,
    { method: "GET", cache: "no-store" }
  )
  return readJson<CloudAgentTaskDetailResponse>(response)
}

export interface CloudAgentEventsResponse {
  task: CloudAgentTask | null
  events: CloudAgentTaskEvent[]
  lastSeq: number
}

export async function getCloudAgentTaskEvents(params: {
  taskId: string
  afterSeq?: number
}): Promise<CloudAgentEventsResponse> {
  const search = params.afterSeq ? `?after=${String(params.afterSeq)}` : ""
  const response = await fetch(
    `/api/cloud-agents/tasks/${encodeURIComponent(params.taskId)}/events${search}`,
    { method: "GET", cache: "no-store" }
  )
  return readJson<CloudAgentEventsResponse>(response)
}

export async function cancelCloudAgentTask(taskId: string): Promise<void> {
  const response = await fetch(
    `/api/cloud-agents/tasks/${encodeURIComponent(taskId)}/cancel`,
    { method: "POST" }
  )
  await readJson<Record<string, never>>(response)
}

export async function sendCloudAgentTaskMessage(params: {
  taskId: string
  message: string
}): Promise<void> {
  const response = await fetch(
    `/api/cloud-agents/tasks/${encodeURIComponent(params.taskId)}/message`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: params.message }),
    }
  )
  await readJson<Record<string, never>>(response)
}

export async function approveCloudAgentTask(params: {
  taskId: string
  approvalId: string
  decision: "approve" | "deny"
  note?: string
}): Promise<void> {
  const response = await fetch(
    `/api/cloud-agents/tasks/${encodeURIComponent(params.taskId)}/approve`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        approvalId: params.approvalId,
        decision: params.decision,
        ...(params.note ? { note: params.note } : {}),
      }),
    }
  )
  await readJson<Record<string, never>>(response)
}
