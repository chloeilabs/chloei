# Managed Integrations Rollout

Last verified: May 16, 2026.

This runbook covers the Chloei managed integration stack for financial-services
agent capabilities. The default posture is privacy-first: all new production
capabilities stay off unless a documented rollout step enables them, and raw
prompts, completions, attachment contents, account data, credentials, and PII
must not be sent to telemetry providers.

## Current Live State

`vercel integration list chloei` should show exactly one available resource for
each managed capability, all connected to the `chloei` project:

| Resource                  | Product        | Purpose                                 |
| ------------------------- | -------------- | --------------------------------------- |
| `chloei-posthog`          | PostHog        | Product analytics and rollout flags     |
| `chloei-sentry`           | Sentry         | Errors, performance traces, source maps |
| `chloei-knowledge-search` | Upstash Search | Governed static knowledge retrieval     |
| `chloei-workflows`        | Inngest        | Durable agent workflows and jobs        |
| `chloei-db`               | Neon           | Primary PostgreSQL system of record     |

There should be no duplicate project-level Sentry or PostHog resources. If the
Vercel integrations console shows an extra product tile that is not connected to
`chloei`, confirm no other project uses it before removing it from the
integration console.

The current production deployment should be `Ready`, aliased to `chloei.ai`,
and expose `/api/inngest` with `x-inngest-sdk-handled: true`. An unsigned
`GET /api/inngest` returning `401` is expected because Inngest signature
validation is working.

## Environment Scope

Production is in internal-only rollout for governed knowledge search, async
reports, and finance workflows:

```text
AGENT_ENABLE_NEW_CAPABILITIES_FOR_INTERNAL_USERS=true
AGENT_KNOWLEDGE_SEARCH_ENABLED=<unset>
AGENT_ASYNC_REPORTS_ENABLED=<unset>
AGENT_TELEMETRY_RECORD_IO=false
AGENT_FINANCE_WORKFLOWS_ENABLED=<unset>
POSTHOG_ANALYTICS_ENABLED=true
NEXT_PUBLIC_POSTHOG_ANALYTICS_ENABLED=false
POSTHOG_ANALYTICS_INTERNAL_USERS_ONLY=true
INNGEST_INLINE_FALLBACK=<unset>
UPSTASH_DISABLE_TELEMETRY=1
```

Preview is the integration test surface:

```text
AGENT_KNOWLEDGE_SEARCH_ENABLED=true
AGENT_ASYNC_REPORTS_ENABLED=true
AGENT_FINANCE_WORKFLOWS_ENABLED=true
AGENT_TELEMETRY_RECORD_IO=false
POSTHOG_ANALYTICS_ENABLED=true
NEXT_PUBLIC_POSTHOG_ANALYTICS_ENABLED=true
POSTHOG_ANALYTICS_INTERNAL_USERS_ONLY=true
INNGEST_INLINE_FALLBACK=1
UPSTASH_DISABLE_TELEMETRY=1
```

Development mirrors the locked-down defaults, with `INNGEST_INLINE_FALLBACK=1`
for local work. `POSTHOG_ANALYTICS_ENABLED` was normalized to a clean `false`
value in Production and Development on May 9, 2026.

## Flag Sources

Runtime flag resolution is implemented in
`src/lib/server/integration-flags.ts`. Effective precedence is:

1. Explicit `AGENT_*` or `POSTHOG_*` environment variables.
2. Edge Config values from `agent_flags`, `analytics_flags`, or `flags`.
3. Internal-user defaults when
   `AGENT_ENABLE_NEW_CAPABILITIES_FOR_INTERNAL_USERS=true`.
4. Built-in defaults.

Edge Config values for a capability key override internal-user defaults. During
the internal-only production rollout, the global rollout keys for knowledge
search, async reports, and finance workflows must stay absent from Edge Config.
Raw telemetry IO remains explicitly false in both environment variables and
Edge Config.

Edge Config store `chloei-flags` should contain:

```json
{
  "agent_flags": {
    "agent.telemetry.record_io": false
  },
  "flags": {
    "agent-telemetry-record-io": false,
    "analytics-posthog-enabled": false
  },
  "analytics_flags": {
    "analytics.posthog.enabled": false
  }
}
```

PostHog project `posthog-chloei-labs` has matching inactive feature flags with
zero rollout. The app does not directly evaluate PostHog flags at runtime; Edge
Config and environment variables remain the enforcement layer.

## Production Rollout

The internal-only rollout is already active in Production. To recreate it from a
fully locked-down state:

1. Confirm `AGENT_INTERNAL_USER_EMAILS` or `AGENT_INTERNAL_USER_EMAIL_DOMAINS`
   only includes internal test users.
2. Remove the global Edge Config false values for the capabilities being
   internally enabled:

   ```bash
   vercel edge-config update chloei-flags --scope chloei --patch '{"items":[{"operation":"update","key":"agent_flags","value":{"agent.telemetry.record_io":false}},{"operation":"update","key":"flags","value":{"agent-telemetry-record-io":false,"analytics-posthog-enabled":false}},{"operation":"update","key":"analytics_flags","value":{"analytics.posthog.enabled":false}}]}'
   ```

3. Remove the explicit production env overrides for the capabilities being
   internally enabled:

   ```bash
   vercel env rm AGENT_KNOWLEDGE_SEARCH_ENABLED production --yes
   vercel env rm AGENT_ASYNC_REPORTS_ENABLED production --yes
   vercel env rm AGENT_FINANCE_WORKFLOWS_ENABLED production --yes
   ```

