"""
make_figures.py
===============

Figures for the docs: the continuous options-quality sub-scores
(lib/risk/optionsQuality.ts), the step risk multipliers (lib/risk.ts) and the
sub-score breakdown of two example trades. The Python functions below are
line-by-line ports of the TypeScript ones.

Usage:
    python docs/make_figures.py      # writes docs/img/*.png
"""
from pathlib import Path

import matplotlib.pyplot as plt

FIGS = Path(__file__).resolve().parent / "img"


def linspace(a, b, n):
    step = (b - a)/(n - 1)
    xs = [a + i*step for i in range(n)]
    xs[-1] = b  # avoid rounding errors
    return xs


def clamp01(v):
    return min(1.0, max(0.0, v))


# ---------------------------------------------- lib/risk/optionsQuality.ts
def spread_quality(spread):
    if spread <= 2:
        return 1.0
    return clamp01(1 / (1 + ((spread - 2) / 5) ** 3))


def dte_quality(days):
    if days < 5:
        return 0.0
    if days < 21:
        return clamp01((days - 5) / 16)
    if days <= 60:
        return 1.0
    if days <= 240:
        return clamp01(1 - (days - 60) / 180)
    return 0.0


def volume_quality(volume):
    return clamp01((max(volume, 0) / 500) ** 0.5)


def open_interest_quality(oi):
    return clamp01((max(oi, 0) / 1000) ** 0.5)


def iv_rank_quality(iv_rank):
    return clamp01(1 - clamp01(iv_rank / 100) ** 2)


def premium_size_quality(percent):
    if percent <= 0.25:
        return 1.0
    if percent <= 1:
        return clamp01(1 - 0.65 * ((percent - 0.25) / 0.75) ** 2)
    return clamp01(0.35 / (1 + (percent - 1) ** 2))


# ------------------------------------------------------------ lib/risk.ts
def confidence_multiplier(score):
    if score < 75:
        return 0.0
    if score < 80:
        return 0.25
    if score < 85:
        return 0.5
    if score < 90:
        return 0.75
    return 1.0


def liquidity_multiplier(spread):
    if spread > 15:
        return 0.0
    if spread > 10:
        return 0.25
    if spread > 5:
        return 0.5
    return 1.0


def volatility_multiplier(iv_rank):
    if iv_rank > 80:
        return 0.25
    if iv_rank > 60:
        return 0.5
    if iv_rank < 20:
        return 0.75
    return 1.0


# ---------------------------------------------------- options-quality curves
curves = [
    ("spread", spread_quality, (0, 25), "Bid/ask spread (%)", "Options quality: bid/ask spread"),
    ("dte", dte_quality, (0, 250), "Days to expiration", "Options quality: days to expiration"),
    ("volume", volume_quality, (0, 1000), "Option volume (contracts)", "Options quality: volume"),
    ("open_interest", open_interest_quality, (0, 2000), "Open interest (contracts)", "Options quality: open interest"),
    ("iv_rank", iv_rank_quality, (0, 100), "IV rank", "Options quality: IV rank"),
    ("premium", premium_size_quality, (0, 3), "Premium (% of portfolio)", "Options quality: premium size"),
]

for name, fn, (a, b), xlabel, title in curves:
    x = linspace(a, b, 500)
    plt.figure()
    plt.plot(x, [100 * fn(v) for v in x])
    plt.xlabel(xlabel)
    plt.ylabel("Quality (%)")
    plt.title(title)
    plt.savefig(FIGS / f"quality_{name}.png")

# ----------------------------------------------------------- multipliers
multipliers = [
    ("confidence", confidence_multiplier, (50, 100), "Final score", "Risk multiplier vs final score"),
    ("liquidity", liquidity_multiplier, (0, 25), "Bid/ask spread (%)", "Risk multiplier vs bid/ask spread"),
    ("volatility", volatility_multiplier, (0, 100), "IV rank", "Risk multiplier vs IV rank"),
]

for name, fn, (a, b), xlabel, title in multipliers:
    x = linspace(a, b, 1001)
    plt.figure()
    plt.plot(x, [fn(v) for v in x])
    plt.xlabel(xlabel)
    plt.ylabel("Risk multiplier")
    plt.title(title)
    plt.savefig(FIGS / f"multiplier_{name}.png")

# ------------------------------------------------ example trade scorecards
labels = ["Regime", "Technical", "Options", "Process", "Final"]
examples = [
    ("scorecard_tsla", [31, 55, 18, 23, 27],
     "TSLA long call, 5 DTE, 18 % spread: REJECT (5 hard stops)"),
    ("scorecard_aapl", [85, 96, 86, 93, 80],
     "AAPL call debit spread: APPROVED SMALL (risk 125 MXN)"),
]

for name, scores, title in examples:
    plt.figure()
    plt.bar(labels, scores)
    plt.xlabel("Component")
    plt.ylabel("Score (0-100)")
    plt.ylim(0, 100)
    plt.title(title)
    plt.savefig(FIGS / f"{name}.png")

plt.show()
