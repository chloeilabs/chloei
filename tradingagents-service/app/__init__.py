"""TradingAgents sidecar service for Chloei.

A thin FastAPI wrapper around the upstream TauricResearch/TradingAgents
multi-agent framework. It streams per-agent progress, report sections, and the
final trade decision to the Chloei frontend over Server-Sent Events.
"""

# Honor a local `.env` for non-Docker runs (Docker uses compose `env_file`).
# Loaded here in the package __init__ so it runs before submodules such as
# `config` read environment variables at import time. Best-effort: if
# python-dotenv isn't installed, environment variables still work as-is.
try:  # pragma: no cover - trivial bootstrap
    from dotenv import load_dotenv as _load_dotenv

    _load_dotenv()
except Exception:  # noqa: BLE001
    pass

__version__ = "0.1.0"
