import * as Sentry from "@sentry/nextjs"

import { scrubSentryEvent } from "./src/lib/shared/sentry-scrubbing"

Sentry.init({
  dsn: process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN,
  sendDefaultPii: false,
  tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "0"),
  beforeSend: scrubSentryEvent,
})
