"""Canned analysis stream — no LLM calls, no API keys.

Emits the exact same event vocabulary as ``runner.py`` so the Chloei frontend
(and CI) can exercise the full streaming pipeline deterministically. Enabled
per-request (``mock: true``) or globally via ``TRADINGAGENTS_MOCK=1``.
"""

from __future__ import annotations

import time
import uuid
from typing import Any, Dict, Iterator

from . import events
from .roster import ANALYST_NAME_BY_KEY, ANALYST_REPORT_BY_KEY, DEPTH_PRESETS, TEAMS
from .schemas import AnalyzeRequest

_STEP = 0.35  # seconds between steps, for a lifelike stream


def _md_report(ticker: str, kind: str) -> str:
    bodies = {
        "market_report": (
            f"**{ticker} — Technical picture.** Price is trading above its 50-day "
            "moving average with the 50-day above the 200-day (a golden-cross "
            "posture). RSI(14) sits near 61 — firm momentum without being "
            "stretched. MACD histogram is positive and widening.\n\n"
            "| Indicator | Reading | Bias |\n| --- | --- | --- |\n"
            "| 50 / 200 SMA | Bullish stack | Positive |\n"
            "| RSI(14) | 61 | Neutral-bullish |\n"
            "| MACD | Positive cross | Positive |\n"
            "| ATR(14) | Elevated | Watch volatility |"
        ),
        "sentiment_report": (
            f"**Social sentiment for {ticker}.** Aggregated retail chatter skews "
            "net-positive (~68% bullish) over the trailing week, though volume of "
            "mentions is cooling from last month's spike. No coordinated negative "
            "campaigns detected. Influencer tone is constructive but increasingly "
            "valuation-aware."
        ),
        "news_report": (
            f"**News & macro for {ticker}.** Recent coverage centers on a product "
            "refresh cycle and resilient enterprise demand. Macro backdrop is "
            "mixed: steady labor data offset by sticky services inflation keeping "
            "rate-cut timing uncertain. No material litigation or regulatory "
            "overhangs in the window."
        ),
        "fundamentals_report": (
            f"**Fundamentals for {ticker}.** Revenue grew ~18% YoY with gross "
            "margin expansion of ~120bps. Free cash flow conversion remains "
            "strong; net cash balance sheet. Forward P/E sits modestly above the "
            "5-year median, pricing in continued execution.\n\n"
            "- Revenue (YoY): **+18%**\n- Gross margin: **+120bps**\n"
            "- FCF margin: **~27%**\n- Net debt: **negative (net cash)**"
        ),
    }
    return bodies.get(kind, f"{kind} for {ticker}.")


