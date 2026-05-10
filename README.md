# Chloei

Chloei is a Next.js 16 chat app backed by Vercel AI Gateway. It currently exposes a curated model selector with Kimi K2.6 and DeepSeek V4 Pro, uses GPT-5.5 only for deep research runs, and offers private Blob-backed file attachments, local code execution, optional Tavily retrieval, optional governed Upstash Search knowledge retrieval, optional Browserbase dynamic browsing, optional Inngest jobs, normalized finance data, SEC/EDGAR filing retrieval, optional Financial Modeling Prep MCP tools, optional Mem0 long-term memory, and Better Auth email/password authentication with PostgreSQL-backed users and sessions.

## Requirements

- Node.js 24.x
- pnpm 10.32.1

## Getting started

```bash
pnpm install
cp .env.example .env.local
pnpm migrate
pnpm dev
```

Add `AI_GATEWAY_API_KEY` to `.env.local` before starting the app. Add `TAVILY_API_KEY` if you want Tavily search and extract tools. Add `FMP_API_KEY` if you want the curated finance tools. Add the Mem0 memory variables documented below if you want long-term memory. The app runs on [http://localhost:3000](http://localhost:3000).

To enable auth locally, provision PostgreSQL and add:

- `DATABASE_URL`
- `AUTH_DATABASE_URL` if Better Auth should use a different database from app data
- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_URL=http://localhost:3000`
- `BETTER_AUTH_TRUSTED_ORIGINS=http://localhost:3000,http://127.0.0.1:3000` when you need multiple allowed origins
- `BETTER_AUTH_COOKIE_DOMAIN=chloei.ai` when you need shared sessions across trusted subdomains
- `vercel env pull .env.local` if you want local development to mirror the Vercel Development environment

## Scripts

- `pnpm dev`: start the Next.js dev server
- `pnpm migrate`: run both Better Auth and app-storage migrations
- `pnpm auth:migrate`: apply Better Auth schema changes to PostgreSQL
- `pnpm app:migrate`: apply app storage schema changes to PostgreSQL
- `pnpm build`: build the production app
- `pnpm bundle:budget`: check built static JavaScript chunks against bundle budgets
- `pnpm bundle:report`: report built static JavaScript chunk headroom and largest first-load routes
- `pnpm start`: run the production server
- `pnpm test`: run regression tests
- `pnpm test:smoke`: run opt-in Playwright browser smoke tests against `SMOKE_BASE_URL`
- `pnpm test:smoke:memory`: run opt-in authenticated memory smoke tests against `SMOKE_BASE_URL`
- `pnpm test:smoke:mock`: run the credential-free mocked Playwright smoke test used by CI
- `pnpm eval:finance`: run the finance benchmark harness in fixture mode
- `pnpm eval:finance -- --mode live`: run the live finance-agent harness against AI Gateway
- `pnpm eval:finance:live`: run the live public-markets finance acceptance suite
- `pnpm eval:finance:grade`: grade finance benchmark outputs
- `pnpm eval:finance:braintrust`: publish finance grade signals to Braintrust
- `pnpm mem0:smoke`: run a direct add/search/delete Mem0 REST smoke test
- `pnpm lint`: run blocking ESLint checks
- `pnpm lint:fix`: apply autofixable ESLint changes
- `pnpm format`: write Prettier formatting changes
- `pnpm format:check`: verify formatting without writing changes
- `pnpm typecheck`: run TypeScript checks

## Deployment checklist

1. Sync local secrets when needed with `vercel env pull .env.local`, then remove any stale keys the app no longer uses.
2. Run `pnpm test`, `pnpm lint`, `pnpm typecheck`, and `pnpm build`.
3. Open a pull request to `main` and wait for the required `checks` and `Vercel` statuses.
4. Smoke test the preview deployment: sign in, confirm models load, send one prompt, verify thread persistence, and run `SMOKE_BASE_URL=<preview-url> pnpm test:smoke:memory` when Mem0 is enabled.
5. Merge to `main` after the preview passes, then confirm production is aliased to [chloei.ai](https://chloei.ai).
6. Run one authenticated production smoke test: sign in, load models, send a prompt, verify an existing thread still reopens cleanly, and run the memory smoke against `https://chloei.ai`.

Managed integration rollout, rollback, and smoke-test steps live in [docs/managed-integrations-rollout.md](docs/managed-integrations-rollout.md). Public-markets finance answer quality checks live in [docs/finance-research-quality.md](docs/finance-research-quality.md).

## Environment

`.env.example` documents the supported environment variables. Required variables are:

- `AI_GATEWAY_API_KEY`: required to enable `/api/models` and `/api/agent`
- `DATABASE_URL`: PostgreSQL connection string for Better Auth
- `AUTH_DATABASE_URL`: optional Better Auth database override; falls back to `DATABASE_URL`
- `BETTER_AUTH_SECRET`: Better Auth signing secret
- `BETTER_AUTH_URL`: public app origin used by Better Auth, such as `http://localhost:3000`; on Vercel previews it can be omitted so the deployment URL is inferred automatically
- `BETTER_AUTH_TRUSTED_ORIGINS`: optional comma-separated list of additional allowed origins
- `BETTER_AUTH_COOKIE_DOMAIN`: optional shared parent cookie domain for cross-subdomain sessions; keep this production-only when preview deployments use `vercel.app` hosts

Optional variables let you override the built-in safe defaults for message limits, response timeout, rate limiting, concurrent requests per client, rate-limit storage, and Next.js request body limits.

- `TAVILY_API_KEY`: enables Tavily search and extract callable tools for chat requests
- `UPSTASH_SEARCH_REST_URL`, `UPSTASH_SEARCH_REST_TOKEN`, `UPSTASH_SEARCH_INDEX`, `UPSTASH_DISABLE_TELEMETRY=1`: enable governed internal `knowledge_search`
- `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`, `INNGEST_DEV`: enable `/api/inngest` and async job orchestration
- `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`: enable flag-gated consented `browser_research`
- `BLOB_READ_WRITE_TOKEN`: enables private Blob upload/download and private agent artifact URLs
- `AGENT_KNOWLEDGE_SEARCH_ENABLED`, `AGENT_BROWSERBASE_ENABLED`, `AGENT_ASYNC_REPORTS_ENABLED`, `AGENT_TELEMETRY_RECORD_IO`, `AGENT_FINANCE_WORKFLOWS_ENABLED`: feature gates; defaults are off unless explicitly set or synced through Edge Config
- `POSTHOG_ANALYTICS_ENABLED`, `POSTHOG_ANALYTICS_INTERNAL_USERS_ONLY`, `NEXT_PUBLIC_POSTHOG_ANALYTICS_ENABLED`, `NEXT_PUBLIC_POSTHOG_HOST`, `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN`: enable privacy-safe PostHog product analytics. Browser autocapture, pageviews, surveys, heatmaps, feature-flag requests, and replay are disabled; server events use hashed user ids, no GeoIP, and no PostHog person profiles. Server-side capture is restricted to `AGENT_INTERNAL_USER_EMAILS`/`AGENT_INTERNAL_USER_EMAIL_DOMAINS` unless `POSTHOG_ANALYTICS_INTERNAL_USERS_ONLY=false`.
- `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_TRACES_SAMPLE_RATE`, `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE`: Sentry error/performance telemetry with PII scrubbing and no replay sampling
- `BRAINTRUST_API_KEY`, `BRAINTRUST_PROJECT_NAME`, `BRAINTRUST_EXPERIMENT_NAME`: finance eval publication and trace correlation
- `FMP_API_KEY`: enables curated Financial Modeling Prep MCP tools for structured finance data
- `FRED_API_KEY`: enables macro/rates series through the normalized `finance_data` tool
- `SEC_API_USER_AGENT`: identifies Chloei for SEC public company-facts requests
- `AGENT_FINANCE_TOOL_MAX_STEPS`: max tool steps for finance-analysis runs, defaulting to 20
- `MEMORY_PROVIDER=mem0`: enables long-term memory through a separate Mem0 REST service. The default is `disabled`.
- `MEM0_API_URL`: Mem0 REST API origin, defaulting to `http://localhost:8888`. Use `https://api.mem0.ai` for Mem0 Platform keys.
- `MEM0_API_KEY`: Mem0 key value. Self-hosted OSS uses `X-API-Key`; Mem0 Platform uses `Authorization: Token ...`.
- `MEMORY_AGENT_ID`, `MEMORY_TOP_K`, `MEMORY_THRESHOLD`, `MEMORY_CONTEXT_MAX_CHARS`, and `MEMORY_COMMIT_MAX_CHARS`: optional memory scoping, retrieval, and prompt/commit bounds. Use distinct agent ids per environment, such as `chloei-local`, `chloei-development`, `chloei-preview`, and `chloei-production`. The default retrieval threshold is `0.1`.

By default, Chloei enforces safe built-in agent limits even if you leave all optional `AGENT_*` env vars unset.
`AGENT_RATE_LIMIT_STORE` defaults to `auto`, which uses PostgreSQL when `DATABASE_URL` is configured and falls back to process memory for local/no-database runs. Allowed values: `auto`, `postgres`, `memory`.

## Important paths

- `src/app/(home)/page.tsx`: app entry for the home screen
- `src/app/(auth)/sign-in/page.tsx`: public sign-in screen
- `src/app/(auth)/sign-up/page.tsx`: public sign-up screen
- `src/app/api/auth/[...all]/route.ts`: Better Auth route handler
- `src/app/api/agent/route.ts`: streaming agent endpoint
- `src/app/api/models/route.ts`: available-models endpoint
- `src/components/agent`: chat UI, prompt form, markdown rendering, and session state
- `src/lib/server`: Better Auth config, PostgreSQL setup, runtime config, rate limiting, and model streaming
- `src/lib/server/long-term-memory.ts`: Mem0 REST client, retrieval formatting, and memory commit helpers

## Notes

- The current model list is defined in `src/lib/shared/llm/models.ts`.
- `/`, `/api/agent`, and `/api/models` require an authenticated Better Auth session.
- Native `web_search` is available through AI Gateway alongside Tavily, FMP, and local code execution.
- `knowledge_search` is for governed static/internal material only. Live financial facts stay routed through `finance_data`, SEC/FRED/FMP, Tavily, and AI Gateway web search.
- `browser_research` requires the Browserbase flag, credentials, explicit consent, and an allowed-domain URL. It is not used for routine search and must not collect credentials.
- PostHog is used for coarse product analytics and rollout analysis only when `analytics.posthog.enabled` or `POSTHOG_ANALYTICS_ENABLED` is on, and server-side capture remains internal-user gated by default. Do not capture prompt text, model output, uploaded filenames, blob paths, document hashes, emails, account data, or credentials in PostHog events.
- `POST /api/jobs/report` accepts an optional client-generated `reportId` UUID for retry idempotency. Idempotency keys must use report/thread identifiers, not prompt text or document contents.
- `finance_data` normalizes finance operations across FMP, SEC public company facts, and optional FRED macro/rates data. FMP MCP remains available as a migration compatibility path for chat-default runs.
- `sec_filings` is available when a normal chat or Research request is inferred as finance-analysis work, covering SEC/EDGAR company lookup, filing search, full filing fetches, section extraction, table extraction, and targeted retrieval over filing text.
- Long-term memory is opt-in and best effort. When `MEMORY_PROVIDER=mem0`, Chloei retrieves user-scoped memories before each agent run and writes the latest user/assistant turn after meaningful completed or incomplete responses. Memory failures never block chat. Self-hosted OSS and Mem0 Platform are both supported through `MEM0_API_URL`; Platform mode stores durable memories under `user_id`, keeps Chloei's agent/thread scope in metadata for reliable cross-thread retrieval and cleanup, and temporarily falls back to the legacy per-user `app_id` scope for old memories.
- Run Mem0 separately with its REST API and dashboard. For a low-friction shared provider setup, configure Mem0's OpenAI-compatible LLM/embedder through Vercel AI Gateway with `OPENAI_BASE_URL=https://ai-gateway.vercel.sh/v1`, `OPENAI_API_KEY=$AI_GATEWAY_API_KEY`, `openai/text-embedding-3-small` for embeddings, and a low-cost GPT model for memory extraction. Prefer private networking and HTTPS outside local development.
- Finance eval fixtures, the live public-markets acceptance suite, live-agent eval mode, and GDPval-style harness scripts live in `evals/finance`.
- To share logins with another Chloei app, point both apps at the same Better Auth database and secret, set `BETTER_AUTH_COOKIE_DOMAIN` to the shared parent domain, and include every live subdomain in `BETTER_AUTH_TRUSTED_ORIGINS`.
- Rate limiting and concurrency protection are PostgreSQL-backed when `DATABASE_URL` is configured. Local/no-database runs fall back to in-memory limits unless `AGENT_RATE_LIMIT_STORE=postgres` is set.
- App storage does not self-initialize on live requests. Vercel deployments in this repo run `pnpm migrate` before `next build`.

## Browser smoke tests

`pnpm test:smoke` runs Playwright against `SMOKE_BASE_URL` or starts the local dev server at `http://localhost:3000`. Set `SMOKE_EMAIL` and `SMOKE_PASSWORD` for an existing test account before running the live authenticated smoke test. Optional `SMOKE_PROMPT` and `SMOKE_EXPECTED_TEXT` let you tune the live prompt assertion.

`pnpm test:smoke:mock` runs a CI-safe authenticated chat flow with `E2E_MOCK_AUTH=1`, in-memory thread storage, and a deterministic mock agent response. It does not require Better Auth credentials, PostgreSQL, or AI provider API keys.

`pnpm mem0:smoke` requires `MEMORY_PROVIDER=mem0`, `MEM0_API_URL`, and `MEM0_API_KEY`; it writes a disposable marker, retries search for up to 45 seconds to allow Mem0 extraction/indexing to settle, and deletes the marker. `pnpm test:smoke:memory` requires `SMOKE_EMAIL` and `SMOKE_PASSWORD`; use `SMOKE_BASE_URL=<preview-or-production-url>` for preview and production verification.
