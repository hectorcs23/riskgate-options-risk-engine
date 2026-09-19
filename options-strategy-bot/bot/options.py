from __future__ import annotations

from dataclasses import dataclass
import math


@dataclass(frozen=True)
class OptionLeg:
    action: str
    option_type: str
    strike: float
    dte: int
    price: float
    delta: float
    gamma: float
    theta: float
    vega: float


@dataclass(frozen=True)
class OptionStructure:
    strategy: str
    direction: str
    legs: tuple[OptionLeg, ...]
    net_debit_usd: float
    max_loss_mxn: float
    max_profit_mxn: float
    reward_risk: float
    break_even: float
    net_delta: float
    net_gamma: float
    net_theta: float
    net_vega: float
    spread_percent: float
    implied_vol: float
    dte: int


def _norm_pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / math.sqrt(2 * math.pi)


def _norm_cdf(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def black_scholes(spot: float, strike: float, dte: int, iv: float, option_type: str, rate: float = 0.04) -> tuple[float, float, float, float, float]:
    t = max(dte, 1) / 365
    vol = max(iv, 0.01)
    d1 = (math.log(spot / strike) + (rate + 0.5 * vol * vol) * t) / (vol * math.sqrt(t))
    d2 = d1 - vol * math.sqrt(t)
    if option_type == "call":
        price = spot * _norm_cdf(d1) - strike * math.exp(-rate * t) * _norm_cdf(d2)
        delta = _norm_cdf(d1)
        theta = (
            -(spot * _norm_pdf(d1) * vol) / (2 * math.sqrt(t))
            - rate * strike * math.exp(-rate * t) * _norm_cdf(d2)
        ) / 365
    else:
        price = strike * math.exp(-rate * t) * _norm_cdf(-d2) - spot * _norm_cdf(-d1)
        delta = _norm_cdf(d1) - 1
        theta = (
            -(spot * _norm_pdf(d1) * vol) / (2 * math.sqrt(t))
            + rate * strike * math.exp(-rate * t) * _norm_cdf(-d2)
        ) / 365
    gamma = _norm_pdf(d1) / (spot * vol * math.sqrt(t))
    vega = spot * _norm_pdf(d1) * math.sqrt(t) / 100
    return max(price, 0.01), delta, gamma, theta, vega


def iv_proxy(realized_vol_20: float | None) -> float:
    if realized_vol_20 is None:
        return 0.38
    return min(max(realized_vol_20 / 100 * 1.15, 0.18), 0.85)


def make_debit_spread(strategy: str, spot: float, dte: int, iv: float, usd_mxn: float, slippage_bps: float) -> OptionStructure:
    if strategy == "bull_call_debit_spread":
        option_type = "call"
        direction = "bullish"
        long_strike = round(spot * 1.00, 2)
        short_strike = round(spot * 1.025, 2)
    elif strategy == "bear_put_debit_spread":
        option_type = "put"
        direction = "bearish"
        long_strike = round(spot * 1.00, 2)
        short_strike = round(spot * 0.975, 2)
    elif strategy == "long_call_proxy":
        option_type = "call"
        direction = "bullish"
        long_strike = round(spot * 1.02, 2)
        short_strike = 0
    elif strategy == "long_put_proxy":
        option_type = "put"
        direction = "bearish"
        long_strike = round(spot * 0.98, 2)
        short_strike = 0
    else:
        raise ValueError(f"Unsupported strategy: {strategy}")

    long_price, long_delta, long_gamma, long_theta, long_vega = black_scholes(spot, long_strike, dte, iv, option_type)
    slip = 1 + slippage_bps / 10000
    long_leg = OptionLeg("buy", option_type, long_strike, dte, long_price * slip, long_delta, long_gamma, long_theta, long_vega)

    if short_strike == 0:
        net_debit = long_leg.price
        max_loss_mxn = net_debit * 100 * usd_mxn
        max_profit_mxn = max_loss_mxn * 2.5
        reward_risk = max_profit_mxn / max_loss_mxn
        break_even = long_strike + net_debit if option_type == "call" else long_strike - net_debit
        return OptionStructure(
            strategy, direction, (long_leg,), net_debit, max_loss_mxn, max_profit_mxn, reward_risk, break_even,
            long_delta, long_gamma, long_theta, long_vega, 8.0, iv, dte
        )

    short_price, short_delta, short_gamma, short_theta, short_vega = black_scholes(spot, short_strike, dte, iv, option_type)
    short_leg = OptionLeg("sell", option_type, short_strike, dte, short_price / slip, short_delta, short_gamma, short_theta, short_vega)
    net_debit = max(long_leg.price - short_leg.price, 0.01)
    width = abs(short_strike - long_strike)
    max_loss_mxn = net_debit * 100 * usd_mxn
    max_profit_mxn = max(width - net_debit, 0.01) * 100 * usd_mxn
    reward_risk = max_profit_mxn / max_loss_mxn
    break_even = long_strike + net_debit if option_type == "call" else long_strike - net_debit
    spread_percent = min(max((slippage_bps / 100) + abs(long_leg.price - short_leg.price) / max(net_debit, 0.01), 4), 25)
    return OptionStructure(
        strategy=strategy,
        direction=direction,
        legs=(long_leg, short_leg),
        net_debit_usd=net_debit,
        max_loss_mxn=max_loss_mxn,
        max_profit_mxn=max_profit_mxn,
        reward_risk=reward_risk,
        break_even=break_even,
        net_delta=long_delta - short_delta,
        net_gamma=long_gamma - short_gamma,
        net_theta=long_theta - short_theta,
        net_vega=long_vega - short_vega,
        spread_percent=spread_percent,
        implied_vol=iv,
        dte=dte
    )


def mark_structure_value(structure: OptionStructure, spot: float, remaining_dte: int, usd_mxn: float) -> float:
    value = 0.0
    for leg in structure.legs:
        price, *_ = black_scholes(spot, leg.strike, max(remaining_dte, 1), structure.implied_vol, leg.option_type)
        value += price if leg.action == "buy" else -price
    return max(value, 0) * 100 * usd_mxn
