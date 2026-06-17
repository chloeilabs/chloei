# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Chloei is a **Next.js 16 / React 19** authenticated AI chat app backed by the **Vercel AI Gateway**. A single streaming agent endpoint (`/api/agent`) runs a multi-step tool-using loop (Tavily web search) and streams NDJSON to the browser. Auth, sessions, and threads are **PostgreSQL-backed** (Better Auth + Kysely/`pg`).

> **Maintaining this file:** keep it accurate and concise — stale or bloated guidance makes Claude ignore the parts that matter. Cite durable anchors (file paths + symbol names), not line numbers. When you change a subsystem, update the matching section here in the same PR.

## Commands

```bash
# Development
pnpm dev                  # Start dev server on port 3000
pnpm build                # Production build
pnpm start                # Start the production Next.js server

# Database (must run before first request — storage does NOT self-initialize)
pnpm migrate              # Run both auth + app migrations
pnpm auth:migrate         # Better Auth schema only
pnpm app:migrate          # thread table (also drops legacy tables)
pnpm threads:migrate      # Alias for pnpm app:migrate

# Quality checks (run before committing)
pnpm lint                 # ESLint (zero warnings allowed — --max-warnings=0)
pnpm lint:fix             # Auto-fix ESLint issues
pnpm typecheck            # next typegen && tsc --noEmit
pnpm format               # Prettier (write)
pnpm format:check         # Prettier (check only)
pnpm bundle:budget        # Fail if built static JS exceeds budget (14 MiB total / 1 MiB per chunk)
pnpm bundle:report        # Report-only: chunk headroom + per-route first-load JS

# Tests
pnpm test                                        # All unit tests (node --test tests/*.test.mjs)
pnpm test:smoke:mock                            # Credential-free Playwright smoke (needs a prior build)
pnpm test:smoke:mock:build                      # Build production app, then run mock smoke
node --test tests/agent-route-contract.test.mjs  # Single test file
```

ESLint runs with `--max-warnings=0`, so any warning fails the build. CI also enforces `pnpm format:check`. Run `pnpm lint && pnpm format:check && pnpm typecheck` before committing.

## Local / Claude Code setup

`README.md` covers generic local setup. The Claude Code SessionStart hook (`.claude/hooks/session-start.sh`, wired by `.claude/settings.json`) provisions the local database, runs migrations, and installs Playwright Chromium so web sessions can build and test immediately.

For Vercel-backed local envs, run `vercel login`, approve the device-login URL, confirm `.vercel/project.json` links to the Chloei Labs `chloei` project, then `vercel env pull .env.local --yes`.

## Architecture

### Request Flow

```
Client (useAgentSession)
  → POST /api/agent (app/api/agent/route.ts)
    → Auth check (isAuthConfigured → getRequestSession)   [routes self-guard; see Middleware]
    → Zod validation (parseAgentStreamRequest) — model + messages
    → System prompt assembly (buildAgentSystemInstruction)
    → AI Gateway stream via Vercel AI SDK (startGatewayResponseStream → runAgentStream)
    → NDJSON chunks (application/x-ndjson) → client
      → readResponseStreamLines / parseStreamEventLine
        → applyAgentStreamEvent → AgentStreamAccumulator → React state → render
  → Thread upsert (useThreadStore → PUT /api/threads → upsertThreadForUser → PostgreSQL JSONB)
```

Key route files: `src/app/api/agent/route.ts` (HTTP entry, auth, validation) → `src/lib/server/agent-route.ts` (`parseAgentStreamRequest`, `createAgentStreamResponse`, NDJSON writing, fallback handling) → `src/lib/server/llm/agent-runtime.ts` (the tool loop) → `src/lib/server/llm/gateway-responses.ts` (`startGatewayResponseStream`).

Before the model sees them, messages pass through `toModelMessages` (`agent-runtime-messages.ts`). System-role messages are rejected there — system content must come via `systemInstruction`.

### Server / Client / Shared Boundary

- `src/lib/server/` — server-only. Never import from client components.
- `src/lib/shared/` — isomorphic. Safe to import anywhere.
- `src/lib/actions/` — Next.js server actions; callable from client.
- `src/components/` — client components and hooks.

This boundary is **enforced by Next.js bundling at build time** (importing `pg`/`better-auth`/server modules into a client bundle is a build error), **not** by an ESLint rule. Keep it in mind when adding imports.

