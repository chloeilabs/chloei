"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowLeft, Check, ExternalLink, X } from "lucide-react"
import Link from "next/link"
import { useEffect, useMemo, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  type CloudAgentApprovalRequiredEvent,
  type CloudAgentEvent,
  type CloudAgentTask,
  type CloudAgentTaskEvent,
  isTerminalCloudAgentTaskStatus,
} from "@/lib/shared/cloud-agents"

import {
  approveCloudAgentTask,
  cancelCloudAgentTask,
  type CloudAgentEventsResponse,
  getCloudAgentTaskDetail,
  getCloudAgentTaskEvents,
  sendCloudAgentTaskMessage,
} from "./cloud-agent-api"
import { STATUS_LABELS } from "./cloud-agent-status-labels"

function formatEventTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString()
  } catch {
    return iso
  }
}

function EventEntry({ event }: { event: CloudAgentTaskEvent }) {
  const payload: CloudAgentEvent = event.payload
  const time = formatEventTime(event.createdAt)
  switch (payload.kind) {
    case "status":
      return (
        <li className="flex items-baseline gap-3 border-b border-border/40 px-3 py-2 text-xs">
          <span className="font-mono text-muted-foreground">{time}</span>
          <span className="font-departureMono tracking-[0.18em] uppercase">
            {STATUS_LABELS[payload.status]}
          </span>
          {payload.phase ? (
            <span className="text-muted-foreground">— {payload.phase}</span>
          ) : null}
        </li>
      )
    case "text_delta":
      return (
        <li className="border-b border-border/40 px-3 py-2 text-sm whitespace-pre-wrap">
          {payload.text}
        </li>
      )
    case "tool_call":
      return (
        <li className="flex items-baseline gap-3 border-b border-border/40 bg-muted/30 px-3 py-2 text-xs">
          <span className="font-mono text-muted-foreground">{time}</span>
          <span className="font-departureMono tracking-[0.18em] uppercase">
            {payload.toolName}
          </span>
          <span className="truncate">{payload.label}</span>
        </li>
      )
    case "tool_result":
      return (
        <li className="flex items-baseline gap-3 border-b border-border/40 px-3 py-2 text-xs text-muted-foreground">
          <span className="font-mono">{time}</span>
          <span
            className={`font-departureMono tracking-[0.18em] uppercase ${
              payload.status === "success"
                ? "text-emerald-700 dark:text-emerald-300"
                : "text-destructive"
            }`}
          >
            {payload.status}
          </span>
          <span>tool result</span>
        </li>
      )
    case "terminal_output":
      return (
        <li className="border-b border-border/40 bg-black/95 px-3 py-2 font-mono text-xs text-emerald-200 dark:bg-black/85">
          <pre className="break-words whitespace-pre-wrap">{payload.chunk}</pre>
        </li>
      )
    case "file_change":
      return (
        <li className="flex items-baseline gap-3 border-b border-border/40 px-3 py-2 text-xs">
          <span className="font-mono text-muted-foreground">{time}</span>
          <span className="font-departureMono tracking-[0.18em] text-amber-700 uppercase dark:text-amber-300">
            {payload.change}
          </span>
          <span className="font-mono">{payload.path}</span>
        </li>
      )
    case "diff_update":
      return (
        <li className="flex items-baseline gap-3 border-b border-border/40 bg-muted/30 px-3 py-2 text-xs">
          <span className="font-mono text-muted-foreground">{time}</span>
          <span className="font-departureMono tracking-[0.18em] uppercase">
            diff
          </span>
          <span>
            {payload.filesChanged} file(s),{" "}
            <span className="text-emerald-700 dark:text-emerald-300">
              +{payload.additions}
            </span>{" "}
            / <span className="text-destructive">-{payload.deletions}</span>
          </span>
        </li>
      )
    case "approval_required":
      return (
        <li className="flex items-baseline gap-3 border-b border-border/40 bg-amber-100/40 px-3 py-2 text-xs dark:bg-amber-900/20">
          <span className="font-mono text-muted-foreground">{time}</span>
          <span className="font-departureMono tracking-[0.18em] text-amber-700 uppercase dark:text-amber-300">
            approval
          </span>
          <span>{payload.reason}</span>
        </li>
      )
    case "preview_ready":
      return (
        <li className="flex items-baseline gap-3 border-b border-border/40 px-3 py-2 text-xs">
          <span className="font-mono text-muted-foreground">{time}</span>
          <span className="font-departureMono tracking-[0.18em] text-emerald-700 uppercase dark:text-emerald-300">
            preview
          </span>
          <a
            href={payload.url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 text-foreground underline"
          >
            {payload.url}
            <ExternalLink className="size-3" />
          </a>
        </li>
      )
    case "artifact":
      return (
        <li className="flex items-baseline gap-3 border-b border-border/40 px-3 py-2 text-xs text-muted-foreground">
          <span className="font-mono">{time}</span>
          <span className="font-departureMono tracking-[0.18em] uppercase">
            artifact
          </span>
          <span>{payload.artifactId}</span>
        </li>
      )
    case "error":
      return (
        <li className="flex items-baseline gap-3 border-b border-border/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <span className="font-mono">{time}</span>
          <span className="font-departureMono tracking-[0.18em] uppercase">
            error
          </span>
          <span>{payload.message}</span>
        </li>
      )
    default: {
      const exhaustive: never = payload
      void exhaustive
      return null
    }
  }
}

function ApprovalPanel({
  taskId,
  approval,
  onResolved,
}: {
  taskId: string
  approval: CloudAgentApprovalRequiredEvent
  onResolved: () => void
}) {
  const [note, setNote] = useState("")
  const mutation = useMutation({
    mutationFn: (decision: "approve" | "deny") =>
      approveCloudAgentTask({
        taskId,
        approvalId: approval.approvalId,
        decision,
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    onSuccess: () => {
      onResolved()
    },
  })

  return (
    <section
      className="border border-amber-500/50 bg-amber-50/60 p-4 dark:bg-amber-950/20"
      data-testid="cloud-agent-approval-panel"
    >
      <header className="mb-2 flex items-center gap-2">
        <span className="font-departureMono text-xs tracking-[0.18em] text-amber-700 uppercase dark:text-amber-300">
          Approval required
        </span>
        <span className="font-departureMono text-xs tracking-[0.18em] uppercase">
          {approval.action.replace(/_/g, " ")}
        </span>
      </header>
      <p className="mb-3 text-sm">{approval.reason}</p>
      <input
        type="text"
        value={note}
        onChange={(event) => {
          setNote(event.target.value)
        }}
        placeholder="Optional note (visible in audit log)"
        className="mb-3 h-9 w-full border border-border bg-background px-2 text-sm outline-none focus-visible:border-ring"
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={() => {
            mutation.mutate("approve")
          }}
          disabled={mutation.isPending}
          data-testid="cloud-agent-approve-button"
        >
          <Check className="size-3.5" /> Approve
        </Button>
        <Button
          variant="destructive"
          size="sm"
          onClick={() => {
            mutation.mutate("deny")
          }}
          disabled={mutation.isPending}
          data-testid="cloud-agent-deny-button"
        >
          <X className="size-3.5" /> Deny
        </Button>
        {mutation.isError ? (
          <span className="self-center text-xs text-destructive">
            {mutation.error instanceof Error
              ? mutation.error.message
              : "Approval failed."}
          </span>
        ) : null}
      </div>
    </section>
  )
}

function MessageComposer({
  taskId,
  disabled,
}: {
  taskId: string
  disabled: boolean
}) {
  const [message, setMessage] = useState("")
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: () =>
      sendCloudAgentTaskMessage({ taskId, message: message.trim() }),
    onSuccess: () => {
      setMessage("")
      void queryClient.invalidateQueries({
        queryKey: ["cloud-agent-task-events", taskId],
      })
    },
  })

  if (disabled) {
    return null
  }

  return (
    <form
      className="space-y-2 border border-border bg-background p-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (message.trim().length < 1) return
        mutation.mutate()
      }}
    >
      <Textarea
        value={message}
        onChange={(event) => {
          setMessage(event.target.value)
        }}
        placeholder="Send the cloud agent additional context or instructions..."
        rows={2}
        data-testid="cloud-agent-message-input"
      />
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          Posts as a transcript entry; the agent picks it up on the next step.
        </span>
        <Button
          type="submit"
          size="sm"
          disabled={message.trim().length === 0 || mutation.isPending}
          data-testid="cloud-agent-message-submit"
        >
          {mutation.isPending ? "Sending..." : "Send"}
        </Button>
      </div>
      {mutation.isError ? (
        <p className="text-xs text-destructive">
          {mutation.error instanceof Error
            ? mutation.error.message
            : "Failed to send message."}
        </p>
      ) : null}
    </form>
  )
}

