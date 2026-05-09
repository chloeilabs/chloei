# Managed Integrations Rollout

Last verified: May 9, 2026, 4:30 PM CDT.

This runbook covers the Chloei managed integration stack for financial-services
agent capabilities. The default posture is privacy-first: all new production
capabilities stay off unless a documented rollout step enables them, and raw
prompts, completions, attachment contents, account data, credentials, and PII
must not be sent to telemetry providers.

## Current Live State

`vercel integration list chloei` should show exactly one available resource for
each managed capability, all connected to the `chloei` project:

| Resource                  | Product        | Purpose                                        |
| ------------------------- | -------------- | ---------------------------------------------- |
| `chloei-posthog`          | PostHog        | Product analytics and rollout flags            |
| `chloei-sentry`           | Sentry         | Errors, performance traces, source maps        |
| `chloei-braintrust`       | Braintrust     | Finance eval publication and trace correlation |
| `chloei-knowledge-search` | Upstash Search | Governed static knowledge retrieval            |
| `chloei-browserbase`      | Browserbase    | Consented dynamic browser automation           |
| `chloei-workflows`        | Inngest        | Durable agent workflows and jobs               |
| `chloei-db`               | Neon           | Primary PostgreSQL system of record            |

There should be no duplicate project-level Sentry or PostHog resources. If the
Vercel integrations console shows an extra product tile that is not connected to
`chloei`, confirm no other project uses it before removing it from the
integration console.

The current production deployment should be `Ready`, aliased to `chloei.ai`,
and expose `/api/inngest` with `x-inngest-sdk-handled: true`. An unsigned
`GET /api/inngest` returning `401` is expected because Inngest signature
validation is working.

## Environment Scope

Production is intentionally locked down:

```text
AGENT_ENABLE_NEW_CAPABILITIES_FOR_INTERNAL_USERS=false
AGENT_KNOWLEDGE_SEARCH_ENABLED=false
AGENT_BROWSERBASE_ENABLED=false
AGENT_ASYNC_REPORTS_ENABLED=false
AGENT_TELEMETRY_RECORD_IO=false
AGENT_FINANCE_WORKFLOWS_ENABLED=false
POSTHOG_ANALYTICS_ENABLED=false
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
AGENT_BROWSERBASE_ENABLED=false
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
`src/lib/server/integration-flags.ts`. Resolution order matters:

1. Explicit `AGENT_*` or `POSTHOG_*` environment variables.
2. Edge Config values from `agent_flags`, `analytics_flags`, or `flags`.
3. Built-in defaults.

Because Production currently has explicit `AGENT_*_ENABLED=false` values, those
values override Edge Config and PostHog flag changes. This is intentional while
the rollout is paused.

Edge Config store `chloei-flags` should contain these false values:

```json
{
  "flags": {
    "agent-knowledge-search-enabled": false,
    "agent-browserbase-enabled": false,
    "agent-async-reports-enabled": false,
    "agent-telemetry-record-io": false,
    "agent-finance-workflows-enabled": false,
    "analytics-posthog-enabled": false
  }
}
```

PostHog project `posthog-chloei-labs` has matching inactive feature flags with
zero rollout. The app does not directly evaluate PostHog flags at runtime; Edge
Config and environment variables remain the enforcement layer.

## Production Rollout

For internal-only production rollout of knowledge search, async reports, and
finance workflows:

1. Confirm `AGENT_INTERNAL_USER_EMAILS` or `AGENT_INTERNAL_USER_EMAIL_DOMAINS`
   only includes internal test users.
2. Remove the explicit production env overrides for the capabilities being
   internally enabled:

   ```bash
   vercel env rm AGENT_KNOWLEDGE_SEARCH_ENABLED production --yes
   vercel env rm AGENT_ASYNC_REPORTS_ENABLED production --yes
   vercel env rm AGENT_FINANCE_WORKFLOWS_ENABLED production --yes
   ```

3. Enable internal defaults:

   ```bash
   vercel env add AGENT_ENABLE_NEW_CAPABILITIES_FOR_INTERNAL_USERS production --value true --force --yes
   ```

4. Redeploy production so the runtime sees the new env set:

   ```bash
   vercel redeploy https://chloei.ai
   ```

Keep `AGENT_BROWSERBASE_ENABLED=false` until there is an explicit user-consent
smoke for allowlisted domains. Keep `AGENT_TELEMETRY_RECORD_IO=false` unless a
separate privacy review approves raw prompt/output capture for a controlled
non-production eval cohort.

For PostHog server-side product analytics, prefer:

```bash
vercel env add POSTHOG_ANALYTICS_ENABLED production --value true --force --yes
vercel env add POSTHOG_ANALYTICS_INTERNAL_USERS_ONLY production --value true --force --yes
```

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
6. Flip each flag off and confirm the capability disappears without redeploy
   when the flag is Edge Config controlled; redeploy is required when the change
   is an environment variable.

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
pnpm eval:finance:braintrust
```

The finance eval gate should fail on regressions in citation presence, numerical
consistency, current-date handling, unsupported financial-advice boundaries, and
tool selection for live market facts.

## Rollback

Fastest capability rollback:

```bash
vercel env add AGENT_KNOWLEDGE_SEARCH_ENABLED production --value false --force --yes
vercel env add AGENT_BROWSERBASE_ENABLED production --value false --force --yes
vercel env add AGENT_ASYNC_REPORTS_ENABLED production --value false --force --yes
vercel env add AGENT_TELEMETRY_RECORD_IO production --value false --force --yes
vercel env add AGENT_FINANCE_WORKFLOWS_ENABLED production --value false --force --yes
vercel env add POSTHOG_ANALYTICS_ENABLED production --value false --force --yes
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
- Browserbase requires an enabled flag, explicit user consent, a start URL, and
  an allowlist. It must not collect or store credentials.
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
vercel logs https://chloei.ai --since 30m --level error --no-follow
```
