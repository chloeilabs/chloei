# Chloei Next Steps Plan

Last updated: May 23, 2026  
Repository snapshot: `main` @ `ad98c0e` (Gemini 3.5 Flash default model)

This document summarizes the current state of the Chloei repository and proposes a prioritized roadmap for engineering, rollout, and operational work. It is intended as a living plan — update it as milestones ship.

---

## Executive Summary

Chloei is a mature Next.js 16 chat application (web + macOS desktop) with authenticated streaming agent runs, PostgreSQL thread storage, finance/research tooling, and a privacy-first managed integration stack on Vercel. Core chat, auth, tools, desktop shell, and CI are in good shape (310 unit tests passing).

The highest-value next work falls into three buckets:

1. **Finish gated capabilities** — async reports and watchlist refresh are scaffolded but not fully wired; knowledge search and finance workflows need broader rollout after smoke validation.
2. **Harden quality gates** — finance evals and authenticated smoke tests are documented but not enforced in CI.
3. **Close documentation and UX gaps** — README/CLAUDE drift, thread pin persistence, and a few placeholder Inngest paths.

---

## Current State

### What is working today

| Area | Status | Notes |
| --- | --- | --- |
| Auth & sessions | ✅ Production-ready | Better Auth + PostgreSQL; middleware guards app shell and APIs |
| Agent streaming | ✅ Production-ready | NDJSON protocol, tools, reasoning, citations, activity timeline |
| Model selector | ✅ Production-ready | Gemini 3.5 Flash (default), Kimi K2.6, MiMo V2.5 Pro |
| Deep research | ✅ Production-ready | Gemini 3.1 Pro Preview with high thinking (research mode only) |
| Thread CRUD | ✅ Production-ready | JSONB storage; sidebar search, delete; pin is client-only |
| Chat UX | ✅ Recent polish | Follow-up question chips, copy/regenerate, edit-and-resend, queued messages |
| Attachments | ✅ Production-ready | Private Blob upload; PDF/image preprocessing |
| Finance tools | ✅ Production-ready | `finance_data`, `sec_filings`, FMP MCP, Tavily, code execution |
| Desktop (macOS) | ✅ Production-ready | Electron shell, auto-update channels, CI release workflow |
| CI pipeline | ✅ Strong baseline | Lint, format, typecheck, build, bundle budget, mock smoke |
| Observability | ✅ Baseline | Sentry, Vercel Analytics/Speed Insights, structured logs |

### What is partially implemented

| Area | Status | Gap |
| --- | --- | --- |
| Knowledge search | 🟡 Gated | Upstash Search + Inngest indexing exist; production limited to internal users |
| Finance workflows | 🟡 Gated | Workflow/skill registry + prompt overlays exist; flag off for general users |
| Async reports | 🟡 Scaffold | `POST /api/jobs/report` + job table + Inngest; completion returns placeholder text |
| Watchlist refresh | 🟡 Stub | Inngest function reserved for finance workflow rollout |
| Long-term memory | 🟡 Opt-in | Mem0 integration complete; disabled by default (`MEMORY_PROVIDER=disabled`) |
| PostHog analytics | 🟡 Internal-only | Server events for internal users; client analytics off in production |
| Finance evals | 🟡 Manual gate | Harness exists; not run in CI |

### Feature flag posture (production)

From `src/lib/server/integration-flags.ts` and `docs/managed-integrations-rollout.md`:

- `AGENT_ENABLE_NEW_CAPABILITIES_FOR_INTERNAL_USERS=true` — internal users get knowledge search, async reports, and finance workflows when env overrides are unset.
- Global capabilities remain **off by default** for external users.
- `AGENT_TELEMETRY_RECORD_IO=false` — raw prompt/output capture locked off (privacy).
- `NEXT_PUBLIC_POSTHOG_ANALYTICS_ENABLED=false` — browser analytics off pending privacy review.

---

## Recommended Roadmap

Priorities are ordered by impact and dependency. Each item includes suggested owners, acceptance criteria, and links to existing runbooks.

### Phase 1 — Complete core gated features (1–2 sprints)

#### 1.1 Wire async report generation to the agent runtime

**Why:** `POST /api/jobs/report` and Inngest handlers exist, but completion is a placeholder (`complete-report-placeholder` in `src/lib/server/inngest/functions.ts`).

**Tasks:**

- [ ] Connect `agent/report.requested` Inngest event to a real agent run using the `finance_analysis` or dedicated report profile.
- [ ] Persist generated artifacts (Blob) and surface download URLs through existing artifact routes.
- [ ] Update job status transitions: `queued` → `running` → `completed` / `failed` with structured error codes.
- [ ] Add unit tests for job lifecycle and integration tests against Inngest inline fallback (`INNGEST_INLINE_FALLBACK=1`).

**Acceptance criteria:**

- Internal user can enqueue a report, poll `GET /api/jobs/:id`, and receive a real artifact (not placeholder text).
- External user still receives `JOB_REPORT_DISABLED` when flag is off.
- No prompt text, attachment contents, or PII in PostHog/Sentry events.

