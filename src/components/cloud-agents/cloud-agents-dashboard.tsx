"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronRight, Plus, Trash2 } from "lucide-react"
import Link from "next/link"
import { useId, useState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import type {
  CloudAgentEnvironment,
  CloudAgentTask,
  CloudAgentTaskStatus,
} from "@/lib/shared/cloud-agents"

import {
  createCloudAgentEnvironment,
  createCloudAgentTask,
  deleteCloudAgentEnvironment,
  listCloudAgentEnvironments,
  listCloudAgentTasks,
} from "./cloud-agent-api"
import { STATUS_LABELS, STATUS_TONES } from "./cloud-agent-status-labels"

function StatusPill({ status }: { status: CloudAgentTaskStatus }) {
  return (
    <span
      className={`border border-border bg-background/60 px-1.5 py-0.5 font-departureMono text-[10px] tracking-[0.18em] uppercase ${STATUS_TONES[status]}`}
      data-testid={`cloud-agent-task-status-${status}`}
    >
      {STATUS_LABELS[status]}
    </span>
  )
}

function TaskRow({ task }: { task: CloudAgentTask }) {
  return (
    <Link
      href={`/cloud-agents/${task.id}`}
      className="group flex items-center gap-3 border-b border-border/50 px-4 py-3 transition-colors hover:bg-muted/40"
      data-testid={`cloud-agent-task-row-${task.id}`}
    >
      <StatusPill status={task.status} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">
          {task.prompt}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {task.phase ? <span>{task.phase}</span> : <span>{task.id}</span>}
          {task.branch ? (
            <>
              <span aria-hidden>•</span>
              <span className="truncate font-mono">{task.branch}</span>
            </>
          ) : null}
        </div>
      </div>
      <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </Link>
  )
}

function NewTaskForm({
  environmentId,
  onCreated,
}: {
  environmentId: string
  onCreated: () => void
}) {
  const [prompt, setPrompt] = useState("")
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: () =>
      createCloudAgentTask({ environmentId, prompt: prompt.trim() }),
    onSuccess: () => {
      setPrompt("")
      void queryClient.invalidateQueries({ queryKey: ["cloud-agent-tasks"] })
      onCreated()
    },
  })

  return (
    <form
      className="flex flex-col gap-2 border-t border-border/50 bg-muted/20 px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (prompt.trim().length < 1) return
        mutation.mutate()
      }}
    >
      <Textarea
        placeholder="Describe the change you want the cloud agent to make..."
        value={prompt}
        onChange={(event) => {
          setPrompt(event.target.value)
        }}
        rows={3}
        data-testid={`cloud-agent-new-task-prompt-${environmentId}`}
      />
      {mutation.isError ? (
        <p className="text-xs text-destructive">
          {mutation.error instanceof Error
            ? mutation.error.message
            : "Failed to start task."}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button
          type="submit"
          size="sm"
          disabled={prompt.trim().length === 0 || mutation.isPending}
          data-testid={`cloud-agent-new-task-submit-${environmentId}`}
        >
          {mutation.isPending ? "Starting..." : "Start task"}
        </Button>
      </div>
    </form>
  )
}

function EnvironmentCard({
  environment,
  tasks,
}: {
  environment: CloudAgentEnvironment
  tasks: CloudAgentTask[]
}) {
  const [showForm, setShowForm] = useState(false)
  const queryClient = useQueryClient()
  const deleteMutation = useMutation({
    mutationFn: () => deleteCloudAgentEnvironment(environment.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["cloud-agent-environments"],
      })
      void queryClient.invalidateQueries({
        queryKey: ["cloud-agent-tasks"],
      })
    },
  })

  return (
    <section
      className="border border-border bg-background"
      data-testid={`cloud-agent-environment-${environment.id}`}
    >
      <header className="flex items-center gap-3 border-b border-border/50 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="truncate font-departureMono text-sm tracking-tight">
            {environment.name}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {environment.repoOwner}/{environment.repoName} ·{" "}
            {environment.baseBranch}
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setShowForm((prev) => !prev)
          }}
          data-testid={`cloud-agent-environment-toggle-${environment.id}`}
        >
          <Plus className="size-3.5" /> New task
        </Button>
        <Button
          variant="ghost"
          size="iconSm"
          aria-label="Delete environment"
          onClick={() => {
            if (
              window.confirm(
                `Delete environment "${environment.name}"? Active tasks will also be removed.`
              )
            ) {
              deleteMutation.mutate()
            }
          }}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </header>
      {showForm ? (
        <NewTaskForm
          environmentId={environment.id}
          onCreated={() => {
            setShowForm(false)
          }}
        />
      ) : null}
      {tasks.length === 0 ? (
        <p className="px-4 py-3 text-xs text-muted-foreground">No tasks yet.</p>
      ) : (
        <div data-testid={`cloud-agent-environment-tasks-${environment.id}`}>
          {tasks.map((task) => (
            <TaskRow key={task.id} task={task} />
          ))}
        </div>
      )}
    </section>
  )
}

