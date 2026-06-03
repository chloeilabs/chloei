"""Pydantic request/response models for the service HTTP surface."""

from __future__ import annotations

import re
from typing import List, Optional

from pydantic import BaseModel, Field, field_validator

from .roster import ANALYST_KEYS, DEFAULT_DEPTH, DEPTH_PRESETS

# Tickers are used as path components by the framework's on-disk logging, which
# already hardens against traversal; we additionally constrain the shape here.
# Allows symbols like AAPL, BRK.B, 7203.T, BTC-USD. The leading look-ahead
# requires at least one alphanumeric so punctuation-only inputs (".", "..") are
# rejected before they can reach any filesystem path.
_TICKER_RE = re.compile(r"^(?=.*[A-Za-z0-9])[A-Za-z0-9.\-^=]{1,15}$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class AnalyzeRequest(BaseModel):
    """Body for ``POST /analyze``."""

    ticker: str = Field(..., description="Ticker symbol, e.g. NVDA")
    trade_date: Optional[str] = Field(
        default=None, description="Analysis date YYYY-MM-DD; defaults to today (UTC)."
    )
    analysts: List[str] = Field(
        default_factory=lambda: list(ANALYST_KEYS),
        description="Subset of analyst keys to run.",
    )
    depth: str = Field(
        default=DEFAULT_DEPTH, description="Research depth preset: shallow|medium|deep."
    )
    asset_type: str = Field(default="stock", description="stock or crypto.")
    # Reserved / no-op: TradingAgents 0.2.5 removed the online_tools switch and
    # sources data via config["data_vendors"] (yfinance, live). Accepted for
    # backward compatibility with older clients; it does not change a run.
    online: bool = Field(default=True, description="Reserved; no effect in 0.2.5.")

    # Optional LLM overrides; default to the AI Gateway routing in config.py.
    llm_provider: Optional[str] = None
    backend_url: Optional[str] = None
    deep_think_llm: Optional[str] = None
    quick_think_llm: Optional[str] = None

    # Force the canned/no-LLM run regardless of server default. Useful for
    # frontend development and CI without any credentials.
    mock: Optional[bool] = None

    @field_validator("ticker")
    @classmethod
    def _validate_ticker(cls, value: str) -> str:
        value = value.strip().upper()
        if not _TICKER_RE.match(value):
            raise ValueError("Invalid ticker symbol.")
        return value

    @field_validator("trade_date")
    @classmethod
    def _validate_date(cls, value: Optional[str]) -> Optional[str]:
        if value is None or value == "":
            return None
        if not _DATE_RE.match(value):
            raise ValueError("trade_date must be YYYY-MM-DD.")
        return value

    @field_validator("analysts")
    @classmethod
    def _validate_analysts(cls, value: List[str]) -> List[str]:
        cleaned = [a.strip().lower() for a in value if a and a.strip()]
        invalid = [a for a in cleaned if a not in ANALYST_KEYS]
        if invalid:
            raise ValueError(f"Unknown analyst keys: {', '.join(invalid)}")
        if not cleaned:
            raise ValueError("Select at least one analyst.")
        # Preserve canonical order regardless of input order.
        return [a for a in ANALYST_KEYS if a in cleaned]

    @field_validator("depth")
    @classmethod
    def _validate_depth(cls, value: str) -> str:
        value = value.strip().lower()
        if value not in DEPTH_PRESETS:
            raise ValueError(f"depth must be one of: {', '.join(DEPTH_PRESETS)}")
        return value

    @field_validator("asset_type")
    @classmethod
    def _validate_asset_type(cls, value: str) -> str:
        value = value.strip().lower()
        if value not in ("stock", "crypto"):
            raise ValueError("asset_type must be 'stock' or 'crypto'.")
        return value
