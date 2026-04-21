# Chloei

Chloei is a Next.js 16 chat app backed by Vercel AI Gateway. It currently uses Anthropic Claude Sonnet 4.6, keeps a curated model selector for future expansion, and supports native web search, X search, local code execution, optional Tavily retrieval, optional Financial Modeling Prep MCP tools, and Better Auth email/password authentication with PostgreSQL-backed users and sessions.

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
- `pnpm start`: run the production server
- `pnpm test`: run regression tests
- `pnpm lint`: run blocking ESLint checks
- `pnpm lint:fix`: apply autofixable ESLint changes
- `pnpm format`: write Prettier formatting changes
- `pnpm format:check`: verify formatting without writing changes
- `pnpm typecheck`: run TypeScript checks

## Environment

`.env.example` documents the supported environment variables. Required variables are:

- `AI_GATEWAY_API_KEY`: required to enable `/api/models` and `/api/agent`
- `DATABASE_URL`: PostgreSQL connection string for Better Auth
- `AUTH_DATABASE_URL`: optional Better Auth database override; falls back to `DATABASE_URL`
- `BETTER_AUTH_SECRET`: Better Auth signing secret
- `BETTER_AUTH_URL`: public app origin used by Better Auth, such as `http://localhost:3000`; on Vercel previews it can be omitted so the deployment URL is inferred automatically
- `BETTER_AUTH_TRUSTED_ORIGINS`: optional comma-separated list of additional allowed origins
- `BETTER_AUTH_COOKIE_DOMAIN`: optional shared parent cookie domain for cross-subdomain sessions; keep this production-only when preview deployments use `vercel.app` hosts

Optional variables let you override the built-in safe defaults for message limits, response timeout, rate limiting, concurrent requests per client, and Next.js request body limits.

- `TAVILY_API_KEY`: enables Tavily search and extract callable tools for chat requests
- `FMP_API_KEY`: enables curated Financial Modeling Prep MCP tools for structured finance data

By default, Chloei enforces safe built-in agent limits even if you leave all optional `AGENT_*` env vars unset.

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
- FMP MCP uses a single server-owned API key and is intentionally limited to a curated set of finance tools.
- To share logins with another Chloei app, point both apps at the same Better Auth database and secret, set `BETTER_AUTH_COOKIE_DOMAIN` to the shared parent domain, and include every live subdomain in `BETTER_AUTH_TRUSTED_ORIGINS`.
- Rate limiting and concurrency protection are in-memory, so they reset on process restart and do not synchronize across instances.
- App storage does not self-initialize on live requests. Vercel deployments in this repo run `pnpm migrate` before `next build`.
