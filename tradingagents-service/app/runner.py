"""Real TradingAgents run, streamed as service events.

This ports the upstream CLI's ``graph.stream(...)`` loop (cli/main.py) into a
generator that yields the event dicts defined in ``events.py`` instead of
driving a Rich terminal display. The agent status-transition logic mirrors the
CLI exactly so the streamed pipeline stays faithful to how TradingAgents
actually progresses; on top of that we accumulate the bull/bear and risk
debates into structured, richer report sections than the CLI's single-panel
view.

The graph stream is synchronous and long-running. Callers iterate this
generator from a threadpool (the FastAPI endpoint is declared ``def``), keeping
the event loop free.
"""

from __future__ import annotations

import time
import uuid
from typing import Any, Dict, Iterator, List, Optional

from . import events
from .config import MEMORY_ENABLED, build_trading_config
from .roster import (
    ANALYST_KEYS,
    ANALYST_NAME_BY_KEY,
    ANALYST_REPORT_BY_KEY,
    TEAMS,
)
from .schemas import AnalyzeRequest

# Fixed (always-run) agents by team, in pipeline order. Mirrors the upstream
# CLI's FIXED_AGENTS so initial "pending" seeding matches the real graph.
_FIXED_AGENTS: List[str] = [
    "Bull Researcher",
    "Bear Researcher",
    "Research Manager",
    "Trader",
    "Aggressive Analyst",
    "Conservative Analyst",
    "Neutral Analyst",
    "Portfolio Manager",
]

_RESEARCH_TEAM = ["Bull Researcher", "Bear Researcher", "Research Manager"]
_MAX_ACTIVITY_CHARS = 600


def _today_utc() -> str:
    return time.strftime("%Y-%m-%d", time.gmtime())


