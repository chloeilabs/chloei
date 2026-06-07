"""FastAPI surface for the TradingAgents sidecar.

Endpoints
---------
- ``GET  /health``  liveness + whether LLM credentials are present
- ``GET  /config``  roster, analysts, depth presets, defaults (drives the UI)
- ``POST /analyze`` Server-Sent Events stream of a multi-agent analysis

The analysis stream is produced by a synchronous generator (the upstream graph
stream is blocking). The endpoint is declared ``def`` so Starlette iterates it
in a threadpool and the event loop stays responsive.
"""

from __future__ import annotations

import hmac
import logging
from typing import Iterator

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from . import __version__, events
from .config import (
    ALLOWED_ORIGINS,
    DEFAULT_DEEP_MODEL,
    DEFAULT_PROVIDER,
    DEFAULT_QUICK_MODEL,
    MOCK_ALWAYS,
    SERVICE_TOKEN,
    has_llm_credentials,
    seed_provider_api_key,
)
from .roster import (
    ANALYST_KEYS,
    DEFAULT_DEPTH,
    DEPTH_PRESETS,
    SIGNALS,
    TEAMS,
)
from .schemas import AnalyzeRequest

app = FastAPI(title="Chloei TradingAgents Service", version=__version__)

# Never fall back to the "*" wildcard while credentials are allowed (browsers
# reject that pairing). ALLOWED_ORIGINS carries explicit localhost defaults from
# config.py; the Chloei app proxies the service server-side, so an empty list
# simply blocks direct browser access rather than breaking anything.
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _on_startup() -> None:
    # Copy AI_GATEWAY_API_KEY into the active provider's key env var so the
    # framework's LLM client finds it without extra operator setup.
    seed_provider_api_key()
    # Warm the heavy analysis import at boot so the first /analyze doesn't spend
    # several seconds importing the TradingAgents stack before its first byte —
    # that silent gap was getting the streaming connection dropped. Best-effort:
    # mock-only deployments may not have the stack installed.
    if not MOCK_ALWAYS:
        try:
            from .runner import warm_imports

            warm_imports()
        except Exception as exc:  # noqa: BLE001 - warming is best-effort
            logging.getLogger("uvicorn.error").warning(
                "TradingAgents warm-import skipped: %s", exc
            )


def _check_token(provided: str | None) -> None:
    """Enforce the shared service token when one is configured."""
    if SERVICE_TOKEN and not hmac.compare_digest(provided or "", SERVICE_TOKEN):
        raise HTTPException(status_code=401, detail="Invalid service token.")


def _should_mock(req: AnalyzeRequest) -> bool:
    if req.mock is True:
        return True
    if req.mock is False:
        return False
    return MOCK_ALWAYS or not has_llm_credentials()


@app.get("/health")
def health() -> JSONResponse:
    return JSONResponse(
        {
            "status": "ok",
            "version": __version__,
            "llm_ready": has_llm_credentials(),
            "mock_default": MOCK_ALWAYS,
        }
    )


@app.get("/config")
def config() -> JSONResponse:
    """Everything the frontend needs to render the form and pipeline."""
    return JSONResponse(
        {
            "teams": TEAMS,
            "analysts": ANALYST_KEYS,
            "depths": [
                {"id": depth, "label": depth.capitalize(), **rounds}
                for depth, rounds in DEPTH_PRESETS.items()
            ],
            "default_depth": DEFAULT_DEPTH,
            "signals": SIGNALS,
            "defaults": {
                "provider": DEFAULT_PROVIDER,
                "deep_think_llm": DEFAULT_DEEP_MODEL,
                "quick_think_llm": DEFAULT_QUICK_MODEL,
            },
            "llm_ready": has_llm_credentials(),
            "mock_default": MOCK_ALWAYS,
        }
    )


@app.post("/analyze")
def analyze(
    req: AnalyzeRequest,
    request: Request,
    x_service_token: str | None = Header(default=None),
) -> StreamingResponse:
    _check_token(x_service_token)
    use_mock = _should_mock(req)

    def event_stream() -> Iterator[str]:
        # Flush a byte immediately so the streaming response is never silent
        # while the run spins up. An initial silent gap (the lazy import below,
        # then graph construction) was long enough that the upstream connection
        # got dropped before the first event — surfacing to the caller as a
        # "terminated" stream. SSE comment lines are ignored by the client.
        yield ": ready\n\n"
        # Import the heavy real runner lazily so mock mode and /health never
        # require the TradingAgents stack to be importable (it is warmed at
        # startup, so this is normally a cache hit).
        generator = None
        try:
            if use_mock:
                from .mock import mock_analysis

                generator = mock_analysis(req)
            else:
                from .runner import run_analysis

                generator = run_analysis(req)
            for event in generator:
                yield events.sse(event)
            yield events.sse({"type": "done"})
        except GeneratorExit:
            # The caller disconnected. Stop the upstream run so it doesn't keep
            # making LLM calls for a result nobody will read, and do NOT yield
            # (yielding while the generator is closing raises "generator ignored
            # GeneratorExit").
            if generator is not None:
                try:
                    generator.close()
                except Exception:  # noqa: BLE001 - best-effort cancellation
                    pass
            raise
        except Exception as exc:  # noqa: BLE001 - always close the stream cleanly
            yield events.sse(events.error(str(exc), where="analyze"))
            yield events.sse({"type": "done"})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # disable nginx/proxy buffering
        },
    )


@app.get("/")
def root() -> JSONResponse:
    return JSONResponse(
        {
            "service": "chloei-tradingagents",
            "version": __version__,
            "endpoints": ["/health", "/config", "/analyze"],
        }
    )


if __name__ == "__main__":
    import os

    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8000")),
        reload=bool(os.environ.get("TRADINGAGENTS_RELOAD")),
    )
