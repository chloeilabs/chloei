import { serve } from "inngest/next"

import { inngest } from "@/lib/server/inngest/client"
import { inngestFunctions } from "@/lib/server/inngest/functions"

export const runtime = "nodejs"
// The Trading Desk analysis runs synchronously inside a single Inngest step
// served by this route, so the function must stay alive for the whole run. A
// deep run is many sequential model calls and can take many minutes; 800s is
// Vercel's max on this plan (matches /api/agent and /api/trading-desk/analyze).
// The sidecar request timeout (TRADINGAGENTS_REQUEST_TIMEOUT_MS, ~780s) is set
// just under this so a stuck run aborts and is marked failed *before* the
// platform hard-kills the invocation — a hard-kill leaves the job stuck
// "running" and triggers expensive Inngest retries.
export const maxDuration = 800

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: inngestFunctions,
})
