# AGENTS.md

## Cursor Cloud-specific instructions

### Services

| Service            | How to start                                                                                                                                                                                                                             | Notes                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| PostgreSQL         | `docker start postgres` (if container exists) or `docker run -d --name postgres -e POSTGRES_USER=chloei -e POSTGRES_PASSWORD=chloei_dev -e POSTGRES_DB=chloei -p 5432:5432 -v postgres_data:/var/lib/postgresql/data postgres:16-alpine` | Must be running before dev server or migrations                                                       |
| Next.js dev server | `pnpm dev`                                                                                                                                                                                                                               | Runs on port 3000; requires `.env.local` with `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` |

### Environment

- `.env.local` must contain at minimum: `DATABASE_URL=postgresql://chloei:chloei_dev@localhost:5432/chloei`, `BETTER_AUTH_SECRET=<any-string>`, `BETTER_AUTH_URL=http://localhost:3000`.
- `AI_GATEWAY_API_KEY`, `TAVILY_API_KEY`, and `FMP_API_KEY` are configured as Cloud Agent secrets and injected as environment variables. Write them into `.env.local` before starting the dev server so Next.js picks them up (e.g. `grep -q 'AI_GATEWAY_API_KEY' .env.local || printf '%s\n' "AI_GATEWAY_API_KEY=$AI_GATEWAY_API_KEY" >> .env.local`).
- Without `AI_GATEWAY_API_KEY` the app starts and auth works, but `/api/models` returns an empty list and `/api/agent` cannot stream responses.
- Run `pnpm migrate` after provisioning the database and before the first request.

### Docker daemon

The Docker daemon must be started manually in this VM: `dockerd &>/var/log/dockerd.log &`. Wait a few seconds before running Docker commands.

### Commands reference

Standard commands are documented in `CLAUDE.md` and `README.md`. Key ones:

- **Lint**: `pnpm lint` (zero warnings enforced)
- **Typecheck**: `pnpm typecheck`
- **Unit tests**: `pnpm test` (127 tests, no external services needed)
- **Smoke tests**: `pnpm test:smoke:mock` (requires a production build via `pnpm build` first)
- **Dev server**: `pnpm dev`

### Gotchas

- The mock Playwright smoke test (`pnpm test:smoke:mock`) uses `next start`, so a production build (`pnpm build`) must exist before running it.
- Unit tests use stubs and run without a database. No external services are needed for `pnpm test`.
- The `pnpm.onlyBuiltDependencies` field in `package.json` already handles build script approval for `sharp`; do not run `pnpm approve-builds`.
- Node.js 24.x is required (pinned in `engines`). The VM needs `/usr/local/node/bin` on `PATH`.
- If `docker start postgres` fails with a "file exists" error after a VM restart, remove the stale container with `docker rm -f postgres` and recreate it with the full `docker run` command above.
- After signing up a user via `/api/auth/sign-up/email`, the session cookie is automatically set; no separate sign-in step is needed.