export function CloudAgentTaskDetail({
  taskId,
  initialTask,
}: {
  taskId: string
  initialTask: CloudAgentTask
}) {
  const queryClient = useQueryClient()
  const eventsBottomRef = useRef<HTMLLIElement | null>(null)

  const taskQuery = useQuery({
    queryKey: ["cloud-agent-task", taskId],
    queryFn: () => getCloudAgentTaskDetail(taskId),
    initialData: { task: initialTask, artifacts: [] },
    refetchInterval: (query) =>
      query.state.data?.task &&
      isTerminalCloudAgentTaskStatus(query.state.data.task.status)
        ? false
        : 2_000,
  })

  const task = taskQuery.data.task
  const artifacts = taskQuery.data.artifacts

  const eventsQueryKey = useMemo(
    () => ["cloud-agent-task-events", taskId] as const,
    [taskId]
  )
  const eventsQuery = useQuery({
    queryKey: eventsQueryKey,
    queryFn: async () => {
      const previous =
        queryClient.getQueryData<CloudAgentEventsResponse>(eventsQueryKey)
      const afterSeq = previous?.lastSeq ?? 0
      const next = await getCloudAgentTaskEvents({
        taskId,
        ...(afterSeq > 0 ? { afterSeq } : {}),
      })
      if (!previous || afterSeq === 0) {
        return next
      }
      if (next.events.length === 0) {
        return {
          task: next.task,
          events: previous.events,
          lastSeq: Math.max(previous.lastSeq, next.lastSeq),
        }
      }
      return {
        task: next.task,
        events: [...previous.events, ...next.events],
        lastSeq: next.lastSeq,
      }
    },
    refetchInterval: isTerminalCloudAgentTaskStatus(task.status)
      ? false
      : 1_500,
  })

  useEffect(() => {
    if (isTerminalCloudAgentTaskStatus(task.status)) {
      void eventsQuery.refetch()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.status])

  const events = useMemo(
    () => eventsQuery.data?.events ?? [],
    [eventsQuery.data]
  )

  const latestApproval = useMemo(() => {
    if (task.status !== "waiting_for_approval") {
      return null
    }
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event?.payload.kind === "approval_required") {
        return event.payload
      }
    }
    return null
  }, [events, task.status])

  useEffect(() => {
    eventsBottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [events.length])

  const cancelMutation = useMutation({
    mutationFn: () => cancelCloudAgentTask(taskId),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["cloud-agent-task", taskId],
      })
    },
  })

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6">
      <header className="flex items-center gap-3">
        <Button asChild variant="ghost" size="sm">
          <Link href="/cloud-agents" aria-label="Back to cloud agents">
            <ArrowLeft className="size-4" /> Back
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <h1
            className="truncate font-departureMono text-lg tracking-tight"
            data-testid="cloud-agent-task-prompt"
          >
            {task.prompt}
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span
              className="font-departureMono tracking-[0.18em] uppercase"
              data-testid="cloud-agent-task-status"
            >
              {STATUS_LABELS[task.status]}
            </span>
            {task.phase ? <span>· {task.phase}</span> : null}
            {task.branch ? (
              <span className="font-mono">· {task.branch}</span>
            ) : null}
          </div>
        </div>
        {!isTerminalCloudAgentTaskStatus(task.status) ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              cancelMutation.mutate()
            }}
            disabled={cancelMutation.isPending}
            data-testid="cloud-agent-cancel-button"
          >
            Cancel
          </Button>
        ) : null}
      </header>

      {task.error ? (
        <section className="border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
          {task.error}
        </section>
      ) : null}

      {task.prUrl ? (
        <section className="flex items-center gap-2 border border-emerald-500/40 bg-emerald-50/40 p-3 text-sm dark:bg-emerald-950/20">
          <span className="font-departureMono text-xs tracking-[0.18em] text-emerald-700 uppercase dark:text-emerald-300">
            Pull request
          </span>
          <a
            className="inline-flex items-center gap-1 underline"
            href={task.prUrl}
            target="_blank"
            rel="noreferrer noopener"
            data-testid="cloud-agent-pr-link"
          >
            {task.prUrl}
            <ExternalLink className="size-3" />
          </a>
        </section>
      ) : null}

      {task.previewUrl ? (
        <section className="flex items-center gap-2 border border-emerald-500/40 bg-emerald-50/40 p-3 text-sm dark:bg-emerald-950/20">
          <span className="font-departureMono text-xs tracking-[0.18em] text-emerald-700 uppercase dark:text-emerald-300">
            Preview
          </span>
          <a
            className="inline-flex items-center gap-1 underline"
            href={task.previewUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            {task.previewUrl}
            <ExternalLink className="size-3" />
          </a>
        </section>
      ) : null}

      {latestApproval ? (
        <ApprovalPanel
          taskId={taskId}
          approval={latestApproval}
          onResolved={() => {
            void queryClient.invalidateQueries({
              queryKey: ["cloud-agent-task", taskId],
            })
          }}
        />
      ) : null}

      <section className="border border-border bg-background">
        <header className="flex items-center justify-between border-b border-border/50 px-4 py-2">
          <span className="font-departureMono text-xs tracking-[0.18em] uppercase">
            Activity
          </span>
          <span className="text-xs text-muted-foreground">
            {events.length} event(s)
          </span>
        </header>
        <ul
          className="max-h-[60vh] overflow-y-auto"
          data-testid="cloud-agent-event-list"
        >
          {events.length === 0 ? (
            <li className="px-4 py-6 text-center text-xs text-muted-foreground">
              Waiting for events...
            </li>
          ) : (
            events.map((event) => <EventEntry key={event.id} event={event} />)
          )}
          <li
            aria-hidden
            className="m-0 h-0 list-none p-0"
            ref={eventsBottomRef}
          />
        </ul>
      </section>

      <MessageComposer
        taskId={taskId}
        disabled={isTerminalCloudAgentTaskStatus(task.status)}
      />

      {artifacts.length > 0 ? (
        <section className="border border-border bg-background">
          <header className="border-b border-border/50 px-4 py-2 font-departureMono text-xs tracking-[0.18em] uppercase">
            Artifacts
          </header>
          <ul className="divide-y divide-border/50">
            {artifacts.map((artifact) => (
              <li
                key={artifact.id}
                className="flex items-center gap-3 px-4 py-2"
              >
                <span className="font-departureMono text-[10px] tracking-[0.18em] text-muted-foreground uppercase">
                  {artifact.kind}
                </span>
                <span className="flex-1 truncate text-sm">
                  {artifact.label}
                </span>
                {artifact.url ? (
                  <a
                    href={artifact.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-1 text-xs underline"
                  >
                    open
                    <ExternalLink className="size-3" />
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
