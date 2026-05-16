import { randomUUID } from "node:crypto"

import type {
  CloudAgentApprovalAction,
  CloudAgentApprovalRequiredEvent,
} from "@/lib/shared/cloud-agents"

export function requestCloudAgentApproval(params: {
  userId: string
  taskId: string
  action: CloudAgentApprovalAction
  reason: string
}): { event: CloudAgentApprovalRequiredEvent } {
  return {
    event: {
      kind: "approval_required",
      approvalId: randomUUID(),
      action: params.action,
      reason: params.reason,
    },
  }
}
