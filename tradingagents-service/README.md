# Chloei — TradingAgents service

A thin FastAPI sidecar that wraps the upstream
[TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents)
multi-agent framework and streams a full analysis to the Chloei **Trading Desk**
over Server-Sent Events.

A single run drives the whole firm: market / sentiment / news / fundamentals
analysts → bull-vs-bear research debate → research manager → trader → a
three-way risk debate → portfolio manager, ending in a `Buy / Overweight / Hold
/ Underweight / Sell` decision. The service streams per-agent status, each
report section as it lands, the debates, and the final decision.

## Why a separate service

TradingAgents is Python + LangGraph and a run takes ~1–3 minutes and ~30 LLM
calls — it cannot run inside Chloei's Next.js/Vercel serverless functions. The
Chloei app calls this service server-side and re-streams events to the browser.

## Endpoints

| Method | Path       | Purpose                                             |
| ------ | ---------- | --------------------------------------------------- |
| `GET`  | `/health`  | Liveness + whether LLM credentials are present      |
| `GET`  | `/config`  | Agent roster, analyst keys, depth presets, defaults |
| `POST` | `/analyze` | SSE stream of a multi-agent analysis                |

`POST /analyze` body:

```json
{
  "ticker": "NVDA",
  "trade_date": "2024-05-10",
  "analysts": ["market", "social", "news", "fundamentals"],
  "depth": "shallow",
  "asset_type": "stock",
  "mock": null
}
```

Each SSE `data:` frame is one event with a `type` discriminator:
`run_started`, `agent_status`, `report_section`, `debate_update`, `tool_call`,
`activity`, `stats`, `run_completed`, `error`, and a final `done` sentinel.

## LLM routing (Vercel AI Gateway)

Defaults route every agent through the gateway's OpenAI-compatible **Chat
Completions** endpoint using the `openrouter` provider adapter (the `openai`
provider would force the Responses API, which the gateway does not expose). Set
`AI_GATEWAY_API_KEY` — the same key the Chloei web app uses — and it is seeded
into `OPENROUTER_API_KEY` at startup. Override models with
`TRADINGAGENTS_DEEP_THINK_LLM` / `TRADINGAGENTS_QUICK_THINK_LLM` (gateway
`vendor/model` slugs). To use direct provider keys instead, set
`TRADINGAGENTS_LLM_PROVIDER` and that provider's key var.

## Run with Docker (recommended)

```bash
cp .env.example .env       # set AI_GATEWAY_API_KEY (+ TRADINGAGENTS_SERVICE_TOKEN)
docker compose up --build  # serves on http://localhost:8000
```

## Deploy to production (so the Trading Desk works on Vercel)

The Chloei web app can't run this service inside its Vercel serverless functions
(Python + LangGraph, minutes-long runs). Host it as a standalone container and
point Chloei at it. The image is portable — it binds to the platform's `$PORT`.

**1. Host the container.** It builds from this directory's `Dockerfile`.

- **Fly.io** (config included): `cd tradingagents-service && fly launch --no-deploy --copy-config --name <app>`, then `fly secrets set AI_GATEWAY_API_KEY=... TRADINGAGENTS_SERVICE_TOKEN=<secret>`, then `fly deploy`. URL: `https://<app>.fly.dev`.
- **Railway** (config included): create a service from this repo and set its **root directory to `tradingagents-service`** — Railway reads `railway.json` + the `Dockerfile`, injects `$PORT`, and gives you a public URL. Add the env vars below in the Variables tab. CLI alternative: `cd tradingagents-service && railway up`.
- **Render**: New → Web Service from this repo, **root directory `tradingagents-service`**, Docker runtime, health-check path `/health`; set the env vars below in the dashboard.

**2. Set these on the host** (secrets via the platform's secret store, never committed):

| Variable                       | Value                                                 |
| ------------------------------ | ----------------------------------------------------- |
| `AI_GATEWAY_API_KEY`           | your Vercel AI Gateway key (the same one Chloei uses) |
| `TRADINGAGENTS_SERVICE_TOKEN`  | a strong shared secret you generate                   |
| `TRADINGAGENTS_DEEP_THINK_LLM` | e.g. `openai/gpt-5.5`                                 |

**3. Point Chloei at it** — in the Vercel project env (Preview/Production):

```
TRADINGAGENTS_SERVICE_URL=https://<your-host>      # e.g. https://<app>.fly.dev
TRADINGAGENTS_SERVICE_TOKEN=<same shared secret>   # must match the sidecar
```

Redeploy Chloei. **Always set `TRADINGAGENTS_SERVICE_TOKEN`** in production: the
sidecar is public and makes authenticated LLM calls on your gateway key, so
`/analyze` must require the `X-Service-Token` header that Chloei sends.

## Run locally without Docker

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env       # then `set -a; source .env; set +a` to export
uvicorn app.main:app --reload --port 8000
```

To develop against a local TradingAgents checkout, comment out the `tradingagents`
line in `requirements.txt` and `pip install -e /path/to/TradingAgents`.

## Mock mode (no keys)

Set `TRADINGAGENTS_MOCK=1` (or send `{"mock": true}`) to stream a deterministic,
canned analysis with **no LLM calls and no API keys**. The event sequence is
identical to a real run, so the Trading Desk UI and CI can be exercised
end-to-end offline. Mock is also used automatically when no LLM credentials are
present (unless a request sets `"mock": false`).

## Cross-run memory (learning loop)

Enabled by default (`TRADINGAGENTS_MEMORY_ENABLED=1`). After each run the service
records its decision; the next run **on the same ticker** resolves how that call
actually played out (realized return vs. the ticker's benchmark), reflects on it
via the LLM, and injects those lessons into the new run's agent prompts. Over
time the desk learns from its own track record — TradingAgents' native
`propagate()` memory loop, preserved here alongside live event streaming.

- The first run on a ticker starts from a clean slate. Outcomes resolve on a
  **later** run once enough price history exists, so learning compounds.
- The reflection log is an append-only markdown file at
  `TRADINGAGENTS_MEMORY_LOG_PATH` (default
  `~/.tradingagents/memory/trading_memory.md`; the Docker compose file points it
  at the persistent `/data` volume).
- Set `TRADINGAGENTS_MEMORY_ENABLED=0` for a fully stateless service — this nulls
  the log path so every memory operation becomes a no-op.
- The loop is best-effort: any failure to resolve outcomes or write the log is
  swallowed and never blocks an analysis.

## Quick check

```bash
curl localhost:8000/health
curl localhost:8000/config
# Stream a mock run:
curl -N -X POST localhost:8000/analyze \
  -H 'content-type: application/json' \
  -d '{"ticker":"NVDA","depth":"shallow","mock":true}'
```

## Security

Set `TRADINGAGENTS_SERVICE_TOKEN` and the matching value in the Chloei app
(`TRADINGAGENTS_SERVICE_TOKEN`); `/analyze` then requires a matching
`X-Service-Token` header. The hosted deploys above expose a **public** endpoint,
so this token — not network isolation — is the security boundary: only callers
that send the matching header can spend your gateway key, so always set it in
production. Private networking, where your platform supports it, is a fine extra
layer but not a substitute.