def _content_to_text(content: Any) -> str:
    """Normalise a langchain message content to a plain string."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append(item.get("text", ""))
            elif isinstance(item, str):
                parts.append(item)
        return "\n".join(p for p in parts if p)
    return str(content) if content is not None else ""


def _compose(parts: List[tuple[str, str]]) -> str:
    """Compose labelled debate parts into one markdown section."""
    blocks = []
    for heading, body in parts:
        body = (body or "").strip()
        if body:
            blocks.append(f"### {heading}\n\n{body}")
    return "\n\n".join(blocks)


class _StatusTracker:
    """Tracks agent status, emitting an event only when a status changes."""

    def __init__(self, selected_analysts: List[str]) -> None:
        self.status: Dict[str, str] = {}
        for key in ANALYST_KEYS:
            if key in selected_analysts:
                self.status[ANALYST_NAME_BY_KEY[key]] = "pending"
        for name in _FIXED_AGENTS:
            self.status[name] = "pending"

    def set(self, name: str, status: str) -> Optional[Dict[str, Any]]:
        if name not in self.status or self.status[name] == status:
            return None
        # Never move a completed agent backwards.
        if self.status[name] == "completed" and status != "completed":
            return None
        self.status[name] = status
        return events.agent_status(name, status)


def run_analysis(req: AnalyzeRequest) -> Iterator[Dict[str, Any]]:
    """Run a real analysis, yielding service event dicts."""
    from cli.stats_handler import StatsCallbackHandler
    from tradingagents.graph.trading_graph import TradingAgentsGraph

    started = time.time()
    run_id = uuid.uuid4().hex
    trade_date = req.trade_date or _today_utc()

    from .roster import DEPTH_PRESETS

    rounds = DEPTH_PRESETS[req.depth]
    config = build_trading_config(
        max_debate_rounds=rounds["max_debate_rounds"],
        max_risk_discuss_rounds=rounds["max_risk_discuss_rounds"],
        llm_provider=req.llm_provider,
        backend_url=req.backend_url,
        deep_think_llm=req.deep_think_llm,
        quick_think_llm=req.quick_think_llm,
    )

    yield events.run_started(
        run_id=run_id,
        ticker=req.ticker,
        trade_date=trade_date,
        asset_type=req.asset_type,
        analysts=req.analysts,
        teams=TEAMS,
        llm={
            "provider": config["llm_provider"],
            "deep_think_llm": config["deep_think_llm"],
            "quick_think_llm": config["quick_think_llm"],
            "backend_url": config.get("backend_url"),
        },
        mock=False,
    )

    # Upstream v0.2.5 binds + prompts get_verified_market_snapshot for the market
    # analyst but omits it from that analyst's tool executor, so the call errors
    # ("not a valid tool") and the agent hedges. Register it before construction.
    # Best-effort + idempotent.
    from .patches import apply_tradingagents_patches

    apply_tradingagents_patches()

    stats_handler = StatsCallbackHandler()
    graph = TradingAgentsGraph(
        selected_analysts=list(req.analysts),
        debug=False,
        config=config,
        callbacks=[stats_handler],
    )

    # Cross-run memory/reflection loop — the learning that upstream propagate()
    # performs around the graph run. Best-effort: every step is guarded so the
    # loop can never break a live analysis and degrades to an empty context.
    #   1. Resolve realized outcomes of prior same-ticker calls. No-op on the
    #      first run; on later runs it fetches returns and reflects via the LLM.
    #   2. Read the accumulated reflections to inject into this run's prompts.
    # ``_resolve_pending_entries`` is the same internal step propagate() calls;
    # we invoke it directly because there is no public resolve-only entry point
    # that preserves our event streaming.
    past_context = ""
    if MEMORY_ENABLED:
        try:
            graph._resolve_pending_entries(req.ticker)
        except Exception as exc:  # noqa: BLE001 - learning loop is non-critical
            yield events.activity("memory", f"Outcome reflection skipped: {exc}")
        try:
            past_context = graph.memory_log.get_past_context(req.ticker) or ""
        except Exception:  # noqa: BLE001
            past_context = ""
        if past_context:
            yield events.activity(
                "memory",
                f"Loaded prior reflections for {req.ticker} to inform this run.",
            )

    instrument_context = graph.resolve_instrument_context(req.ticker, req.asset_type)
    init_state = graph.propagator.create_initial_state(
        req.ticker,
        trade_date,
        asset_type=req.asset_type,
        past_context=past_context,
        instrument_context=instrument_context,
    )
    args = graph.propagator.get_graph_args(callbacks=[stats_handler])

    tracker = _StatusTracker(list(req.analysts))
    # Seed: first selected analyst starts in_progress.
    first_analyst_name = ANALYST_NAME_BY_KEY[req.analysts[0]]
    evt = tracker.set(first_analyst_name, "in_progress")
    if evt:
        yield evt

    # Accumulators for richer debate sections than the CLI's single panel.
    invest = {"bull": "", "bear": "", "judge": ""}
    risk = {"aggressive": "", "conservative": "", "neutral": "", "judge": ""}
    emitted_sections: Dict[str, str] = {}
    processed_message_ids: set[str] = set()
    final_state: Dict[str, Any] = {}
    last_stats_emit = 0.0

    def emit_section(section: str, content: str) -> Optional[Dict[str, Any]]:
        content = (content or "").strip()
        if not content or emitted_sections.get(section) == content:
            return None
        emitted_sections[section] = content
        return events.report_section(section, content)

    try:
        for chunk in graph.graph.stream(init_state, **args):
            final_state.update(chunk)

            # --- Activity: new messages + tool calls ---------------------
            for message in chunk.get("messages", []):
                msg_id = getattr(message, "id", None)
                if msg_id is not None:
                    if msg_id in processed_message_ids:
                        continue
                    processed_message_ids.add(msg_id)

                tool_calls = getattr(message, "tool_calls", None)
                if tool_calls:
                    for tc in tool_calls:
                        name = tc["name"] if isinstance(tc, dict) else getattr(tc, "name", "tool")
                        tc_args = tc["args"] if isinstance(tc, dict) else getattr(tc, "args", {})
                        yield events.tool_call(name, tc_args)
                else:
                    text = _content_to_text(getattr(message, "content", "")).strip()
                    if text:
                        kind = "tool" if message.__class__.__name__ == "ToolMessage" else "message"
                        yield events.activity(kind, text[:_MAX_ACTIVITY_CHARS])

            # --- Analyst statuses from accumulated report state ----------
            found_active = False
            for key in ANALYST_KEYS:
                if key not in req.analysts:
                    continue
                name = ANALYST_NAME_BY_KEY[key]
                report_key = ANALYST_REPORT_BY_KEY[key]
                content = chunk.get(report_key)
                if content:
                    evt = emit_section(report_key, content)
                    if evt:
                        yield evt
                has_report = bool(content)
                if has_report:
                    evt = tracker.set(name, "completed")
                elif not found_active:
                    evt = tracker.set(name, "in_progress")
                    found_active = True
                else:
                    evt = tracker.set(name, "pending")
                if evt:
                    yield evt
            if not found_active and req.analysts:
                evt = tracker.set("Bull Researcher", "in_progress")
                if evt:
                    yield evt

            # --- Research team: investment debate ------------------------
            debate_state = chunk.get("investment_debate_state") or {}
            bull = (debate_state.get("bull_history") or "").strip()
            bear = (debate_state.get("bear_history") or "").strip()
            judge = (debate_state.get("judge_decision") or "").strip()
            if bull or bear:
                for name in _RESEARCH_TEAM:
                    evt = tracker.set(name, "in_progress")
                    if evt:
                        yield evt
            if bull and bull != invest["bull"]:
                invest["bull"] = bull
                yield events.debate_update("research", "bull", bull)
            if bear and bear != invest["bear"]:
                invest["bear"] = bear
                yield events.debate_update("research", "bear", bear)
            if judge and judge != invest["judge"]:
                invest["judge"] = judge
                yield events.debate_update("research", "judge", judge)
                evt = tracker.set("Research Manager", "completed")
                if evt:
                    yield evt
                for name in ("Bull Researcher", "Bear Researcher"):
                    evt = tracker.set(name, "completed")
                    if evt:
                        yield evt
                evt = tracker.set("Trader", "in_progress")
                if evt:
                    yield evt
            if bull or bear or judge:
                evt = emit_section(
                    "investment_plan",
                    _compose(
                        [
                            ("Bull Researcher", invest["bull"]),
                            ("Bear Researcher", invest["bear"]),
                            ("Research Manager Decision", invest["judge"]),
                        ]
                    ),
                )
                if evt:
                    yield evt

            # --- Trading team --------------------------------------------
            trader_plan = (chunk.get("trader_investment_plan") or "").strip()
            if trader_plan:
                evt = emit_section("trader_investment_plan", trader_plan)
                if evt:
                    yield evt
                evt = tracker.set("Trader", "completed")
                if evt:
                    yield evt
                evt = tracker.set("Aggressive Analyst", "in_progress")
                if evt:
                    yield evt

            # --- Risk management debate ----------------------------------
            risk_state = chunk.get("risk_debate_state") or {}
            agg = (risk_state.get("aggressive_history") or "").strip()
            con = (risk_state.get("conservative_history") or "").strip()
            neu = (risk_state.get("neutral_history") or "").strip()
            rjudge = (risk_state.get("judge_decision") or "").strip()
            if agg and agg != risk["aggressive"]:
                risk["aggressive"] = agg
                evt = tracker.set("Aggressive Analyst", "in_progress")
                if evt:
                    yield evt
                yield events.debate_update("risk", "aggressive", agg)
            if con and con != risk["conservative"]:
                risk["conservative"] = con
                evt = tracker.set("Conservative Analyst", "in_progress")
                if evt:
                    yield evt
                yield events.debate_update("risk", "conservative", con)
            if neu and neu != risk["neutral"]:
                risk["neutral"] = neu
                evt = tracker.set("Neutral Analyst", "in_progress")
                if evt:
                    yield evt
                yield events.debate_update("risk", "neutral", neu)
            if rjudge and rjudge != risk["judge"]:
                risk["judge"] = rjudge
                yield events.debate_update("risk", "judge", rjudge)
                for name in (
                    "Aggressive Analyst",
                    "Conservative Analyst",
                    "Neutral Analyst",
                    "Portfolio Manager",
                ):
                    evt = tracker.set(name, "completed")
                    if evt:
                        yield evt
            if agg or con or neu or rjudge:
                evt = emit_section(
                    "final_trade_decision",
                    _compose(
                        [
                            ("Aggressive Analyst", risk["aggressive"]),
                            ("Conservative Analyst", risk["conservative"]),
                            ("Neutral Analyst", risk["neutral"]),
                            ("Portfolio Manager Decision", risk["judge"]),
                        ]
                    ),
                )
                if evt:
                    yield evt

            # --- Periodic stats ------------------------------------------
            now = time.time()
            if now - last_stats_emit > 1.0:
                last_stats_emit = now
                yield events.stats({**stats_handler.get_stats(), "elapsed_seconds": round(now - started, 1)})

        # --- Finalise --------------------------------------------------------
        # Authoritative report fields straight from the merged final state.
        for section in (
            "market_report",
            "sentiment_report",
            "news_report",
            "fundamentals_report",
            "investment_plan",
            "trader_investment_plan",
            "final_trade_decision",
        ):
            value = (final_state.get(section) or "").strip()
            if value:
                evt = emit_section(section, value)
                if evt:
                    yield evt

        for name in list(tracker.status.keys()):
            evt = tracker.set(name, "completed")
            if evt:
                yield evt

        final_decision = final_state.get("final_trade_decision", "")
        signal = graph.process_signal(final_decision) if final_decision else ""

        # Record this decision so a future same-ticker run can resolve its
        # realized outcome and learn from it (best-effort; never fatal). No LLM
        # call here — outcome scoring happens on the next run for this ticker.
        if MEMORY_ENABLED and final_decision:
            try:
                graph.memory_log.store_decision(
                    ticker=req.ticker,
                    trade_date=trade_date,
                    final_trade_decision=final_decision,
                )
            except Exception as exc:  # noqa: BLE001 - persistence is non-critical
                yield events.activity("memory", f"Decision store skipped: {exc}")

        invest_final = final_state.get("investment_debate_state") or {}
        risk_final = final_state.get("risk_debate_state") or {}

        yield events.run_completed(
            decision=final_decision,
            signal=signal,
            report={
                "market_report": final_state.get("market_report", ""),
                "sentiment_report": final_state.get("sentiment_report", ""),
                "news_report": final_state.get("news_report", ""),
                "fundamentals_report": final_state.get("fundamentals_report", ""),
                "investment_plan": final_state.get("investment_plan", ""),
                "trader_investment_plan": final_state.get("trader_investment_plan", ""),
                "final_trade_decision": final_decision,
            },
            debates={
                "research": {
                    "bull": invest_final.get("bull_history", ""),
                    "bear": invest_final.get("bear_history", ""),
                    "judge": invest_final.get("judge_decision", ""),
                },
                "risk": {
                    "aggressive": risk_final.get("aggressive_history", ""),
                    "conservative": risk_final.get("conservative_history", ""),
                    "neutral": risk_final.get("neutral_history", ""),
                    "judge": risk_final.get("judge_decision", ""),
                },
            },
            stats_payload=stats_handler.get_stats(),
            elapsed_seconds=time.time() - started,
        )
    except Exception as exc:  # noqa: BLE001 - surface any failure to the client
        yield events.error(str(exc), where="run_analysis")
