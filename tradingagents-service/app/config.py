"""Service configuration and TradingAgents config builder.

Centralises how the service routes the upstream framework's LLM calls. By
default everything goes through Vercel AI Gateway's OpenAI-compatible endpoint
so billing and the model catalog are shared with the Chloei web app.

Why ``openrouter`` as the provider: TradingAgents' ``openai`` provider forces
the OpenAI Responses API (``/v1/responses``), which the AI Gateway does not
expose. The ``openrouter`` provider is OpenAI-compatible, uses plain Chat
Completions, honours a custom ``base_url``, and reads its key from
``OPENROUTER_API_KEY`` — exactly what we need to point at the gateway. Gateway
model slugs (e.g. ``alibaba/qwen3.7-max``) fall through to the framework's
default capability profile, so structured-output agents still work.
"""

from __future__ import annotations

import os
from typing import Any, Dict, Optional

# --- Service-level settings -------------------------------------------------

def _env_flag(name: str, *, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


SERVICE_TOKEN = os.environ.get("TRADINGAGENTS_SERVICE_TOKEN", "").strip()
MOCK_ALWAYS = _env_flag("TRADINGAGENTS_MOCK", default=False)

# Cross-run memory/reflection loop. When enabled (default), each run resolves
# the realized outcome of prior same-ticker calls, injects those reflections as
# context for the new run, and records the new decision — TradingAgents' native
# learning loop (see upstream ``TradingAgentsGraph.propagate``). Disable for
# fully stateless deployments; doing so nulls ``memory_log_path`` so every
# memory operation becomes a hard no-op.
MEMORY_ENABLED = _env_flag("TRADINGAGENTS_MEMORY_ENABLED", default=True)
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.environ.get(
        "TRADINGAGENTS_ALLOWED_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000"
    ).split(",")
    if origin.strip()
]

# --- LLM routing defaults (Vercel AI Gateway) -------------------------------

DEFAULT_PROVIDER = os.environ.get("TRADINGAGENTS_LLM_PROVIDER", "openrouter").strip()
DEFAULT_BACKEND_URL = os.environ.get(
    "TRADINGAGENTS_LLM_BACKEND_URL", "https://ai-gateway.vercel.sh/v1"
).strip()
DEFAULT_DEEP_MODEL = os.environ.get(
    "TRADINGAGENTS_DEEP_THINK_LLM", "alibaba/qwen3.7-max"
).strip()
DEFAULT_QUICK_MODEL = os.environ.get(
    "TRADINGAGENTS_QUICK_THINK_LLM", "alibaba/qwen3.7-max"
).strip()

# Map of provider -> API-key env var, mirroring TradingAgents'
# llm_clients.api_key_env so we can seed the right variable from the single
# AI_GATEWAY_API_KEY the operator provides.
_PROVIDER_KEY_ENV: Dict[str, str] = {
    "openai": "OPENAI_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "google": "GOOGLE_API_KEY",
    "xai": "XAI_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "qwen": "DASHSCOPE_API_KEY",
    "glm": "ZHIPU_API_KEY",
    "minimax": "MINIMAX_API_KEY",
}


def seed_provider_api_key() -> None:
    """Seed the active provider's API-key env var from AI_GATEWAY_API_KEY.

    The operator only has to set ``AI_GATEWAY_API_KEY`` (shared with Chloei).
    We copy it into whatever variable the configured provider's client reads
    (``OPENROUTER_API_KEY`` by default) unless that variable is already set, so
    a direct provider key still takes precedence when supplied explicitly.
    """
    gateway_key = os.environ.get("AI_GATEWAY_API_KEY", "").strip()
    if not gateway_key:
        return
    key_env = _PROVIDER_KEY_ENV.get(DEFAULT_PROVIDER.lower())
    if key_env and not os.environ.get(key_env):
        os.environ[key_env] = gateway_key


def has_llm_credentials() -> bool:
    """True when the active provider has an API key available."""
    if os.environ.get("AI_GATEWAY_API_KEY", "").strip():
        return True
    key_env = _PROVIDER_KEY_ENV.get(DEFAULT_PROVIDER.lower())
    return bool(key_env and os.environ.get(key_env, "").strip())


def build_trading_config(
    *,
    max_debate_rounds: int,
    max_risk_discuss_rounds: int,
    llm_provider: Optional[str] = None,
    backend_url: Optional[str] = None,
    deep_think_llm: Optional[str] = None,
    quick_think_llm: Optional[str] = None,
) -> Dict[str, Any]:
    """Build a TradingAgents config dict from defaults + per-request overrides.

    Imported lazily inside the function so the module can be imported (e.g. for
    ``/health`` and mock mode) without the heavy TradingAgents/langchain stack
    being installed.
    """
    from tradingagents.default_config import DEFAULT_CONFIG

    config: Dict[str, Any] = DEFAULT_CONFIG.copy()
    config["llm_provider"] = (llm_provider or DEFAULT_PROVIDER)
    config["backend_url"] = (backend_url or DEFAULT_BACKEND_URL) or None
    config["deep_think_llm"] = deep_think_llm or DEFAULT_DEEP_MODEL
    config["quick_think_llm"] = quick_think_llm or DEFAULT_QUICK_MODEL
    config["max_debate_rounds"] = max(1, int(max_debate_rounds))
    config["max_risk_discuss_rounds"] = max(1, int(max_risk_discuss_rounds))

    # Data sourcing. TradingAgents 0.2.5 has no online/offline switch: every data
    # tool reads its vendor from config["data_vendors"] (default: yfinance, which
    # is live and needs no API key). The classic ``online_tools`` boolean was
    # removed upstream, so we deliberately leave the framework default in place
    # rather than set a key the graph ignores.

    # Keep the framework's per-run on-disk artifacts and the cross-run memory
    # log inside a service-local directory so containers stay self-contained and
    # writable, and the memory log lands on the persisted volume the compose/env
    # files point at. Applied explicitly (rather than relying on DEFAULT_CONFIG
    # reading these at import time) so the configured paths win regardless of
    # import ordering.
    results_dir = os.environ.get("TRADINGAGENTS_RESULTS_DIR")
    if results_dir:
        config["results_dir"] = results_dir
    cache_dir = os.environ.get("TRADINGAGENTS_CACHE_DIR")
    if cache_dir:
        config["data_cache_dir"] = cache_dir
    memory_log_path = os.environ.get("TRADINGAGENTS_MEMORY_LOG_PATH")
    if memory_log_path:
        config["memory_log_path"] = memory_log_path

    # Hard kill-switch for the cross-run memory loop: with no log path every
    # TradingMemoryLog operation no-ops, so disabling memory is bulletproof
    # regardless of how callers use the graph.
    if not MEMORY_ENABLED:
        config["memory_log_path"] = None

    return config