4. Enable internal defaults and internal-only server-side analytics:

   ```bash
   printf '%s' true | vercel env add AGENT_ENABLE_NEW_CAPABILITIES_FOR_INTERNAL_USERS production --force --yes
   printf '%s' true | vercel env add POSTHOG_ANALYTICS_ENABLED production --force --yes
   printf '%s' true | vercel env add POSTHOG_ANALYTICS_INTERNAL_USERS_ONLY production --force --yes
   ```

5. Redeploy production so the runtime sees the new env set:

   ```bash
   vercel redeploy https://chloei.ai
   ```

6. Sync the Inngest app after production deploy:

   ```bash
   curl -sS -X PUT https://chloei.ai/api/inngest
   ```

   Expected response includes `"Successfully registered"`.

Keep `AGENT_TELEMETRY_RECORD_IO=false` unless a separate privacy review approves
raw prompt/output capture for a controlled non-production eval cohort.

Leave `NEXT_PUBLIC_POSTHOG_ANALYTICS_ENABLED=false` for production unless client
analytics receives a separate privacy review.

## Smoke Tests

Production-safe unauthenticated checks:

```bash
curl -sS -o /tmp/chloei-root.txt -D /tmp/chloei-root.headers https://chloei.ai/
curl -sS -o /tmp/chloei-models.txt -D /tmp/chloei-models.headers https://chloei.ai/api/models
curl -sS -o /tmp/chloei-inngest.txt -D /tmp/chloei-inngest.headers https://chloei.ai/api/inngest
vercel logs https://chloei.ai --since 30m --level error --no-follow
```

Expected results:

- `/` redirects to `/sign-in`.
- `/api/models` returns `401` when unauthenticated.
- `/api/inngest` returns `401` with `x-inngest-sdk-handled: true` when unsigned.
- No unexpected production errors appear in Vercel logs.

Authenticated rollout smoke after internal production flags are enabled:

1. Sign in as an internal user.
2. Upload a non-sensitive test document and confirm it is stored through private
   Blob metadata only.
3. Search for the document through `knowledge_search` and verify citations,
   source type, as-of date, and owner scoping.
4. Enqueue a report through `POST /api/jobs/report` and poll `GET /api/jobs/:id`.
5. Verify Sentry receives errors/traces without PII and that PostHog receives
   only scrubbed internal-user product events if analytics is enabled.
6. Confirm an external test user still receives `JOB_REPORT_DISABLED` for async
   reports.

## Quality Gates

Before broadening rollout, run:

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm test:smoke:mock
pnpm eval:finance
pnpm eval:finance:grade
```

The finance eval gate should fail on regressions in citation presence, numerical
consistency, current-date handling, unsupported financial-advice boundaries, and
tool selection for live market facts.

## Rollback

Fastest capability rollback:

```bash
printf '%s' false | vercel env add AGENT_KNOWLEDGE_SEARCH_ENABLED production --force --yes
printf '%s' false | vercel env add AGENT_ASYNC_REPORTS_ENABLED production --force --yes
printf '%s' false | vercel env add AGENT_TELEMETRY_RECORD_IO production --force --yes
printf '%s' false | vercel env add AGENT_FINANCE_WORKFLOWS_ENABLED production --force --yes
printf '%s' false | vercel env add POSTHOG_ANALYTICS_ENABLED production --force --yes
vercel edge-config update chloei-flags --scope chloei --patch '{"items":[{"operation":"update","key":"agent_flags","value":{"agent.knowledge_search.enabled":false,"agent.async_reports.enabled":false,"agent.telemetry.record_io":false,"agent.finance_workflows.enabled":false}},{"operation":"update","key":"flags","value":{"agent-knowledge-search-enabled":false,"agent-async-reports-enabled":false,"agent-telemetry-record-io":false,"agent-finance-workflows-enabled":false,"analytics-posthog-enabled":false}},{"operation":"update","key":"analytics_flags","value":{"analytics.posthog.enabled":false}}]}'
vercel redeploy https://chloei.ai
```

If code rollback is required, pick the last known good production deployment and
run:

```bash
vercel rollback <deployment-id-or-url>
vercel rollback status --timeout 30s
```

Also deactivate the matching PostHog flags and restore the `chloei-flags` Edge
Config values to false.

## Operating Rules

- Keep Neon as the only PostgreSQL system of record.
- Use Upstash Search only for governed static/internal material. Live financial
  facts stay routed through `finance_data`, SEC, FRED, FMP, Tavily, and AI
  Gateway web search.
- `browser_research` is retired as a live tool; the shared tool name remains
  only for historical thread payload compatibility.
- Private Blob downloads must go through authenticated app routes, never direct
  public URLs.
- Inngest events must use idempotency keys derived from user, document, report,
  or thread identifiers, not prompt text or document contents.
- Sentry replay stays disabled and Sentry/PostHog scrubbing must remain in place.
- Do not commit personal PostHog MCP API keys. Install local MCP per user with
  `npx @posthog/wizard mcp add --region us --project-id 416704` when a local
  editor needs direct PostHog access.

## Verification Commands

```bash
vercel integration list chloei
vercel integration installations
vercel env ls
vercel env pull /tmp/chloei-production.env --environment=production --yes
vercel edge-config items chloei-flags
vercel inspect https://chloei.ai
curl -sS -X PUT https://chloei.ai/api/inngest
vercel logs https://chloei.ai --since 30m --level error --no-follow
```
