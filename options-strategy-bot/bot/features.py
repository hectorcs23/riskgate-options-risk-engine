from __future__ import annotations

from dataclasses import dataclass
import math
from statistics import mean, stdev

from .data import Bar


@dataclass(frozen=True)
class TechnicalFeatures:
    trend: str
    price_vs_20ma: str
    price_vs_50ma: str
    rsi_condition: str
    volume_condition: str
    support_resistance_quality: str
    realized_vol_20: float | None
    day_change_percent: float | None
    volume_ratio: float | None
    rsi_14: float | None
    close: float


@dataclass(frozen=True)
class MarketRegime:
    spy_trend: str = "neutral"
    qqq_trend: str = "neutral"
    vix_condition: str = "normal"
    breadth: str = "neutral"
    macro_risk: str = "medium"


def sma(values: list[float], length: int) -> float | None:
    if len(values) < length:
        return None
    return mean(values[-length:])


def rsi(values: list[float], length: int = 14) -> float | None:
    if len(values) <= length:
        return None
    gains = 0.0
    losses = 0.0
    window = values[-(length + 1):]
    for idx in range(1, len(window)):
        diff = window[idx] - window[idx - 1]
        if diff >= 0:
            gains += diff
        else:
            losses += abs(diff)
    average_gain = gains / length
    average_loss = losses / length
    if average_loss == 0:
        return 100.0
    rs = average_gain / average_loss
    return 100 - 100 / (1 + rs)


def realized_volatility(closes: list[float], length: int = 20) -> float | None:
    if len(closes) <= length:
        return None
    returns: list[float] = []
    for idx in range(len(closes) - length, len(closes)):
        previous = closes[idx - 1]
        if previous > 0:
            returns.append((closes[idx] - previous) / previous)
    if len(returns) < 2:
        return None
    return stdev(returns) * math.sqrt(252) * 100


def technical_features(bars: list[Bar]) -> TechnicalFeatures | None:
    if len(bars) < 55:
        return None
    closes = [bar.close for bar in bars]
    volumes = [bar.volume for bar in bars]
    last = closes[-1]
    previous = closes[-2] if len(closes) >= 2 else last
    sma20 = sma(closes, 20)
    sma50 = sma(closes, 50)
    rsi14 = rsi(closes, 14)
    avg_volume20 = sma(volumes, 20)
    twenty_back = closes[-21] if len(closes) >= 21 else last
    twenty_day_change = ((last - twenty_back) / twenty_back) * 100 if twenty_back else 0

    trend = "sideways"
    if sma20 and sma50:
        if last > sma20 > sma50 and twenty_day_change > 2:
            trend = "uptrend"
        elif last < sma20 < sma50 and twenty_day_change < -2:
            trend = "downtrend"

    rsi_condition = "neutral"
    if rsi14 is not None and rsi14 < 35:
        rsi_condition = "oversold"
    elif rsi14 is not None and rsi14 > 70:
        rsi_condition = "overbought"

    volume_ratio = volumes[-1] / avg_volume20 if avg_volume20 else None
    volume_condition = "normal"
    if volume_ratio is not None and volume_ratio > 1.25:
        volume_condition = "strong"
    elif volume_ratio is not None and volume_ratio < 0.7:
        volume_condition = "weak"

    support_quality = "average"
    if sma20 and sma50:
        distance_20 = abs((last - sma20) / last)
        distance_50 = abs((last - sma50) / last)
        if distance_20 <= 0.02 or distance_50 <= 0.03:
            support_quality = "good"
        elif distance_20 > 0.08 and distance_50 > 0.1:
            support_quality = "poor"

    return TechnicalFeatures(
        trend=trend,
        price_vs_20ma="above" if sma20 and last >= sma20 else "below",
        price_vs_50ma="above" if sma50 and last >= sma50 else "below",
        rsi_condition=rsi_condition,
        volume_condition=volume_condition,
        support_resistance_quality=support_quality,
        realized_vol_20=realized_volatility(closes, 20),
        day_change_percent=((last - previous) / previous) * 100 if previous else None,
        volume_ratio=volume_ratio,
        rsi_14=rsi14,
        close=last
    )


def trend_from_bars(bars: list[Bar]) -> str:
    features = technical_features(bars)
    if not features:
        return "neutral"
    if features.trend == "uptrend":
        return "bullish"
    if features.trend == "downtrend":
        return "bearish"
    return "neutral"


def vix_condition(bars: list[Bar]) -> str:
    if not bars:
        return "normal"
    last = bars[-1].close
    previous = bars[-2].close if len(bars) > 1 else last
    daily_change = ((last - previous) / previous) * 100 if previous else 0
    if last >= 30 or daily_change >= 15:
        return "spiking"
    if last >= 22:
        return "elevated"
    if last <= 15:
        return "low"
    return "normal"


def build_market_regime(spy: list[Bar], qqq: list[Bar], vix: list[Bar], breadth_histories: list[list[Bar]]) -> MarketRegime:
    spy_trend = trend_from_bars(spy)
    qqq_trend = trend_from_bars(qqq)
    vix_state = vix_condition(vix)
    above = 0
    total = 0
    for bars in breadth_histories:
        closes = [bar.close for bar in bars]
        ma50 = sma(closes, 50)
        if closes and ma50:
            above += 1 if closes[-1] >= ma50 else 0
            total += 1
    breadth_ratio = above / total if total else 0.5
    breadth = "strong" if breadth_ratio >= 0.65 else "weak" if breadth_ratio <= 0.4 else "neutral"
    macro = "high" if vix_state == "spiking" else "low" if vix_state == "low" and breadth == "strong" else "medium"
    return MarketRegime(spy_trend, qqq_trend, vix_state, breadth, macro)
