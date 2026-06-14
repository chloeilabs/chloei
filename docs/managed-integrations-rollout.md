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

| Resource           | Product | Purpose                             |
| ------------------ | ------- | ----------------------------------- |
| `chloei-workflows` | Inngest | Durable agent workflows and jobs    |
| `chloei-db`        | Neon    | Primary PostgreSQL system of record |

There should be no duplicate project-level Inngest resources. If the Vercel
integrations console shows an extra product tile that is not connected to
`chloei`, confirm no project resource is attached before removing it from the
integration console.

The current production deployment should be `Ready`, aliased to `chloei.ai`,
and expose `/api/inngest` with `x-inngest-sdk-handled: true`. An unsigned
`GET /api/inngest` returning `401` is expected because Inngest signature
validation is working.

## Environment Scope

Production is in internal-only rollout for finance workflows:

```text
AGENT_ENABLE_NEW_CAPABILITIES_FOR_INTERNAL_USERS=true
AGENT_TELEMETRY_RECORD_IO=false
AGENT_FINANCE_WORKFLOWS_ENABLED=<unset>
INNGEST_INLINE_FALLBACK=<unset>
```

Preview is the integration test surface:

```text
AGENT_FINANCE_WORKFLOWS_ENABLED=true
AGENT_TELEMETRY_RECORD_IO=false
INNGEST_INLINE_FALLBACK=1
```

Development mirrors the locked-down defaults, with `INNGEST_INLINE_FALLBACK=1`
for local work.

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

6. Sync the Inngest app after production deploy:

   ```bash
   curl -sS -X PUT https://chloei.ai/api/inngest
   ```

   Expected response includes `"Successfully registered"`.

Keep `AGENT_TELEMETRY_RECORD_IO=false` unless a separate privacy review approves
raw prompt/output capture for a controlled non-production eval cohort.

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

Inngest production registration and event smoke:

```bash
curl -sS -X PUT https://chloei.ai/api/inngest

tmp_env="$(mktemp -t chloei-inngest-prod.XXXXXX)"
vercel env pull "$tmp_env" --environment=production --yes --scope chloei
pnpm inngest:smoke --env-file "$tmp_env"
rm -f "$tmp_env"
```

Expected results:

- The sync response includes `"Successfully registered"`.
- Inngest `Events` shows `ops/inngest.smoke`.
- Inngest `Runs` shows `ops-inngest-smoke` with `Completed` status.
- The script prints an Inngest event ID and never prints `INNGEST_EVENT_KEY`.

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

## Duplicate Inngest Cleanup

Duplicate Vercel Inngest installs usually show up as multiple `Inngest` rows on
`/chloei/chloei/settings/integrations`. Keep the billed install connected to the
`chloei-workflows` resource. As of June 7, 2026, the active install is
`icfg_pviKCAeMuk9dmdjEIdALlPZK`.

Before removing any duplicate:

1. Run `vercel integration list --format=json` and confirm the only Inngest
   project resource is `chloei-workflows`.
2. Open the duplicate install's Vercel Settings page.
3. Click `Remove Inngest` only if the confirmation dialog says
   `No Installed Inngest Resources` and `You don't have any connected projects`.
4. Do not remove the billed install that owns `chloei-workflows`.
5. Re-run `vercel integration list --format=json` and
   `curl -sS -X PUT https://chloei.ai/api/inngest`.
6. Run the Inngest smoke command above.

Inngest `Unattached syncs` are historical failed automatic sync records. Treat
old `account_mismatch` entries as audit history once the current app syncs and
the smoke run completes. A new unattached sync after cleanup is actionable and
should be investigated from its failure details.

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
- Inngest events must use idempotency keys derived from user, document, report,
  or thread identifiers, not prompt text or document contents.
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
curl -sS -X PUT https://chloei.ai/api/inngest
vercel logs https://chloei.ai --since 30m --level error --no-follow
```