### System Prompt Composition

`buildAgentSystemInstruction` (`src/lib/server/agent-context.ts`) assembles the prompt per-request from labeled blocks delimited by `--- BEGIN <LABEL> ---` / `--- END <LABEL> ---`, in this order:

1. `OPERATING INSTRUCTIONS` — `DEFAULT_OPERATING_INSTRUCTION` (`src/lib/shared/llm/system-instructions.ts`)
2. `RUNTIME DATE CONTEXT` — current UTC timestamp + user timezone (from `X-User-Timezone` header)
3. **Provider overlay** (`PROVIDER OVERLAY: ZAI`) — keyed by the model's **provider org** (zai=GLM). Always applied for the supported model. `resolvePromptProvider()` is param-less and always returns `"zai"`.
4. `IDENTITY AND TONE CONTEXT` — `DEFAULT_SOUL_FALLBACK_INSTRUCTION` (`src/lib/shared/llm/system-instructions.ts`)
5. `AUTH USER CONTEXT` — authenticated user id, name, email

Inline-citation rules are appended **later**, by `withAiSdkInlineCitationInstruction` (`system-instruction-augmentations.ts`), inside `createAgentStreamResponse` — not by `buildAgentSystemInstruction`.

### Streaming Protocol

`/api/agent` returns `Content-Type: application/x-ndjson`. Each line is a JSON-encoded `AgentStreamEvent` (`src/lib/shared/agent/messages.ts`). The client reads line-by-line in `readResponseStreamLines` and feeds events through `applyAgentStreamEvent` into an `AgentStreamAccumulator`.

Event types:

- `text_delta` — incremental assistant text
- `reasoning_delta` — incremental reasoning text (sanitized + redacted-placeholder-filtered; see below)
- `agent_status` — `in_progress | completed | failed | cancelled | incomplete`
- `tool_call` — tool start: `callId`, `toolName`, `label`, plus optional `query`, `operation`, `provider`
- `tool_result` — tool result: `callId`, `status: success | error`, plus optional `operation`, `provider`, `durationMs`, `errorCode`, `retryable`
- `source` — citation source: `id`, `url`, `title`

Every event also carries optional `interactionId` and `lastEventId` checkpoint fields.

The client accumulator (`agent-stream-state.ts`) builds: `content`, `reasoning`, `toolInvocations`, `activityTimeline` (kinds: `tool`, `search`, `sources`, `reasoning`), and `sources` (deduped by URL).

### Synthesis Gating and Fallbacks

The runtime actively prevents "ran tools but never wrote an answer" outcomes (`agent-runtime.ts` + `agent-runtime-synthesis-gating.ts`):

