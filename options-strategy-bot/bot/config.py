from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class RiskConfig:
    max_risk_per_trade_mxn: float = 1000.0
    max_open_positions: int = 5
    max_daily_candidates: int = 10
    max_symbol_weight: float = 0.25


@dataclass(frozen=True)
class StrategyConfig:
    enabled: tuple[str, ...] = ("bull_call_debit_spread", "bear_put_debit_spread")
    dte: int = 45
    hold_days: int = 10
    min_score_to_enter: float = 75.0
    target_reward_risk: float = 1.5
    prefer_medium_volatility: bool = True
    allow_extended_moves: bool = False


@dataclass(frozen=True)
class CostConfig:
    slippage_bps: float = 75.0
    commission_per_contract_usd: float = 0.65


@dataclass(frozen=True)
class BotConfig:
    bot_name: str
    initial_equity_mxn: float
    usd_mxn: float
    universe: tuple[str, ...]
    market_symbols: dict[str, str]
    risk: RiskConfig
    strategy: StrategyConfig
    costs: CostConfig


def _symbol_tuple(value: Any, fallback: tuple[str, ...]) -> tuple[str, ...]:
    if isinstance(value, list):
        return tuple(str(item).upper() for item in value if str(item).strip())
    return fallback


def _strategy_tuple(value: Any, fallback: tuple[str, ...]) -> tuple[str, ...]:
    if isinstance(value, list):
        return tuple(str(item).strip().lower() for item in value if str(item).strip())
    return fallback


def load_config(path: str | Path) -> BotConfig:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    risk = raw.get("risk", {})
    strategy = raw.get("strategy", {})
    costs = raw.get("costs", {})

    return BotConfig(
        bot_name=str(raw.get("bot_name", "Options Strategy Research Bot")),
        initial_equity_mxn=float(raw.get("initial_equity_mxn", 100000)),
        usd_mxn=float(raw.get("usd_mxn", 17)),
        universe=_symbol_tuple(raw.get("universe"), ("AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META")),
        market_symbols={str(k): str(v).upper() for k, v in raw.get("market_symbols", {}).items()},
        risk=RiskConfig(
            max_risk_per_trade_mxn=float(risk.get("max_risk_per_trade_mxn", 1000)),
            max_open_positions=int(risk.get("max_open_positions", 5)),
            max_daily_candidates=int(risk.get("max_daily_candidates", 10)),
            max_symbol_weight=float(risk.get("max_symbol_weight", 0.25))
        ),
        strategy=StrategyConfig(
            enabled=_strategy_tuple(strategy.get("enabled"), ("bull_call_debit_spread", "bear_put_debit_spread")),
            dte=int(strategy.get("dte", 45)),
            hold_days=int(strategy.get("hold_days", 10)),
            min_score_to_enter=float(strategy.get("min_score_to_enter", 75)),
            target_reward_risk=float(strategy.get("target_reward_risk", 1.5)),
            prefer_medium_volatility=bool(strategy.get("prefer_medium_volatility", True)),
            allow_extended_moves=bool(strategy.get("allow_extended_moves", False))
        ),
        costs=CostConfig(
            slippage_bps=float(costs.get("slippage_bps", 75)),
            commission_per_contract_usd=float(costs.get("commission_per_contract_usd", 0.65))
        )
    )