**References:** `src/lib/server/agent-report-jobs.ts`, `src/app/api/jobs/report/route.ts`, `docs/managed-integrations-rollout.md` (Authenticated rollout smoke, step 4).

---

#### 1.2 Implement or defer watchlist refresh

**Why:** Inngest stub returns a reserved message; either implement or remove to avoid confusion during finance workflow rollout.

**Tasks:**

- [ ] Define watchlist data model (user-scoped symbols, refresh cadence, storage).
- [ ] Implement refresh using `finance_data` / FRED / SEC providers, or explicitly remove the stub until Phase 2.
- [ ] Gate behind `AGENT_FINANCE_WORKFLOWS_ENABLED`.

**Acceptance criteria:**

- No placeholder Inngest responses in production paths when finance workflows are enabled for internal users.

---

#### 1.3 Validate knowledge search end-to-end on preview

**Why:** Upload → Blob → Inngest indexing → `knowledge_search` tool chain is built but needs repeatable smoke validation before broader rollout.

**Tasks:**

- [ ] Run authenticated rollout smoke on preview (upload doc → search → verify citations and owner scoping).
- [ ] Confirm Upstash index isolation per environment (`UPSTASH_SEARCH_INDEX`).
- [ ] Document expected latency and failure modes in rollout runbook.

**Acceptance criteria:** Steps 1–3 of authenticated rollout smoke in `docs/managed-integrations-rollout.md` pass on preview with a non-sensitive test document.

---

### Phase 2 — Quality gates and CI hardening

#### 2.1 Add finance evals to CI

**Why:** Rollout doc requires `pnpm eval:finance` and `pnpm eval:finance:grade` before broadening flags; CI currently skips them.

**Tasks:**

- [ ] Add `pnpm eval:finance` (fixture mode) to `.github/workflows/ci.yml` after unit tests.
- [ ] Add `pnpm eval:finance:grade` with regression thresholds on citation presence, numeric consistency, and tool selection.
- [ ] Optionally add a scheduled workflow (`eval:finance:live`) with AI Gateway secrets for pre-release validation.

**Acceptance criteria:** PRs fail on finance eval regressions; live eval remains opt-in/manual or nightly.

**References:** `evals/finance/`, `docs/finance-research-quality.md`.

---

#### 2.2 Expand smoke test coverage

**Why:** Mock smoke covers follow-ups, edit/regenerate, search, and PDF attach; regenerate-only and desktop update flows have lighter coverage.

**Tasks:**

- [ ] Add Playwright assertion for assistant regenerate-without-edit path.
- [ ] Add optional CI job for `pnpm desktop:smoke` on macOS runner (or keep manual pre-release).
- [ ] Document preview/production smoke commands in this plan's verification section.

**Acceptance criteria:** Regenerate action covered in `tests/smoke/mock-authenticated-chat.spec.mjs`; desktop smoke documented in release checklist.

---

#### 2.3 Align documentation with code

**Why:** README and CLAUDE.md still describe the model selector as Kimi + MiMo only; Gemini 3.5 Flash is now the default. Thread pin behavior is localStorage-only but some docs imply server persistence.

**Tasks:**

- [ ] Update `README.md`, `CLAUDE.md` model registry table and selector description.
- [ ] Document follow-up questions route (`POST /api/agent/follow-ups`) and chat message actions.
- [ ] Clarify thread pin is client-local unless server persistence is added (see Phase 3).

**Acceptance criteria:** No contradictions between `src/lib/shared/llm/models.ts` and top-level docs.

---

### Phase 3 — Rollout and product expansion

#### 3.1 Broaden managed integration flags (internal → general availability)

**Why:** Knowledge search, async reports, and finance workflows are validated internally but not enabled for all users.

**Preconditions:**

- Phase 1.1–1.3 complete.
- Phase 2.1 eval gate green.
- Authenticated rollout smoke passes on preview and production.

**Tasks:**

- [ ] Follow production rollout steps in `docs/managed-integrations-rollout.md`.
- [ ] Enable flags via Edge Config or env for a percentage rollout (if supported) or full GA.
- [ ] Monitor Sentry error rate, agent latency, and PostHog coarse events for 48h post-enable.
- [ ] Keep rollback commands documented and tested.

**Acceptance criteria:** External users can use enabled capabilities; rollback completes in <15 minutes per runbook.

---

#### 3.2 Mem0 long-term memory production enablement

**Why:** Memory is fully implemented but opt-in; production may want cross-thread recall for authenticated users.

**Tasks:**

- [ ] Configure per-environment `MEMORY_AGENT_ID` (`chloei-preview`, `chloei-production`).
- [ ] Run `pnpm mem0:smoke` and `SMOKE_BASE_URL=<preview> pnpm test:smoke:memory` before enable.
- [ ] Document Mem0 provider setup (AI Gateway embeddings) in README.