function NewEnvironmentForm({ onClose }: { onClose: () => void }) {
  const idPrefix = useId()
  const [name, setName] = useState("")
  const [repoOwner, setRepoOwner] = useState("")
  const [repoName, setRepoName] = useState("")
  const [baseBranch, setBaseBranch] = useState("main")
  const [setupCommand, setSetupCommand] = useState("")
  const [testCommand, setTestCommand] = useState("")
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: () =>
      createCloudAgentEnvironment({
        name: name.trim(),
        repoOwner: repoOwner.trim(),
        repoName: repoName.trim(),
        baseBranch: baseBranch.trim() || "main",
        ...(setupCommand.trim() ? { setupCommand: setupCommand.trim() } : {}),
        ...(testCommand.trim() ? { testCommand: testCommand.trim() } : {}),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["cloud-agent-environments"],
      })
      onClose()
    },
  })

  return (
    <form
      className="space-y-3 border border-border bg-background p-4"
      onSubmit={(event) => {
        event.preventDefault()
        mutation.mutate()
      }}
      data-testid="cloud-agent-new-environment-form"
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="space-y-1 text-xs">
          <label
            htmlFor={`${idPrefix}-name`}
            className="font-departureMono tracking-[0.18em] text-muted-foreground uppercase"
          >
            Name
          </label>
          <Input
            id={`${idPrefix}-name`}
            value={name}
            onChange={(event) => {
              setName(event.target.value)
            }}
            placeholder="Production web"
            required
            data-testid="cloud-agent-env-name"
          />
        </div>
        <div className="space-y-1 text-xs">
          <label
            htmlFor={`${idPrefix}-base-branch`}
            className="font-departureMono tracking-[0.18em] text-muted-foreground uppercase"
          >
            Base branch
          </label>
          <Input
            id={`${idPrefix}-base-branch`}
            value={baseBranch}
            onChange={(event) => {
              setBaseBranch(event.target.value)
            }}
            placeholder="main"
          />
        </div>
        <div className="space-y-1 text-xs">
          <label
            htmlFor={`${idPrefix}-repo-owner`}
            className="font-departureMono tracking-[0.18em] text-muted-foreground uppercase"
          >
            Repo owner
          </label>
          <Input
            id={`${idPrefix}-repo-owner`}
            value={repoOwner}
            onChange={(event) => {
              setRepoOwner(event.target.value)
            }}
            placeholder="chloeilabs"
            required
            data-testid="cloud-agent-env-repo-owner"
          />
        </div>
        <div className="space-y-1 text-xs">
          <label
            htmlFor={`${idPrefix}-repo-name`}
            className="font-departureMono tracking-[0.18em] text-muted-foreground uppercase"
          >
            Repo name
          </label>
          <Input
            id={`${idPrefix}-repo-name`}
            value={repoName}
            onChange={(event) => {
              setRepoName(event.target.value)
            }}
            placeholder="chloei"
            required
            data-testid="cloud-agent-env-repo-name"
          />
        </div>
        <div className="space-y-1 text-xs md:col-span-2">
          <label
            htmlFor={`${idPrefix}-setup-command`}
            className="font-departureMono tracking-[0.18em] text-muted-foreground uppercase"
          >
            Setup command (optional)
          </label>
          <Input
            id={`${idPrefix}-setup-command`}
            value={setupCommand}
            onChange={(event) => {
              setSetupCommand(event.target.value)
            }}
            placeholder="pnpm install"
          />
        </div>
        <div className="space-y-1 text-xs md:col-span-2">
          <label
            htmlFor={`${idPrefix}-test-command`}
            className="font-departureMono tracking-[0.18em] text-muted-foreground uppercase"
          >
            Test command (optional)
          </label>
          <Input
            id={`${idPrefix}-test-command`}
            value={testCommand}
            onChange={(event) => {
              setTestCommand(event.target.value)
            }}
            placeholder="pnpm test"
          />
        </div>
      </div>
      {mutation.isError ? (
        <p className="text-xs text-destructive">
          {mutation.error instanceof Error
            ? mutation.error.message
            : "Failed to create environment."}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={mutation.isPending}
          data-testid="cloud-agent-env-submit"
        >
          {mutation.isPending ? "Saving..." : "Save environment"}
        </Button>
      </div>
    </form>
  )
}

export function CloudAgentsDashboard({
  initialEnvironments,
  initialTasks,
}: {
  initialEnvironments: CloudAgentEnvironment[]
  initialTasks: CloudAgentTask[]
}) {
  const [showEnvForm, setShowEnvForm] = useState(false)
  const environmentsQuery = useQuery({
    queryKey: ["cloud-agent-environments"],
    queryFn: listCloudAgentEnvironments,
    initialData: initialEnvironments,
  })
  const tasksQuery = useQuery({
    queryKey: ["cloud-agent-tasks"],
    queryFn: () => listCloudAgentTasks(),
    initialData: initialTasks,
    refetchInterval: 2_500,
  })

  const environments = environmentsQuery.data
  const tasks = tasksQuery.data
  const tasksByEnvironment = new Map<string, CloudAgentTask[]>()
  for (const task of tasks) {
    const list = tasksByEnvironment.get(task.environmentId) ?? []
    list.push(task)
    tasksByEnvironment.set(task.environmentId, list)
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="font-departureMono text-xl tracking-tight">
            Cloud agents
          </h1>
          <p className="text-sm text-muted-foreground">
            Long-running coding tasks in isolated sandboxes.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setShowEnvForm((prev) => !prev)
          }}
          data-testid="cloud-agent-new-env-toggle"
        >
          <Plus className="size-3.5" /> New environment
        </Button>
      </header>

      {showEnvForm ? (
        <NewEnvironmentForm
          onClose={() => {
            setShowEnvForm(false)
          }}
        />
      ) : null}

      {environments.length === 0 ? (
        <section className="border border-dashed border-border bg-background p-8 text-center">
          <h2 className="font-departureMono text-sm tracking-[0.18em] text-muted-foreground uppercase">
            No environments yet
          </h2>
          <p className="mt-2 text-sm text-foreground">
            Create an environment to point Chloei at a repo, base branch, and
            setup command.
          </p>
        </section>
      ) : (
        <div className="space-y-4">
          {environments.map((environment) => (
            <EnvironmentCard
              key={environment.id}
              environment={environment}
              tasks={tasksByEnvironment.get(environment.id) ?? []}
            />
          ))}
        </div>
      )}
    </div>
  )
}
