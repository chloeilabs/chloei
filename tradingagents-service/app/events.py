"""Event envelope helpers shared by the real runner and the mock runner.

Every streamed item is a plain dict with a ``type`` discriminator. The HTTP
layer serialises each as one SSE ``data:`` frame; the Chloei proxy re-emits
them as NDJSON. Keeping construction here guarantees the two runners stay in
lockstep and the TypeScript event types only have one shape to mirror.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

from .roster import report_section_meta, team_for_agent


def sse(event: Dict[str, Any]) -> str:
    """Serialise an event dict as a single SSE frame."""
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


def run_started(
    *,
    run_id: str,
    ticker: str,
    trade_date: str,
    asset_type: str,
    analysts: List[str],
    teams: List[Dict[str, Any]],
    llm: Dict[str, Any],
    mock: bool,
) -> Dict[str, Any]:
    return {
        "type": "run_started",
        "run_id": run_id,
        "ticker": ticker,
        "trade_date": trade_date,
        "asset_type": asset_type,
        "analysts": analysts,
        "teams": teams,
        "llm": llm,
        "mock": mock,
    }


def agent_status(name: str, status: str) -> Dict[str, Any]:
    team = team_for_agent(name)
    return {
        "type": "agent_status",
        "agent": name,
        "status": status,
        "team": team["team"],
        "team_label": team["team_label"],
    }


def report_section(section: str, content: str) -> Dict[str, Any]:
    meta = report_section_meta(section)
    return {
        "type": "report_section",
        "section": section,
        "title": meta["title"],
        "team": meta["team"],
        "content": content,
    }


def debate_update(debate: str, role: str, content: str) -> Dict[str, Any]:
    return {
        "type": "debate_update",
        "debate": debate,  # "research" | "risk"
        "role": role,  # bull|bear|judge | aggressive|conservative|neutral|judge
        "content": content,
    }


def tool_call(tool: str, args: Any, agent: Optional[str] = None) -> Dict[str, Any]:
    return {"type": "tool_call", "tool": tool, "args": args, "agent": agent}


def activity(kind: str, content: str, agent: Optional[str] = None) -> Dict[str, Any]:
    return {"type": "activity", "kind": kind, "content": content, "agent": agent}


def stats(payload: Dict[str, Any]) -> Dict[str, Any]:
    return {"type": "stats", **payload}


def run_completed(
    *,
    decision: str,
    signal: str,
    report: Dict[str, Any],
    debates: Dict[str, Any],
    stats_payload: Dict[str, Any],
    elapsed_seconds: float,
) -> Dict[str, Any]:
    return {
        "type": "run_completed",
        "decision": decision,
        "signal": signal,
        "report": report,
        "debates": debates,
        "stats": stats_payload,
        "elapsed_seconds": round(elapsed_seconds, 2),
    }


def error(message: str, where: Optional[str] = None) -> Dict[str, Any]:
    return {"type": "error", "message": message, "where": where}
