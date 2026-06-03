"""Canonical agent roster, report-section, and depth metadata.

This is the single source of truth shared by the runner (which emits status
and report events) and the ``/config`` endpoint (which the Chloei frontend
reads to render its pipeline and form). The display names here MUST match the
names used in ``runner.py`` status transitions, which in turn mirror the
upstream TradingAgents CLI so the streaming semantics stay faithful.
"""

from __future__ import annotations

from typing import Any, Dict, List

# Teams in pipeline order. ``key`` is the selectable analyst key (only the
# analyst team is user-selectable); ``name`` is the canonical display name used
# in agent_status events.
TEAMS: List[Dict[str, Any]] = [
    {
        "id": "analysts",
        "label": "Analyst Team",
        "agents": [
            {"key": "market", "name": "Market Analyst", "selectable": True},
            {"key": "social", "name": "Sentiment Analyst", "selectable": True},
            {"key": "news", "name": "News Analyst", "selectable": True},
            {"key": "fundamentals", "name": "Fundamentals Analyst", "selectable": True},
        ],
    },
    {
        "id": "research",
        "label": "Research Team",
        "agents": [
            {"key": "bull", "name": "Bull Researcher", "selectable": False},
            {"key": "bear", "name": "Bear Researcher", "selectable": False},
            {"key": "research_manager", "name": "Research Manager", "selectable": False},
        ],
    },
    {
        "id": "trading",
        "label": "Trading Team",
        "agents": [
            {"key": "trader", "name": "Trader", "selectable": False},
        ],
    },
    {
        "id": "risk",
        "label": "Risk Management",
        "agents": [
            {"key": "aggressive", "name": "Aggressive Analyst", "selectable": False},
            {"key": "conservative", "name": "Conservative Analyst", "selectable": False},
            {"key": "neutral", "name": "Neutral Analyst", "selectable": False},
        ],
    },
    {
        "id": "portfolio",
        "label": "Portfolio Management",
        "agents": [
            {"key": "portfolio_manager", "name": "Portfolio Manager", "selectable": False},
        ],
    },
]

# Flat list of {name, team, team_label} for quick lookup by display name.
AGENT_TEAM_BY_NAME: Dict[str, Dict[str, str]] = {
    agent["name"]: {"team": team["id"], "team_label": team["label"]}
    for team in TEAMS
    for agent in team["agents"]
}

# Selectable analyst keys -> display name, in canonical order.
ANALYST_KEYS: List[str] = [
    agent["key"]
    for team in TEAMS
    if team["id"] == "analysts"
    for agent in team["agents"]
]
ANALYST_NAME_BY_KEY: Dict[str, str] = {
    agent["key"]: agent["name"]
    for team in TEAMS
    if team["id"] == "analysts"
    for agent in team["agents"]
}
ANALYST_REPORT_BY_KEY: Dict[str, str] = {
    "market": "market_report",
    "social": "sentiment_report",
    "news": "news_report",
    "fundamentals": "fundamentals_report",
}

# Report sections: section key -> {title, team, finalizing_agent}. ``team`` lets
# the frontend slot each section under the right group; ``finalizing_agent`` is
# the agent whose completion finalizes the section (mirrors the upstream CLI).
REPORT_SECTIONS: Dict[str, Dict[str, str]] = {
    "market_report": {"title": "Market Analysis", "team": "analysts", "finalizing_agent": "Market Analyst"},
    "sentiment_report": {"title": "Social Sentiment", "team": "analysts", "finalizing_agent": "Sentiment Analyst"},
    "news_report": {"title": "News Analysis", "team": "analysts", "finalizing_agent": "News Analyst"},
    "fundamentals_report": {"title": "Fundamentals Analysis", "team": "analysts", "finalizing_agent": "Fundamentals Analyst"},
    "investment_plan": {"title": "Research Team Decision", "team": "research", "finalizing_agent": "Research Manager"},
    "trader_investment_plan": {"title": "Trading Plan", "team": "trading", "finalizing_agent": "Trader"},
    "final_trade_decision": {"title": "Portfolio Decision", "team": "portfolio", "finalizing_agent": "Portfolio Manager"},
}

# Research-depth presets -> debate/risk discussion rounds. Higher = more
# back-and-forth between bull/bear and risk debators (more LLM calls, slower).
DEPTH_PRESETS: Dict[str, Dict[str, int]] = {
    "shallow": {"max_debate_rounds": 1, "max_risk_discuss_rounds": 1},
    "medium": {"max_debate_rounds": 2, "max_risk_discuss_rounds": 2},
    "deep": {"max_debate_rounds": 3, "max_risk_discuss_rounds": 3},
}
DEFAULT_DEPTH = "shallow"

# The five-tier signal scale TradingAgents resolves the final decision into.
SIGNALS: List[str] = ["Buy", "Overweight", "Hold", "Underweight", "Sell"]


def report_section_meta(section: str) -> Dict[str, str]:
    """Return {title, team} for a report section, with safe fallbacks."""
    meta = REPORT_SECTIONS.get(section)
    if meta:
        return {"title": meta["title"], "team": meta["team"]}
    return {"title": section.replace("_", " ").title(), "team": "analysts"}


def team_for_agent(name: str) -> Dict[str, str]:
    """Return {team, team_label} for an agent display name, with fallbacks."""
    return AGENT_TEAM_BY_NAME.get(name, {"team": "analysts", "team_label": "Analyst Team"})
