# AGENTS.md

## Cursor Cloud-specific instructions

### Services

| Service            | How to start                    | Notes                                                                                                 |
| ------------------ | ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| PostgreSQL         | `sudo service postgresql start` | Native PostgreSQL 16 is provisioned by `.cursor/setup.sh`; must be running before dev server/migrate  |
| Next.js dev server | `pnpm dev`                      | Runs on port 3000; requires `.env.local` with `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` |

The Cursor Cloud image runs `.cursor/setup.sh` during installation and `.cursor/environment.json` starts PostgreSQL. The setup script installs dependencies, creates the `chloei` database/user when needed, writes local auth/database defaults, copies configured Cloud Agent secrets into `.env.local`, installs Playwright Chromium dependencies, and runs `pnpm migrate`.

### Environment

- `.env.local` must contain at minimum: `DATABASE_URL=postgresql://chloei:chloei_dev@127.0.0.1:5432/chloei`, `BETTER_AUTH_SECRET=<any-string>`, `BETTER_AUTH_URL=http://localhost:3000`.
- `AI_GATEWAY_API_KEY`, `TAVILY_API_KEY`, `FMP_API_KEY`, `FRED_API_KEY`, and `SEC_API_USER_AGENT` are configured as Cloud Agent secrets when available and should be written into `.env.local` before starting the dev server so Next.js picks them up.
- Without `AI_GATEWAY_API_KEY` the app starts and auth works, but `/api/models` returns an empty list and `/api/agent` cannot stream responses.
- Run `pnpm migrate` after provisioning the database and before the first request.

### Vercel CLI

- Run `vercel login` in a terminal and approve the device-login URL in your browser before using Vercel CLI commands in Cursor Cloud.
- This repo links to the Chloei Labs `chloei` Vercel project through `.vercel/project.json`.
- Use `vercel env pull .env.local --yes` to refresh Development env vars after login. Re-apply any local-only overrides afterward if you intentionally differ from Vercel Development.

### Docker daemon

Docker is optional for this repo because Cursor Cloud uses native PostgreSQL. If you need Docker in this VM, start it with flags that avoid restricted bridge/overlay features:

```bash
sudo sh -c 'dockerd --data-root=/var/lib/docker-vfs --storage-driver=vfs --iptables=false --bridge=none > /var/log/dockerd.log 2>&1'
```

Use `--network host` for local service containers. New terminals should have Docker group access; older terminals may need `sg docker -c 'docker ...'`.

### Commands reference

Standard commands are documented in `CLAUDE.md` and `README.md`. Key ones:

- **Lint**: `pnpm lint` (zero warnings enforced)
- **Typecheck**: `pnpm typecheck`
- **Unit tests**: `pnpm test` (no external services needed)
- **Smoke tests**: `pnpm test:smoke:mock:build` (builds the standalone production server, then runs the mocked smoke test)
- **Desktop smoke**: `pnpm desktop:smoke` (launches Electron in mock-auth mode)
- **Dev server**: `pnpm dev`

### Gotchas

- The mock Playwright smoke test (`pnpm test:smoke:mock`) uses `.next/standalone/server.js`, so run `pnpm build:standalone` first or use `pnpm test:smoke:mock:build`.
- Unit tests use stubs and run without a database. No external services are needed for `pnpm test`.
- The `pnpm.onlyBuiltDependencies` field in `package.json` already handles build script approval for `sharp`; do not run `pnpm approve-builds`.
- Node.js 24.x is required (pinned in `engines`). The VM needs `/usr/local/node/bin` on `PATH`.
- Prefer the native PostgreSQL service in Cursor Cloud. If you intentionally use Docker for PostgreSQL, run it with host networking because Docker bridge networking is disabled in the compatible daemon mode.
- After signing up a user via `/api/auth/sign-up/email`, the session cookie is automatically set; no separate sign-in step is needed.
