# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
pnpm dev                  # Start dev server on port 3000
pnpm build                # Production build
pnpm start                # Run production server

# Database (must run before first request)
pnpm migrate              # Run both auth + app migrations
pnpm auth:migrate         # Better Auth schema only
pnpm app:migrate          # Thread/automation tables only

# Quality checks
pnpm lint                 # ESLint (zero warnings allowed)
pnpm lint:fix             # Auto-fix ESLint issues
pnpm typecheck            # next typegen && tsc --noEmit
pnpm format               # Prettier (write)
pnpm format:check         # Prettier (check only)

# Tests
pnpm test                                        # All tests
node --test tests/agent-route-contract.test.mjs  # Single test file
```

ESLint is configured with `--max-warnings=0`, so any warning is a build failure. Run `pnpm lint` before committing.

## Architecture

### Request Flow

```
Client (useAgentSession)
  → POST /api/agent (route.ts)
    → Auth check (getRequestSession)
    → Sliding-window rate limit + concurrency slot (rate-limit.ts)
    → Zod validation (parseAgentStreamRequest)
    → System prompt assembly (buildAgentSystemInstruction)
    → OpenRouter stream via Vercel AI SDK (startOpenRouterResponseStream)
    → NDJSON chunks → client
      → parseStreamEventLine / applyAgentStreamEvent
        → React state update → render
  → Thread upsert (upsertThreadForUser → PostgreSQL JSONB)
```

### Server / Client / Shared Boundary

- `src/lib/server/` — server-only. Never import from client components.
- `src/lib/shared/` — isomorphic. Safe to import anywhere.
- `src/lib/actions/` — Next.js server actions; callable from client.
- `src/components/` — client components and hooks.

Violating this boundary causes Next.js build errors because server modules (pg, better-auth) are not bundled for the browser.

### Streaming Protocol

`/api/agent` returns `Content-Type: application/x-ndjson`. Each line is a JSON-encoded `AgentStreamEvent`. The client reads the stream line-by-line in `readResponseStreamLines` and feeds events through `applyAgentStreamEvent` into an `AgentStreamAccumulator`.

Event types: `text_delta`, `agent_status` (`in_progress` | `completed` | `failed`), citation events, tool events.

### Thread Storage

Messages are stored as a JSONB column on the `thread` table (one row per thread, keyed on `(userId, id)`). There is no separate messages table. Upserts use `WHERE thread."updatedAt" <= EXCLUDED."updatedAt"` to prevent stale writes from overwriting newer state.

`isThreadStoreNotInitializedError` detects Postgres error codes `42P01`/`42703` and returns a 500 with a clear migration message rather than a generic crash.

### System Prompt Composition

`buildAgentSystemInstruction` (`src/lib/server/agent-context.ts`) assembles the system prompt per-request from labeled blocks:

1. `OPERATING INSTRUCTIONS` — from `DEFAULT_OPERATING_INSTRUCTION` in `src/lib/shared/llm/system-instructions.ts`
2. `RUNTIME DATE CONTEXT` — current UTC timestamp + user timezone (from `X-User-Timezone` header)
3. Provider / task-mode steering overlays (`agent-prompt-steering.ts`)
4. `SHARED CONTEXT FILE: SOUL.md` — from `agent-context/SOUL.md` or fallback
5. `AUTH USER CONTEXT` — authenticated user id, name, email

Optional per-user overrides: `agent-context/users/<encodeURIComponent(userId)>/USER.md` and `MEMORY.md`.

### Rate Limiting

In-memory only — resets on process restart, does not synchronize across instances. Two independent controls:

- **Sliding window**: 60 req / 60 s per user (keyed `user:<userId>`)
- **Concurrency slots**: max 4 in-flight requests per user

Both live in `src/lib/server/rate-limit.ts`. All limits are overridable via `AGENT_*` env vars; defaults are in `src/lib/server/agent-runtime-config.ts`.

### Model Registry

All available models are defined in `src/lib/shared/llm/models.ts` (`AvailableModels`, `ALL_MODELS`). Adding a model requires updating that file. The `/api/models` route reads from this registry; the agent validates the requested model against it.

### Authentication

Better Auth handles sessions. `getRequestSession` (`src/lib/server/auth-session.ts`) reads the session from request headers. Routes check `isAuthConfigured()` first — if `DATABASE_URL` / `BETTER_AUTH_SECRET` are missing, the app returns a 503 rather than crashing.

## Key Conventions

**TypeScript**: strict mode + `noUncheckedIndexAccess`. All array index access must handle `undefined`.

**API error shape**: all errors return `{ error: string, errorCode: string }` with `X-Request-Id` and `X-Error-Code` headers. Rate-limit responses include `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`.

**Named exports only** — default exports only appear in Next.js page/layout/route files.

**Import order**: enforced by `eslint-plugin-simple-import-sort`. Run `pnpm lint:fix` to auto-sort.

**Zod v4**: the project uses `zod@^4`. The API surface differs from v3 (e.g., `.strict()` behavior, error formatting).

## Environment Variables

Required for a working local instance:

```
DATABASE_URL=
BETTER_AUTH_SECRET=
BETTER_AUTH_URL=http://localhost:3000
OPENROUTER_API_KEY=
```

All other variables (`TAVILY_API_KEY`, `FMP_API_KEY`, `AGENT_*` limits) are optional — the code has safe defaults. See `.env.example` for the full list with inline documentation.

`AUTH_DATABASE_URL` overrides the database used by Better Auth (falls back to `DATABASE_URL`). Use this when sharing auth across multiple Chloei instances without mixing app data.
