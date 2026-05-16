const dispatched = []

export function getDispatchedTasks() {
  return [...dispatched]
}

export function resetDispatchedTasks() {
  dispatched.length = 0
}

export async function dispatchCloudAgentTaskRequested(params) {
  dispatched.push({ userId: params.userId, taskId: params.taskId })
  return { delivery: "inline" }
}

export async function dispatchCloudAgentApprovalReceived(params) {
  dispatched.push({ approval: params.taskId, approved: params.approved })
  return { delivery: "inline" }
}
