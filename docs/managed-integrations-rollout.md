# Managed Integrations Rollout

Last verified: June 14, 2026.

This runbook covers the Chloei managed integration stack for financial-services
agent capabilities. The default posture is privacy-first: all new production
capabilities stay off unless a documented rollout step enables them, and raw
prompts, completions, attachment contents, account data, credentials, and PII
must not be sent to telemetry providers.

> Telemetry note: Chloei no longer ships a third-party error/analytics SDK.
> Sentry, PostHog, and OpenTelemetry were removed; error tracking is via Vercel
> runtime logs (structured JSON from `src/lib/logger.ts`) and product analytics
> via Vercel Web Analytics + Speed Insights. Update this runbook if a managed
> error tracker is reintroduced.

## Current Live State

`vercel integration list chloei` should show exactly one available resource for
each managed capability, all connected to the `chloei` project:

| Resource    | Product | Purpose                             |
| ----------- | ------- | ----------------------------------- |
| `chloei-db` | Neon    | Primary PostgreSQL system of record |

The current production deployment should be `Ready` and aliased to `chloei.ai`.

## Environment Scope

Production is in internal-only rollout for finance workflows:

```text
AGENT_ENABLE_NEW_CAPABILITIES_FOR_INTERNAL_USERS=true
AGENT_TELEMETRY_RECORD_IO=false
AGENT_FINANCE_WORKFLOWS_ENABLED=<unset>
```

Preview is the integration test surface:

```text
AGENT_FINANCE_WORKFLOWS_ENABLED=true
AGENT_TELEMETRY_RECORD_IO=false
```

Development mirrors the locked-down defaults.

## Flag Sources

Runtime flag resolution is implemented in
`src/lib/server/integration-flags.ts`. Effective precedence is:

1. Explicit `AGENT_*` environment variables.
2. Edge Config values from `agent_flags`, `analytics_flags`, or `flags`.
3. Internal-user defaults when
   `AGENT_ENABLE_NEW_CAPABILITIES_FOR_INTERNAL_USERS=true`.
4. Built-in defaults.

Edge Config values for a capability key override internal-user defaults. During
the internal-only production rollout, the global rollout key for finance
workflows must stay absent from Edge Config. Raw telemetry IO remains explicitly
false in both environment variables and Edge Config.

Edge Config store `chloei-flags` should contain:

```json
{
  "agent_flags": {
    "agent.telemetry.record_io": false
  },
  "flags": {
    "agent-telemetry-record-io": false
  }
}
```

Edge Config and environment variables remain the enforcement layer for runtime
flag evaluation.

## Production Rollout

The internal-only rollout is already active in Production. To recreate it from a
fully locked-down state:

1. Confirm `AGENT_INTERNAL_USER_EMAILS` or `AGENT_INTERNAL_USER_EMAIL_DOMAINS`
   only includes internal test users.
2. Remove the global Edge Config false values for the capabilities being
   internally enabled:

   ```bash
   vercel edge-config update chloei-flags --scope chloei --patch '{"items":[{"operation":"update","key":"agent_flags","value":{"agent.telemetry.record_io":false}},{"operation":"update","key":"flags","value":{"agent-telemetry-record-io":false}}]}'
   ```

3. Remove the explicit production env overrides for the capabilities being
   internally enabled:

   ```bash
   vercel env rm AGENT_FINANCE_WORKFLOWS_ENABLED production --yes
   ```

4. Enable internal defaults:

   ```bash
   printf '%s' true | vercel env add AGENT_ENABLE_NEW_CAPABILITIES_FOR_INTERNAL_USERS production --force --yes
   ```

5. Redeploy production so the runtime sees the new env set:

   ```bash
   vercel redeploy https://chloei.ai
   ```

Keep `AGENT_TELEMETRY_RECORD_IO=false` unless a separate privacy review approves
raw prompt/output capture for a controlled non-production eval cohort.

## Smoke Tests

Production-safe unauthenticated checks:

```bash
curl -sS -o /tmp/chloei-root.txt -D /tmp/chloei-root.headers https://chloei.ai/
curl -sS -o /tmp/chloei-models.txt -D /tmp/chloei-models.headers https://chloei.ai/api/models
vercel logs https://chloei.ai --since 30m --level error --no-follow
```

Expected results:

- `/` redirects to `/sign-in`.
- `/api/models` returns `401` when unauthenticated.
- No unexpected production errors appear in Vercel logs.

Authenticated rollout smoke after internal production flags are enabled:

1. Sign in as an internal user.
2. Upload a non-sensitive test document and confirm it is stored through private
   Blob metadata only.
3. Run a finance-analysis chat and confirm the financial-services workflow block
   resolves for the internal user (and not for an external test user).
4. Confirm Vercel runtime logs capture the request/outcome without raw prompts,
   completions, or PII (`vercel logs https://chloei.ai --since 30m`).

## Quality Gates

Before broadening rollout, run:

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm test:smoke:mock:build
```

Public-markets finance answer quality (citation presence, numerical consistency,
current-date handling, unsupported financial-advice boundaries, and tool selection
for live market facts) is verified manually against the checklist in
[docs/finance-research-quality.md](finance-research-quality.md).

## Rollback

Fastest capability rollback:

```bash
printf '%s' false | vercel env add AGENT_TELEMETRY_RECORD_IO production --force --yes
printf '%s' false | vercel env add AGENT_FINANCE_WORKFLOWS_ENABLED production --force --yes
vercel edge-config update chloei-flags --scope chloei --patch '{"items":[{"operation":"update","key":"agent_flags","value":{"agent.telemetry.record_io":false,"agent.finance_workflows.enabled":false}},{"operation":"update","key":"flags","value":{"agent-telemetry-record-io":false,"agent-finance-workflows-enabled":false}}]}'
vercel redeploy https://chloei.ai
```

If code rollback is required, pick the last known good production deployment and
run:

```bash
vercel rollback <deployment-id-or-url>
vercel rollback status --timeout 30s
```

Also restore the `chloei-flags` Edge Config values to false.

## Operating Rules

- Keep Neon as the only PostgreSQL system of record.
- Live financial facts stay routed through `finance_data`, SEC, and Tavily.
- Private Blob downloads must go through authenticated app routes, never direct
  public URLs.
- Raw prompts, completions, attachment contents, and PII must never be written
  to logs or telemetry; `AGENT_TELEMETRY_RECORD_IO` must stay `false` outside an
  approved, controlled eval cohort.

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
