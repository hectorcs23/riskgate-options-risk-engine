from __future__ import annotations

from dataclasses import dataclass

from .features import MarketRegime, TechnicalFeatures
from .options import OptionStructure


@dataclass(frozen=True)
class ScoreResult:
    market_score: float
    technical_score: float
    options_score: float
    trade_score: float
    total_score: float
    decision: str
    suggested_risk_mxn: float
    reasons: tuple[str, ...]
    warnings: tuple[str, ...]


def clamp(value: float, low: float = 0, high: float = 100) -> float:
    return min(high, max(low, value))


def score_market(regime: MarketRegime, direction: str) -> float:
    score = 50
    if regime.spy_trend == "bullish":
        score += 15 if direction == "bullish" else -10
    if regime.spy_trend == "bearish":
        score += 15 if direction == "bearish" else -15
    if regime.qqq_trend == "bullish":
        score += 12 if direction == "bullish" else -8
    if regime.qqq_trend == "bearish":
        score += 12 if direction == "bearish" else -8
    if regime.breadth == "strong":
        score += 10 if direction == "bullish" else -6
    if regime.breadth == "weak":
        score += 10 if direction == "bearish" else -6
    if regime.vix_condition == "elevated":
        score -= 8 if direction == "bullish" else -2
    if regime.vix_condition == "spiking":
        score -= 25 if direction == "bullish" else -5
    if regime.macro_risk == "high":
        score -= 12 if direction == "bullish" else -2
    return clamp(score)


def score_technical(features: TechnicalFeatures, direction: str) -> float:
    score = 50
    if features.trend == "uptrend":
        score += 18 if direction == "bullish" else -15
    if features.trend == "downtrend":
        score += 18 if direction == "bearish" else -15
    if features.price_vs_20ma == "above":
        score += 8 if direction == "bullish" else -6
    if features.price_vs_50ma == "above":
        score += 10 if direction == "bullish" else -8
    if features.rsi_condition == "neutral":
        score += 8
    if features.rsi_condition == "overbought":
        score += 8 if direction == "bearish" else -12
    if features.rsi_condition == "oversold":
        score += 8 if direction == "bullish" else -8
    if features.volume_condition == "strong":
        score += 6
    if features.volume_condition == "weak":
        score -= 8
    if features.support_resistance_quality == "good":
        score += 10
    if features.support_resistance_quality == "poor":
        score -= 15
    day_move = abs(features.day_change_percent or 0)
    if day_move >= 10:
        score -= 35
    elif day_move >= 7:
        score -= 24
    elif day_move >= 5:
        score -= 14
    return clamp(score)


def score_options(structure: OptionStructure) -> float:
    spread = 100 if structure.spread_percent <= 8 else 75 if structure.spread_percent <= 12 else 42 if structure.spread_percent <= 18 else 0
    dte = 100 if 21 <= structure.dte <= 60 else 60 if 14 <= structure.dte <= 90 else 10
    iv = 100 - abs(structure.implied_vol - 0.42) * 85
    theta_ratio = abs(structure.net_theta) / max(structure.net_debit_usd, 0.01)
    theta = 100 if theta_ratio <= 0.025 else 80 if theta_ratio <= 0.05 else 45 if theta_ratio <= 0.08 else 10
    delta = 100 - abs(abs(structure.net_delta) - 0.28) * 220
    reward = min(structure.reward_risk / 2.0 * 100, 100)
    return clamp(0.18 * spread + 0.14 * dte + 0.14 * iv + 0.16 * theta + 0.18 * delta + 0.2 * reward)


def score_trade(features: TechnicalFeatures, structure: OptionStructure, allow_extended_moves: bool) -> tuple[float, list[str]]:
    warnings: list[str] = []
    score = 75
    if structure.reward_risk >= 1.5:
        score += 12
    else:
        score -= 18
    if features.support_resistance_quality == "good":
        score += 8
    if abs(features.day_change_percent or 0) >= 5 and not allow_extended_moves:
        score -= 25
        warnings.append("Extended daily move; avoid chasing high-IV entries.")
    if features.realized_vol_20 is not None and features.realized_vol_20 > 75:
        score -= 20
        warnings.append("Realized volatility is too high for stable defined-risk entries.")
    return clamp(score), warnings


def decision(total: float, warnings: list[str]) -> str:
    if warnings and total >= 75:
        return "watchlist"
    if total < 60:
        return "reject"
    if total < 75:
        return "watchlist"
    if total < 85:
        return "paper_small"
    return "paper_normal"


def evaluate_candidate(
    regime: MarketRegime,
    features: TechnicalFeatures,
    structure: OptionStructure,
    max_risk_mxn: float,
    allow_extended_moves: bool
) -> ScoreResult:
    market = score_market(regime, structure.direction)
    technical = score_technical(features, structure.direction)
    options = score_options(structure)
    trade, warnings = score_trade(features, structure, allow_extended_moves)
    total = round(0.30 * market + 0.30 * technical + 0.25 * options + 0.15 * trade, 1)
    if structure.max_loss_mxn > max_risk_mxn:
        warnings.append("Max loss exceeds configured risk cap.")
    if structure.spread_percent > 18:
        warnings.append("Estimated bid/ask cost is wide.")
    if structure.implied_vol > 0.85:
        warnings.append("Implied-vol proxy is high.")
    final_decision = decision(total, warnings)
    suggested_risk = 0 if final_decision in {"reject", "watchlist"} else min(max_risk_mxn, structure.max_loss_mxn)
    return ScoreResult(
        market, technical, options, trade, total, final_decision, suggested_risk,
        (
            f"Weighted score {total}/100.",
            f"Market {market:.0f}, technical {technical:.0f}, options {options:.0f}, trade {trade:.0f}.",
            f"Max loss {structure.max_loss_mxn:.0f} MXN, max profit {structure.max_profit_mxn:.0f} MXN, R/R {structure.reward_risk:.2f}x."
        ),
        tuple(warnings)
    )