def mock_analysis(req: AnalyzeRequest) -> Iterator[Dict[str, Any]]:
    started = time.time()
    run_id = uuid.uuid4().hex
    trade_date = req.trade_date or time.strftime("%Y-%m-%d", time.gmtime())
    rounds = DEPTH_PRESETS[req.depth]
    ticker = req.ticker

    yield events.run_started(
        run_id=run_id,
        ticker=ticker,
        trade_date=trade_date,
        asset_type=req.asset_type,
        analysts=req.analysts,
        teams=TEAMS,
        llm={
            "provider": "mock",
            "deep_think_llm": "mock-deep",
            "quick_think_llm": "mock-quick",
            "backend_url": None,
        },
        mock=True,
    )

    llm_calls = 0
    tool_calls = 0

    def stats_event() -> Dict[str, Any]:
        return events.stats(
            {
                "llm_calls": llm_calls,
                "tool_calls": tool_calls,
                "tokens_in": llm_calls * 1800,
                "tokens_out": llm_calls * 540,
                "elapsed_seconds": round(time.time() - started, 1),
            }
        )

    # --- Analyst team ---------------------------------------------------------
    for key in req.analysts:
        name = ANALYST_NAME_BY_KEY[key]
        report_key = ANALYST_REPORT_BY_KEY[key]
        yield events.agent_status(name, "in_progress")
        time.sleep(_STEP)
        tool_calls += 1
        yield events.tool_call(
            {"market": "get_stock_data", "social": "get_news", "news": "get_global_news", "fundamentals": "get_fundamentals"}.get(key, "get_data"),
            {"ticker": ticker, "date": trade_date},
            agent=name,
        )
        llm_calls += 1
        time.sleep(_STEP)
        yield events.report_section(report_key, _md_report(ticker, report_key))
        yield events.agent_status(name, "completed")
        yield stats_event()

    # --- Research team: bull vs bear ------------------------------------------
    for n in ("Bull Researcher", "Bear Researcher", "Research Manager"):
        yield events.agent_status(n, "in_progress")
    bull = (
        f"The setup for {ticker} is constructive: bullish technical stack, "
        "accelerating fundamentals, and net-positive sentiment. The valuation "
        "premium is justified by margin expansion and durable demand."
    )
    bear = (
        f"Caution on {ticker}: the valuation prices in flawless execution, "
        "sentiment is cooling off its highs, and a higher-for-longer rate path "
        "compresses multiples. Momentum can unwind quickly."
    )
    rjudge = (
        f"On balance the bull case is better supported for {ticker}. The "
        "fundamental trajectory and technical posture outweigh valuation risk at "
        "this horizon. Proceed, but size for volatility."
    )
    llm_calls += 1
    time.sleep(_STEP)
    yield events.debate_update("research", "bull", bull)
    yield events.report_section("investment_plan", f"### Bull Researcher\n\n{bull}")
    llm_calls += 1
    time.sleep(_STEP)
    yield events.debate_update("research", "bear", bear)
    yield events.report_section(
        "investment_plan", f"### Bull Researcher\n\n{bull}\n\n### Bear Researcher\n\n{bear}"
    )
    llm_calls += 1
    time.sleep(_STEP)
    yield events.debate_update("research", "judge", rjudge)
    yield events.report_section(
        "investment_plan",
        f"### Bull Researcher\n\n{bull}\n\n### Bear Researcher\n\n{bear}\n\n"
        f"### Research Manager Decision\n\n{rjudge}",
    )
    for n in ("Bull Researcher", "Bear Researcher", "Research Manager"):
        yield events.agent_status(n, "completed")
    yield stats_event()

    # --- Trading team ---------------------------------------------------------
    yield events.agent_status("Trader", "in_progress")
    time.sleep(_STEP)
    llm_calls += 1
    trader_plan = (
        f"**Proposed trade — {ticker}.** Establish a starter long position "
        "(~1/3 target size) here, adding on a pullback toward the 50-day. Stop "
        "below the recent swing low; first target at prior highs. Risk/reward "
        "favorable given the trend and catalyst path."
    )
    yield events.report_section("trader_investment_plan", trader_plan)
    yield events.agent_status("Trader", "completed")
    yield stats_event()

    # --- Risk management ------------------------------------------------------
    agg = f"Aggressive: lean in — the trend is your friend and {ticker} has room to run. Favor full size."
    con = f"Conservative: respect the valuation premium and macro uncertainty for {ticker}. Half size, tight stop."
    neu = f"Neutral: a scaled entry balances upside capture against drawdown risk on {ticker}."
    pm = (
        f"**Final call on {ticker}: BUY (Overweight tilt).** Initiate on a scaled "
        "basis with a defined stop. The weight of evidence — trend, fundamentals, "
        "sentiment — supports a long, while position sizing respects the "
        "conservative risk flags."
    )
    yield events.agent_status("Aggressive Analyst", "in_progress")
    time.sleep(_STEP)
    llm_calls += 1
    yield events.debate_update("risk", "aggressive", agg)
    yield events.agent_status("Conservative Analyst", "in_progress")
    time.sleep(_STEP)
    llm_calls += 1
    yield events.debate_update("risk", "conservative", con)
    yield events.agent_status("Neutral Analyst", "in_progress")
    time.sleep(_STEP)
    llm_calls += 1
    yield events.debate_update("risk", "neutral", neu)
    yield events.agent_status("Portfolio Manager", "in_progress")
    time.sleep(_STEP)
    llm_calls += 1
    yield events.debate_update("risk", "judge", pm)
    final_decision = (
        f"### Aggressive Analyst\n\n{agg}\n\n### Conservative Analyst\n\n{con}\n\n"
        f"### Neutral Analyst\n\n{neu}\n\n### Portfolio Manager Decision\n\n{pm}"
    )
    yield events.report_section("final_trade_decision", final_decision)
    for n in ("Aggressive Analyst", "Conservative Analyst", "Neutral Analyst", "Portfolio Manager"):
        yield events.agent_status(n, "completed")
    yield stats_event()

    time.sleep(_STEP)
    yield events.run_completed(
        decision=pm,
        signal="Buy",
        report={
            "market_report": _md_report(ticker, "market_report") if "market" in req.analysts else "",
            "sentiment_report": _md_report(ticker, "sentiment_report") if "social" in req.analysts else "",
            "news_report": _md_report(ticker, "news_report") if "news" in req.analysts else "",
            "fundamentals_report": _md_report(ticker, "fundamentals_report") if "fundamentals" in req.analysts else "",
            "investment_plan": f"### Bull Researcher\n\n{bull}\n\n### Bear Researcher\n\n{bear}\n\n### Research Manager Decision\n\n{rjudge}",
            "trader_investment_plan": trader_plan,
            "final_trade_decision": final_decision,
        },
        debates={
            "research": {"bull": bull, "bear": bear, "judge": rjudge},
            "risk": {"aggressive": agg, "conservative": con, "neutral": neu, "judge": pm},
        },
        stats_payload={
            "llm_calls": llm_calls,
            "tool_calls": tool_calls,
            "tokens_in": llm_calls * 1800,
            "tokens_out": llm_calls * 540,
        },
        elapsed_seconds=time.time() - started,
    )
