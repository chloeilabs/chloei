import * as Sentry from "@sentry/nextjs"

import { scrubSentryEvent } from "./src/lib/shared/sentry-scrubbing"

function parseEnabled(value: string | undefined): boolean {
  return ["1", "true", "yes", "on", "enabled"].includes(
    value?.trim().toLowerCase() ?? ""
  )
}

const postHogProjectToken =
  process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN ??
  process.env.NEXT_PUBLIC_POSTHOG_TOKEN
const postHogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST
const postHogAnalyticsEnabled = parseEnabled(
  process.env.NEXT_PUBLIC_POSTHOG_ANALYTICS_ENABLED
)

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  sendDefaultPii: false,
  tracesSampleRate: Number(
    process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? "0"
  ),
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
  integrations: [],
  beforeSend: scrubSentryEvent,
})

if (postHogAnalyticsEnabled && postHogProjectToken && postHogHost) {
  void Promise.all([
    import("posthog-js"),
    import("./src/lib/shared/posthog-scrubbing"),
  ])
    .then(([posthogModule, { scrubPostHogEvent }]) => {
      posthogModule.default.init(postHogProjectToken, {
        api_host: postHogHost,
        defaults: "2026-01-30",
        autocapture: false,
        capture_pageview: false,
        capture_pageleave: false,
        capture_dead_clicks: false,
        disable_session_recording: true,
        disable_surveys: true,
        mask_all_text: true,
        mask_all_element_attributes: true,
        person_profiles: "identified_only",
        advanced_disable_feature_flags: true,
        property_denylist: [
          "prompt",
          "completion",
          "content",
          "message",
          "attachment",
          "filename",
          "pathname",
          "url",
          "email",
          "name",
          "token",
          "secret",
          "api_key",
        ],
        before_send: scrubPostHogEvent,
      })
    })
    .catch(() => undefined)
}

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart
