"""Runtime patches for the pinned upstream TradingAgents (v0.2.5).

Kept here so the upstream package stays an unmodified pinned dependency while we
correct internal inconsistencies from our own code. Every patch is best-effort:
a failure leaves upstream behaviour exactly as-is and never breaks an analysis.
"""

from __future__ import annotations

import logging

logger = logging.getLogger("tradingagents-service.patches")

_APPLIED = False


def apply_tradingagents_patches() -> None:
    """Apply all upstream patches once (idempotent, safe to call per run)."""
    global _APPLIED
    if _APPLIED:
        return
    _APPLIED = True  # set first so a failure can't retry on every request
    _register_verified_snapshot_in_market_node()


def _register_verified_snapshot_in_market_node() -> None:
    """Register ``get_verified_market_snapshot`` in the market analyst's tool node.

    Upstream v0.2.5 binds ``get_verified_market_snapshot`` to the market-analyst
    LLM and the system prompt orders it to call the tool before making exact
    price/indicator claims — but ``TradingAgentsGraph._create_tool_nodes`` builds
    the ``"market"`` ``ToolNode`` with only ``get_stock_data`` / ``get_indicators``.
    Every call to the tool therefore returns "... is not a valid tool", so the
    agent wastes a tool call and hedges its report ("that tool was not
    available").

    The tool runs on the same ``load_ohlcv`` dataflow as the already-working
    ``get_stock_data`` / ``get_indicators``, so registering it simply makes the
    verified-snapshot grounding work as upstream intends.
    """
    try:
        from langgraph.prebuilt import ToolNode
        from tradingagents.agents.utils.agent_utils import (
            get_verified_market_snapshot,
        )
        from tradingagents.graph.trading_graph import TradingAgentsGraph

        original_create_tool_nodes = TradingAgentsGraph._create_tool_nodes

        def _create_tool_nodes_with_verified_snapshot(self):
            nodes = original_create_tool_nodes(self)
            market = nodes.get("market")
            tools_by_name = getattr(market, "tools_by_name", None)
            if (
                market is not None
                and tools_by_name is not None
                and "get_verified_market_snapshot" not in tools_by_name
            ):
                nodes["market"] = ToolNode(
                    list(tools_by_name.values()) + [get_verified_market_snapshot]
                )
            return nodes

        TradingAgentsGraph._create_tool_nodes = (
            _create_tool_nodes_with_verified_snapshot
        )
        logger.info(
            "Patched market ToolNode to include get_verified_market_snapshot"
        )
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning(
            "Could not register get_verified_market_snapshot in market node: %s",
            exc,
        )
