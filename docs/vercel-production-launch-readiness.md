# Vercel Production Launch Readiness

This runbook tracks Chloei against the Vercel production checklist for a Pro plan launch.

## Current Project

- Vercel team: Chloei Labs (`team_8zGk2XORbbDx04iMB2hVxYlo`)
- Vercel project: `chloei`
- Production domain: `chloei.ai`
- DNS provider: Cloudflare nameservers (`gene.ns.cloudflare.com`, `kyrie.ns.cloudflare.com`)
- Function region: `iad1`, aligned with Neon `us-east-1`
- Runtime: Fluid Compute enabled in `vercel.json`
- Deployment protection: Vercel Authentication for generated deployments, except custom domains
- Web Analytics: enabled
- Speed Insights: enabled

## Launch Gate

Do not promote or leave a new production deployment live unless these checks pass:

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm bundle:budget
pnpm test:smoke:mock:build
```

For production smoke testing, use an existing smoke account:

```bash
SMOKE_BASE_URL=https://chloei.ai pnpm test:smoke
```

## Incident Response

Severity levels:

- Sev1: sign-in, chat, billing-sensitive provider calls, or production availability is broadly broken.
- Sev2: a key workflow is degraded, intermittent, or restricted to a subset of users.
- Sev3: minor feature regression, cosmetic issue, or non-critical integration degradation.

Escalation paths:

- Engineering owner: on-call engineer for the active release.
- Business owner: Chloei Labs launch owner.
- Vendor paths: Vercel dashboard and support for platform incidents (including runtime logs and Observability), Neon dashboard/support for database incidents, Inngest for background jobs, AI Gateway/provider dashboard for model failures.

Communication channels:

- Internal launch channel for live triage and status.
- User-facing status/update channel when Sev1 or broad Sev2 impact is confirmed.
- Post-incident notes in the release or incident document within 24 hours.

Rollback strategy:

1. Confirm the bad deployment URL or deployment id:

   ```bash
   vercel ls chloei
   vercel inspect <deployment-url-or-id>
   ```

2. Roll back production immediately when the issue is code or config bundled in the deployment:

   ```bash
   vercel rollback
   ```

3. If a validated preview should become production without rebuilding:

   ```bash
   vercel promote <preview-url-or-id>
   ```

4. If an environment variable caused the incident, revert the variable in Vercel, redeploy, and run the production smoke test.

## Security Readiness

Handled in code:

- Security headers are configured globally in `next.config.mjs`.
- Production includes HSTS and Content Security Policy.
- `poweredByHeader` is disabled.
- Auth is required for the app shell and private APIs.
- Agent requests use sliding-window and concurrency rate limits.
- Better Auth has credential route rate limiting.
- API responses default to `Cache-Control: no-store` and include request ids.
- Lockfile is committed with `pnpm-lock.yaml`.

Vercel dashboard/CLI checks:

- Deployment Protection is enabled for generated deployments.
- Firewall system mitigations are active.
- A custom WAF rule blocks common scanner paths.
- Error tracking is via Vercel runtime logs (structured JSON from `src/lib/logger.ts`); there is no Sentry/PostHog/OpenTelemetry integration.
- No IP blocks are configured yet.
- Production env has required app secrets, including `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `AI_GATEWAY_API_KEY`, and `BLOB_READ_WRITE_TOKEN`.

WAF follow-up:

1. The deny rule for common scanner paths is live:

   ```text
   ^/(wp-admin|wp-login\.php|xmlrpc\.php|phpmyadmin|\.env|\.git)(/|$)
   ```

2. Add a log-only rule for `/api/agent` by IP to observe high request rates.
3. Add a challenge or deny rule for unwanted bot categories after reviewing real traffic.
4. For future firewall edits, publish only after checking the draft:

   ```bash
   vercel firewall diff
   vercel firewall publish --yes
   ```

Runtime logs and error tracking:

- Production emits structured JSON logs (`src/lib/logger.ts`) to stdout/stderr, surfaced in Vercel runtime logs. Route-level logging (`src/lib/server/route-observability.ts`) records request id, route, method, status, duration, and outcome.
- There is no third-party error-tracking integration (Sentry/PostHog/OpenTelemetry were removed). Inspect errors with the CLI or the Vercel Observability dashboard:

  ```bash
  vercel logs https://chloei.ai --since 30m --level error --no-follow
  ```

- If a dedicated error tracker is reintroduced later, configure it as a Vercel Log Drain and document the drain id here.

## Reliability Readiness

Handled:

- Runtime logs are structured in production.
- Route-level logging records request id, route, method, status, duration, and outcome.
- Latest production deployment is aliased to `chloei.ai`.
- Production functions are configured for `iad1`, matching the Neon `us-east-1` database region.

Remaining Pro-plan actions:

- Enable Observability Plus if launch debugging needs longer retention or deeper traffic inspection.
- Add deployment checks if an external smoke-test or approval gate should block production aliasing.

Enterprise-only checklist items:

- Automatic Function failover.
- Secure Compute passive failover region.
- Vercel-managed load testing support.

## Performance Readiness

Handled:

- Vercel Speed Insights package is mounted in the root layout and enabled on the project.
- Vercel Web Analytics package is mounted in the root layout and enabled on the project.
- Next.js image remote patterns are constrained.
- Fonts use Next font optimization and a local font file.
- Private API and user data responses use `no-store`.
- Static logo routes use immutable caching.

Review before launch:

- Use Speed Insights and `vercel logs --environment production --since 1h --level error` after smoke traffic.
- Track TTFB for authenticated home, `/api/models`, `/api/threads`, and `/api/agent`.
- Confirm large GIF/video assets are not committed; use Vercel Blob for large user or media files.

## DNS Migration

`chloei.ai` is currently served through Cloudflare nameservers and is already on the Vercel Edge Network. A zero downtime migration to Vercel DNS is optional, not required for launch.

If migrating DNS to Vercel:

1. Lower Cloudflare DNS TTLs at least one TTL window before migration.
2. Export all existing DNS records from Cloudflare.
3. Recreate every required record in Vercel DNS, including any mail, verification, and subdomain records.
4. Verify `chloei.ai` and any subdomains with `dig`.
5. Change nameservers at the registrar.
6. Monitor `dig +trace chloei.ai`, Vercel domain status, and SSL issuance until propagation is complete.
7. Keep Cloudflare records unchanged until Vercel DNS has fully propagated.

## Cost Controls

Handled:

- Fluid Compute is enabled.
- Bundle budget checks run in CI.
- Agent message size, total payload size, tool steps, stream timeout, rate limit, and concurrency limits are bounded by fixed constants in `src/lib/server/agent-runtime-config.ts` (a rate-limit kill switch and store selector remain env-configurable).

Dashboard actions:

- Configure spend alerts and hard/soft thresholds in Vercel Spend Management.
- Review current usage by project and region before launch:

  ```bash
  vercel usage --group-by project --format json
  vercel usage --group-by region --format json
  ```

- Review Pro included usage and alert thresholds after the first production traffic day.
