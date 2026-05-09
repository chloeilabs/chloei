import * as Sentry from "@sentry/nextjs"
import { registerOTel } from "@vercel/otel"

export async function register() {
  registerOTel({
    serviceName: process.env.OTEL_SERVICE_NAME?.trim() ?? "chloei",
  })

  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config")
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config")
  }
}

export const onRequestError = Sentry.captureRequestError