**Acceptance criteria:** Memory failures never block chat; smoke tests pass; cleanup script works (`pnpm mem0:cleanup-smoke`).

---

#### 3.3 PostHog client analytics decision

**Why:** Server-side internal analytics exist; browser analytics require separate privacy review.

**Tasks:**

- [ ] Complete privacy review for `NEXT_PUBLIC_POSTHOG_ANALYTICS_ENABLED`.
- [ ] Confirm autocapture, replay, and surveys remain disabled per README policy.
- [ ] If approved, enable on preview first with internal-users-only gate.

**Acceptance criteria:** Written approval before any client-side capture; no prompt/output/filenames in events.

---

#### 3.4 Persist thread pins server-side (optional)

**Why:** Pins are stored in localStorage today; cross-device and desktop sync would need DB column.

**Tasks:**

- [ ] Add migration for `thread."isPinned"` (schema already documented in CLAUDE.md history).
- [ ] Sync pin state in `PUT /api/threads` and sidebar UI.
- [ ] Backward-compatible: ignore missing column until migrated.

**Acceptance criteria:** Pin state survives browser clear and works across web + desktop for same user.

---

### Phase 4 — Operations, security, and platform

#### 4.1 Production launch readiness follow-ups

From `docs/vercel-production-launch-readiness.md`:

- [ ] Add WAF log-only rule for `/api/agent` by IP; review traffic before challenge/deny rules.
- [ ] Configure Vercel spend alerts and review usage after launch traffic.
- [ ] Evaluate Observability Plus and deployment checks blocking production alias.
- [ ] Optional: DNS migration from Cloudflare to Vercel DNS (zero-downtime procedure documented).

---

#### 4.2 Desktop release cadence

- [ ] Bump desktop version in `package.json` aligned with web releases.
- [ ] Verify split auto-update channels (`latest-mac-arm64`, `latest-mac-x64`) after each `desktop-release` workflow run.
- [ ] Document local signing path (`CHLOEI_DESKTOP_SIGN=1`) for developers outside cloud-synced workspaces.

---

#### 4.3 Tech debt and cleanup

- [ ] Retire or document legacy tool names (`browser_research`, unused `x_search` UI labels) if no longer needed for thread parsing.
- [ ] Resolve Node `MODULE_TYPELESS_PACKAGE_JSON` warning in tests (optional `"type": "module"` or explicit `.mjs` imports).
- [ ] Evaluate FMP MCP deprecation timeline now that `finance_data` is primary.

---

## Verification Checklist

Run before any production promotion or flag broadening:

```bash
pnpm install --frozen-lockfile
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm bundle:budget
pnpm test:smoke:mock:build
pnpm eval:finance
pnpm eval:finance:grade
```

Optional pre-release (requires secrets):

```bash
pnpm eval:finance:live
SMOKE_BASE_URL=https://chloei.ai pnpm test:smoke
SMOKE_BASE_URL=<preview-url> pnpm test:smoke:memory
pnpm mem0:smoke
pnpm desktop:smoke
```

Post-deploy:

```bash
curl -sS -X PUT https://chloei.ai/api/inngest
vercel logs https://chloei.ai --since 30m --level error --no-follow
```

---

## Architecture Reference (quick)

```
Client (useAgentSession)
  → POST /api/agent
  → Middleware auth (src/proxy.ts)
  → Rate limit + concurrency
  → Integration flags (src/lib/server/integration-flags.ts)
  → System prompt + task mode / finance workflow overlays
  → AI Gateway stream (NDJSON)
  → Thread upsert (PostgreSQL JSONB)
  → Optional Mem0 commit + PostHog coarse event
```

**Key paths:**

| Path | Purpose |
| --- | --- |
| `src/app/api/agent/route.ts` | Streaming agent |
| `src/app/api/agent/follow-ups/route.ts` | Follow-up question generation |
| `src/app/api/jobs/report/route.ts` | Async report enqueue |
| `src/lib/server/inngest/functions.ts` | Background jobs (indexing, reports, watchlist) |
| `src/lib/shared/llm/models.ts` | Model registry |
| `evals/finance/` | Finance benchmark harness |

---

## Decision Log (to update as work proceeds)

| Date | Decision | Rationale |
| --- | --- | --- |
| 2026-05-23 | Plan created from repo analysis | Baseline for team prioritization |
| — | Async reports before GA rollout | External users should not see placeholder job output |
| — | Finance evals in CI before flag broadening | Documented quality gate in rollout runbook |
| — | Client PostHog remains off | Privacy review required per operating rules |

---

## Related Documentation

- [README.md](../README.md) — setup, scripts, environment
- [CLAUDE.md](../CLAUDE.md) — architecture deep dive for agents
- [managed-integrations-rollout.md](./managed-integrations-rollout.md) — flag rollout and rollback
- [vercel-production-launch-readiness.md](./vercel-production-launch-readiness.md) — launch gate and incident response
- [finance-research-quality.md](./finance-research-quality.md) — finance answer acceptance criteria
