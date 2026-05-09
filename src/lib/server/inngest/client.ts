import { Inngest } from "inngest"

import { resolveInngestEnvironmentName } from "./environment"

const inngestEnvironmentName = resolveInngestEnvironmentName()

export const inngest = new Inngest({
  id: "chloei",
  eventKey: process.env.INNGEST_EVENT_KEY,
  signingKey: process.env.INNGEST_SIGNING_KEY,
  ...(inngestEnvironmentName ? { env: inngestEnvironmentName } : {}),
  isDev: process.env.INNGEST_DEV === "1" || process.env.INNGEST_DEV === "true",
})