- **Final-synthesis step** — on the last allowed step (`stepNumber >= toolMaxSteps - 1`), `prepareStep` forces `toolChoice: "none"` and appends an instruction to write the answer in the user's exact terminology.
- **Mid-budget nudge** — from ~1/3 of the step budget onward, appends a reminder to stop retrieving and start synthesizing (disabled when the budget is ≤ 3 steps).
- **Empty-response fallback** — if the main stream ends with zero emitted text (and wasn't aborted), a second `streamText` call with `toolChoice: "none"` forces a written answer. Orphan tool-calls are patched with synthetic stub tool-results (`sanitizeResponseMessagesForFallback`) to avoid `AI_MissingToolResultsError`.

`createAgentStreamResponse` also injects fallback text and downgrades `agent_status` to `incomplete` on timeout, provider-auth errors (401/403/`invalid_api_key` → "Invalid AI_GATEWAY_API_KEY"), or empty output. Responses set `X-Agent-Effective-Model` and `Cache-Control: no-store, no-transform`.

### Reasoning and Privacy

Streamed reasoning is filtered through three layers so the hidden prompt never leaks:

1. Literal `[REDACTED]` reasoning chunks are dropped (`initial-reasoning-chunk-sanitizer.ts`).
2. Leading `thinking:` / `reasoning:` labels are stripped (buffered across chunk boundaries).
3. `sanitizeReasoningForDisplay` (`src/lib/shared/agent/reasoning-privacy.ts`) redacts prompt-internal terms (`soul.md`, "system prompt", "operating instructions", "provider overlay", "auth user context", etc.). `getPrivateReasoningCarryLength` holds back a trailing partial token across chunk boundaries so a split secret can't slip through. Applied both at stream time and on thread persistence.

User ids are never logged in the clear: `hashUserId` (`src/lib/server/privacy.ts`) produces a `sha256:<hex>` digest used for telemetry user-hashing.

### Agent Tools

The only tools are the two Tavily web-search tools, and both are registered together when `TAVILY_API_KEY` is set. There are no other internal or external tools.

| Tool             | Requirement      | Tool id / operations                                                                                                                     |
| ---------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `tavily_search`  | `TAVILY_API_KEY` | Web search. `topic: general\|news\|finance`, `timeRange`, `includeDomains`, `excludeDomains`, `country`; up to **8** results (default 5) |
| `tavily_extract` | `TAVILY_API_KEY` | Extract content from up to **5** URLs; `extractDepth: basic\|advanced` (default advanced), `format: markdown\|text`                      |

**Max tool steps** (`AGENT_TOOL_MAX_STEPS` in `agent-runtime-config.ts`): 12.

### Model Registry

The app runs on a **single model**, defined in `src/lib/shared/llm/models.ts`:

| Key           | Model ID      | Display Name |
| ------------- | ------------- | ------------ |
| `ZAI_GLM_5_2` | `zai/glm-5.2` | GLM 5.2      |

- `DEFAULT_MODEL` (`= AvailableModels.ZAI_GLM_5_2`) is the single model used everywhere. There is **no model-selector UI** and no per-user model persistence — the client always submits `DEFAULT_MODEL`, and the model still flows through requests/threads so the API can validate it.
- The agent is text-only: all chat input is plain text (no image, file, or PDF input).
- Adding a model means updating `AvailableModels`, `ModelInfos`, and `SUPPORTED_MODELS` (and re-introducing selector UI if more than one model is ever exposed). `/api/models` filters this registry by configured keys (`getModels()` in `src/lib/actions/api-keys.ts`).

### Thread Storage

Messages are stored as a JSONB column on the `thread` table (one row per thread, keyed `(userId, id)`). There is no separate messages table. Upserts use `WHERE thread."updatedAt" <= EXCLUDED."updatedAt"` to prevent stale writes from overwriting newer state. `isThreadStoreNotInitializedError` detects Postgres `42P01`/`42703` and returns a 500 with a migration message.

**Actual schema** (from `app-migrate.mjs` — note: there is **no `isPinned` column**):

```sql
CREATE TABLE thread (
  "userId"    text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  id          text NOT NULL,
  title       text NOT NULL DEFAULT 'New Conversation',
  model       text,
  messages    jsonb NOT NULL,
  "createdAt" timestamp(3) without time zone NOT NULL,
  "updatedAt" timestamp(3) without time zone NOT NULL,
  PRIMARY KEY ("userId", id)
);
-- Index: thread_user_updated_at_idx ON ("userId", "updatedAt" DESC)
```

`app-migrate.mjs` backfills `title` and drops legacy tables/columns (including the former `agent_rate_limit`).

**Pinning is client-side only** — there is no server column. Pinned thread ids live in `localStorage` (`chloei:pinned-thread-ids`, `src/components/nav-threads.tsx`) and pinned-first ordering happens in the sidebar render, not in the API.

**Thread API** (`/api/threads`):

- `GET` (no query) — returns lightweight `ThreadSummary[]` (id, title, model, timestamps; **no messages**), newest-first.
- `GET ?id=<threadId>` — returns the full `Thread` (with messages).
- `PUT` — upsert a full `Thread`.
- `DELETE` — delete by id (body `{ id }`); responds `204 No Content`.

**Client thread store** (`src/components/agent/home/use-thread-store.ts` via `ThreadStoreProvider`) — a bespoke `useState`/refs store (not React Query). It holds `threadSummaries` (the list), lazily-hydrated full `threads`, and `currentThreadId`. Writes go through `saveThread`: optimistic local merge, then an immediate or 800 ms-debounced `PUT`, with 3 s retry, per-thread `AbortController` dedupe, and `updatedAt` stale-write protection. The available-model list is resolved once on the server (`getModels()` in `page.tsx`) and read from a `ModelsProvider` context (`src/hooks/agent/use-models.tsx`) — there is no client-side data-fetching library.

### Rate Limiting

The agent endpoints (`/api/agent`, `/api/agent/follow-ups`) are **not** rate-limited.

**Better Auth has its own credential-route limits** (`src/lib/server/auth.ts`, `rateLimit`): ~100 req / 10 s globally, with `/sign-in/email` and `/sign-up/email` capped at 5 req / 15 min — brute-force protection on authentication.

### Authentication and Middleware

Better Auth handles sessions. `getRequestSession` (`src/lib/server/auth-session.ts`) reads the session from request headers. `isAuthConfigured()` returns false when `DATABASE_URL`/`BETTER_AUTH_SECRET` are missing — routes then return 503 rather than crashing. On Vercel, `BETTER_AUTH_URL` can be inferred from `VERCEL_URL`/`VERCEL_BRANCH_URL`/`VERCEL_PROJECT_PRODUCTION_URL`, so `isAuthConfigured()` can be true without an explicit `BETTER_AUTH_URL`.

**Middleware** (`src/proxy.ts`) — exported as a **named** `proxy` function plus `config` (not a default export):

- **Matcher is only `["/", "/sign-in", "/sign-up"]`.** It does **not** match `/api/*`. API routes are guarded by their own in-route `isAuthConfigured()` / `getRequestSession()` checks, not by middleware.
- `/api/auth/*` is passed through unconditionally (when matched).
- Auth not configured → allow auth pages, 503 on API, redirect elsewhere to `/sign-in`.
- Authenticated → redirect auth pages home (or the `redirect` query path).
- Not authenticated → redirect to `/sign-in`.
- **Fail-open**: if `getRequestSession` throws, the middleware logs and calls `next()` (lets the request through).

### Feature Flags

`src/lib/server/integration-flags.ts` resolves one default-off flag: `telemetryRecordIo`. Precedence:

1. Explicit `AGENT_*` env var (`AGENT_TELEMETRY_RECORD_IO`).
2. Edge Config (`EDGE_CONFIG`) — checked across three map namespaces in order: **`agent_flags`, `analytics_flags`, `flags`**, matching the dotted key (`agent.telemetry.record_io`) or its Vercel slug form (`agent-telemetry-record-io`), then top-level fallback keys.
3. Built-in default (off).

### Observability and Telemetry

- **Logging**: `createLogger(scope)` (`src/lib/logger.ts`) returns `{ info, warn, error }`. In production (`NODE_ENV=production`) it emits newline-delimited JSON with structured fields (always `level`, `message`, `scope`, `timestamp`; when present `requestId`, `errorCode`, `durationMs`, `method`, `model`, `outcome`, `route`, `status`, plus Vercel deployment metadata). In dev it falls back to human-readable `[scope] message`.
- **Route observability**: all API routes use `createRouteObservation` / `observeRouteResponse` (`src/lib/server/route-observability.ts`) to log duration, outcome, and error codes.
- **Product analytics**: `@vercel/analytics` and `@vercel/speed-insights` are mounted in the root layout (`src/app/layout.tsx`).
- **There is no Sentry, PostHog, or OpenTelemetry** — those integrations were removed. Error tracking is via Vercel runtime logs (the structured JSON above). Do not reintroduce them without an explicit decision.

### Integrations

- **Feature flags** — see the dedicated section above.

## File Structure

```
src/
  app/
    (auth)/             # Sign-in / sign-up pages (route group)
    (home)/             # Main app — wraps children in ThreadStoreProvider
      page.tsx          #   server component: auth-guards, getModels(), seeds RQ cache
    api/
      agent/route.ts       # POST /api/agent — streaming agent endpoint
      agent/follow-ups/    # Follow-up question suggestions
      auth/[...all]/       # Better Auth catch-all
      models/route.ts      # GET /api/models — available models for configured keys
      threads/route.ts     # GET/PUT/DELETE /api/threads — thread CRUD
    layout.tsx          # Root layout: fonts, dark theme, Analytics + SpeedInsights, dev cache-reset
    manifest.ts         # PWA manifest (production-only standalone)
  components/
    agent/home/         # Chat core: use-agent-session, agent-stream-state/-events,
                        #   thread-store-context, use-thread-store, home-content,
                        #   follow-up-questions
    agent/messages/     # Message rendering (user, assistant, queued, activity timeline)
    agent/markdown/     # Memoized markdown renderer
    agent/prompt-form/  # PromptForm (single model; no selector)
    app-sidebar.tsx     # Sidebar shell (lazy-loads SearchChats + NavThreads)
    nav-threads.tsx     # Thread list + client-side pinning (localStorage)
    nav-user.tsx        # Account menu + sign-out
    search-chats.tsx    # Client-side thread title search dialog
    auth/               # Sign-in/up forms, auth shell
    graphics/           # Logo + visual effects
    layout/             # route group layout
    ui/                 # shadcn/ui primitives (base-lyra/stone) + ShikiCode
  hooks/
    agent/              # use-models (server-seeded models context)
  lib/
    actions/api-keys.ts # getModels() server action
    brand/colors.ts     # App brand colors (used by layout/manifest)
    editor/highlighter.ts
    server/
      agent-context.ts          # buildAgentSystemInstruction
      agent-prompt-steering.ts  # Provider overlay (GLM tuning)
      agent-route.ts            # parseAgentStreamRequest, createAgentStreamResponse
      agent-runtime-config.ts   # Runtime constants (no env knobs)
      auth.ts / auth-session.ts # isAuthConfigured, getRequestSession
      integration-flags.ts      # Default-off feature flags (env + Edge Config)
      privacy.ts                # hashUserId (telemetry user hashing)
      route-observability.ts    # createRouteObservation, observeRouteResponse
      threads.ts / thread-payload.ts  # Thread CRUD + Zod parsing
      postgres.ts               # getDatabase() Kysely instance
      llm/
        agent-runtime.ts                  # Core tool-loop orchestration
        agent-runtime-messages.ts         # Message preparation (rejects system-role)
        agent-runtime-synthesis-gating.ts # Final-step + mid-budget synthesis predicates
        gateway-responses.ts              # startGatewayResponseStream
        gateway-client.ts                 # undici dispatcher for AI Gateway
        ai-sdk-tavily-tools.ts            # tavily_search / tavily_extract
        initial-reasoning-chunk-sanitizer.ts # Redacted-reasoning filtering
        system-instruction-augmentations.ts  # Citation rules appended to prompt
    shared/
      agent/messages.ts          # AgentStreamEvent, Message, ToolInvocation, run statuses
      agent/reasoning-privacy.ts # sanitizeReasoningForDisplay
      agent-request-limits.ts    # Message/char limit defaults
      llm/models.ts              # AvailableModels, ModelInfos, SUPPORTED_MODELS, DEFAULT_MODEL
      llm/system-instructions.ts # DEFAULT_OPERATING_INSTRUCTION, DEFAULT_SOUL_FALLBACK_INSTRUCTION
      threads.ts                 # Thread type, sort/normalize/deriveThreadTitle
  proxy.ts                # Next.js middleware (named export `proxy` + `config`)
tests/
  *.test.mjs              # ~50 Node built-in test-runner files (no Jest/Vitest)
  smoke/                  # Playwright specs (mock + live authenticated chat)
  stubs/                  # Per-module server stubs (via register-ts-path-hooks.mjs)
```

## Testing

Tests use Node's built-in runner (`node --test`) — no Jest, no Vitest. Test files are `.mjs` ES modules.

```bash
pnpm test                                          # ~50 unit test files (tests/*.test.mjs)
node --test tests/agent-route-contract.test.mjs    # Single file
```

- `pnpm test` runs **unit tests only** — the Playwright `*.spec.mjs` files under `tests/smoke/` run via `test:smoke*` scripts.
- Stubs in `tests/stubs/` mock server-only modules (postgres, auth-session, …) so tests run without a database.
- `tests/register-ts-path-hooks.mjs` wires `@/` path resolution and supports per-test module stub injection (`setTestModuleStubs`).
- Smoke: `tests/smoke/mock-authenticated-chat.spec.mjs` is credential-free (used by CI); `authenticated-chat.spec.mjs` needs `SMOKE_EMAIL`/`SMOKE_PASSWORD`.

## Key Conventions

**TypeScript**: strict mode + `noUncheckedIndexedAccess` (every array index access must handle `undefined`). Target ES2022, module resolution Bundler. Path alias `@/*` → `src/*`.

**Named exports only** — default exports are allowed only in `src/app/**` (Next.js page/layout/route files) and `src/types/assets.d.ts`. Enforced via an ESLint `no-restricted-syntax` rule on `ExportDefaultDeclaration`.

**ESLint** (type-checked configs on `src/**` + `auth.ts`): beyond `simple-import-sort`, notable error-level rules include `no-console` (warn/error allowed), `@typescript-eslint/no-floating-promises`, `no-misused-promises`, `no-unnecessary-condition`, and `consistent-type-imports` (inline `import type`). `reportUnusedDisableDirectives` is on. Run `pnpm lint:fix` to auto-sort imports.

**Prettier**: `semi: false`, double quotes, `tabWidth: 2`, `printWidth: 80`, `trailingComma: es5`. Only `prettier-plugin-tailwindcss` is configured (`tailwindFunctions: ["cn", "cva"]`); import sorting is ESLint's job, not Prettier's.

**API error shape**: all errors return `{ error, errorCode }` with `X-Request-Id` and `X-Error-Code` headers.

**Zod v4** (`zod@^4`): API differs from v3 (`.strict()` behavior, `z.iso.datetime()`, error formatting).

**Stack**: React 19, Next.js 16.2.6, Node `24.x`, pnpm `10.32.1`. Client components use `"use client"` by directory convention. UI is shadcn/ui (`base-lyra` style, `stone` base color, lucide icons; see `components.json`).

**Bundle budget**: `pnpm bundle:budget` fails if total `.next/static` JS exceeds 14 MiB or any single chunk exceeds 1 MiB (overridable via `BUNDLE_MAX_STATIC_CHUNKS_BYTES` / `BUNDLE_MAX_STATIC_CHUNK_BYTES`). CI runs both `bundle:budget` and `bundle:report`.

**Security headers**: a strict CSP and full security-header set (`X-Frame-Options: DENY`, HSTS preload, COOP, Permissions-Policy, `poweredByHeader: false`) are configured in `next.config.mjs`; CSP + HSTS apply in production only.

**CI** (`.github/workflows/ci.yml`): a `checks` job (lint → format:check → test → typecheck → build → bundle:budget → bundle:report), a separate `smoke` job in the Playwright image, and a `vercel-status` job that aggregates both into a single `Vercel` commit status. Vercel build runs `pnpm migrate && pnpm build`; `scripts/vercel-ignore-build.mjs` skips builds for docs/tooling-only diffs.

## Environment Variables

Required for a working local instance:

```
DATABASE_URL=
BETTER_AUTH_SECRET=
BETTER_AUTH_URL=http://localhost:3000
AI_GATEWAY_API_KEY=
```

All others are optional with safe defaults. See `.env.example` for the annotated list.

| Variable                      | Purpose                                                             |
| ----------------------------- | ------------------------------------------------------------------- |
| `AUTH_DATABASE_URL`           | Separate DB for Better Auth (falls back to / reuses `DATABASE_URL`) |
| `BETTER_AUTH_TRUSTED_ORIGINS` | Comma-separated additional trusted origins                          |
| `BETTER_AUTH_COOKIE_DOMAIN`   | Shared cookie domain for cross-subdomain auth                       |
| `TAVILY_API_KEY`              | Enables `tavily_search` + `tavily_extract`                          |
| `EDGE_CONFIG`                 | Vercel Edge Config connection for remote feature flags              |
| `AGENT_TELEMETRY_RECORD_IO`   | Feature flag: record prompt/output IO in telemetry (default off)    |

Request size limits, stream/gateway timeouts, tool-step budgets, and body-size limits are **fixed constants** in `src/lib/server/agent-runtime-config.ts` / `next.config.mjs` — not env-configurable. Change them in code if needed.

## Gotchas

- **Run `pnpm migrate` before the first request.** Storage does not self-initialize on live requests; uninitialized tables surface as a 500 with a migration message.
- **`pnpm test` is unit-only.** Smoke tests need a prior production build (`pnpm test:smoke:mock:build`).
- The **mock smoke test uses the production server** (`next start`), so build first.
- `pnpm.onlyBuiltDependencies` already approves the `sharp` build script — do not run `pnpm approve-builds`.
- Don't reintroduce Sentry/PostHog/OpenTelemetry; they were intentionally removed in favor of Vercel Analytics/Speed Insights + structured logs.
- Pinning is **client-side localStorage** — there is no server column or API for it. There is no model selection or persistence: the app runs on the single `DEFAULT_MODEL` (GLM 5.2).
- After signing up via `/api/auth/sign-up/email`, the session cookie is set automatically; no separate sign-in is needed.
