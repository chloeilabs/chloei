# Chloei

Chloei is a Next.js 16 chat app backed by Vercel AI Gateway. It currently exposes a curated model selector with Kimi K2.6, DeepSeek V4 Pro, and Grok 4.3, uses GPT-5.5 for deep research runs, and supports file attachments, native web search, local code execution, optional Tavily retrieval, optional Financial Modeling Prep MCP tools, and Better Auth email/password authentication with PostgreSQL-backed users and sessions.

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

Add `AI_GATEWAY_API_KEY` to `.env.local` before starting the app. Add `TAVILY_API_KEY` if you want Tavily search and extract tools. Add `FMP_API_KEY` if you want the curated finance tools. The app runs on [http://localhost:3000](http://localhost:3000).

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
- `pnpm test:smoke:mock`: run the credential-free mocked Playwright smoke test used by CI
- `pnpm lint`: run blocking ESLint checks
- `pnpm lint:fix`: apply autofixable ESLint changes
- `pnpm format`: write Prettier formatting changes
- `pnpm format:check`: verify formatting without writing changes
- `pnpm typecheck`: run TypeScript checks

## Deployment checklist

1. Sync local secrets when needed with `vercel env pull .env.local`, then remove any stale keys the app no longer uses.
2. Run `pnpm test`, `pnpm lint`, `pnpm typecheck`, and `pnpm build`.
3. Open a pull request to `main` and wait for the required `checks` and `Vercel` statuses.
4. Smoke test the preview deployment: sign in, confirm models load, send one prompt, and verify thread persistence.
5. Merge to `main` after the preview passes, then confirm production is aliased to [chloei.ai](https://chloei.ai).
6. Run one authenticated production smoke test: sign in, load models, send a prompt, and verify an existing thread still reopens cleanly.

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
- `FMP_API_KEY`: enables curated Financial Modeling Prep MCP tools for structured finance data
- `FRED_API_KEY`: enables macro/rates series through the normalized `finance_data` tool
- `SEC_API_USER_AGENT`: identifies Chloei for SEC public company-facts requests

By default, Chloei enforces safe built-in agent limits even if you leave all optional `AGENT_*` env vars unset.
`AGENT_RATE_LIMIT_STORE` defaults to `auto`, which uses PostgreSQL when `DATABASE_URL` is configured and falls back to process memory for local/no-database runs. Set it to `postgres` to require shared rate limits or `memory` for local-only limits.

## Important paths

- `src/app/(home)/page.tsx`: app entry for the home screen
- `src/app/(auth)/sign-in/page.tsx`: public sign-in screen
- `src/app/(auth)/sign-up/page.tsx`: public sign-up screen
- `src/app/api/auth/[...all]/route.ts`: Better Auth route handler
- `src/app/api/agent/route.ts`: streaming agent endpoint
- `src/app/api/models/route.ts`: available-models endpoint
- `src/components/agent`: chat UI, prompt form, markdown rendering, and session state
- `src/lib/server`: Better Auth config, PostgreSQL setup, runtime config, rate limiting, and model streaming

## Notes

- The current model list is defined in `src/lib/shared/llm/models.ts`.
- `/`, `/api/agent`, and `/api/models` require an authenticated Better Auth session.
- Native `web_search` is available through AI Gateway alongside Tavily, FMP, and local code execution.
- `finance_data` normalizes finance operations across FMP, SEC public company facts, Stooq fallbacks, and optional FRED macro/rates data. When `FMP_API_KEY` is configured, FMP is preferred over Stooq for supported market-data operations. FMP MCP remains available for FMP-specific chat and research runs.
- `curated_finance` is Chloei's higher-level finance harness tool. It routes tasks such as market data, company snapshots, statements, filing facts, macro series, and identifier resolution through the best available provider while recording evidence and verification metadata.
- `code_execution` can use the local restricted/finance runner or `AGENT_CODE_EXECUTION_BACKEND=vercel_sandbox` for isolated Vercel Sandbox microVM execution. Use a sandbox snapshot for production finance workloads that need pandas, numpy, scipy, statsmodels, matplotlib, openpyxl, or xlsxwriter.
- Finance eval fixtures and GDPval-style harness scripts live in `evals/finance`.
- To share logins with another Chloei app, point both apps at the same Better Auth database and secret, set `BETTER_AUTH_COOKIE_DOMAIN` to the shared parent domain, and include every live subdomain in `BETTER_AUTH_TRUSTED_ORIGINS`.
- Rate limiting and concurrency protection are PostgreSQL-backed when `DATABASE_URL` is configured. Local/no-database runs fall back to in-memory limits unless `AGENT_RATE_LIMIT_STORE=postgres` is set.
- App storage does not self-initialize on live requests. Vercel deployments in this repo run `pnpm migrate` before `next build`.

## Browser smoke tests

`pnpm test:smoke` runs Playwright against `SMOKE_BASE_URL` or starts the local dev server at `http://localhost:3000`. Set `SMOKE_EMAIL` and `SMOKE_PASSWORD` for an existing test account before running the live authenticated smoke test. Optional `SMOKE_PROMPT` and `SMOKE_EXPECTED_TEXT` let you tune the live prompt assertion.

`pnpm test:smoke:mock` runs a CI-safe authenticated chat flow with `E2E_MOCK_AUTH=1`, in-memory thread storage, and a deterministic mock agent response. It does not require Better Auth credentials, PostgreSQL, or AI provider API keys.
