import type { CloudAgentTaskStatus } from "@/lib/shared/cloud-agents"

export const STATUS_LABELS: Record<CloudAgentTaskStatus, string> = {
  queued: "Queued",
  provisioning: "Provisioning",
  setting_up: "Setting up",
  planning: "Planning",
  editing: "Editing",
  testing: "Testing",
  waiting_for_approval: "Awaiting approval",
  pushing: "Pushing",
  pr_ready: "PR ready",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
}

export const STATUS_TONES: Record<CloudAgentTaskStatus, string> = {
  queued: "text-muted-foreground",
  provisioning: "text-foreground",
  setting_up: "text-foreground",
  planning: "text-foreground",
  editing: "text-foreground",
  testing: "text-foreground",
  waiting_for_approval: "text-amber-700 dark:text-amber-300",
  pushing: "text-foreground",
  pr_ready: "text-emerald-700 dark:text-emerald-300",
  completed: "text-emerald-700 dark:text-emerald-300",
  failed: "text-destructive",
  cancelled: "text-muted-foreground",
}
