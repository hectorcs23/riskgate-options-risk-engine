# RiskGate Trade Idea Model

Last updated: 2026-05-02

RiskGate's trade idea model is a decision-support system for manual options trading. It does not predict the future, place trades, or provide financial advice. Its job is narrower and more useful: force a complete trade plan, reject obviously weak options setups, and assign a small risk budget only when the trade passes both scoring and hard safety checks.

## Design Goal

The model answers three questions:

1. Is the trade idea complete enough to consider?
2. Is the setup aligned with market, technical, liquidity, and trade-quality conditions?
3. If approved, how much money can be risked without breaking the portfolio's limits?

The central rule is:

```text
No options trade should be approved unless the written plan, score, liquidity checks, expiration rules, and portfolio risk caps all pass.
```

## Current Inputs

Each trade idea captures:

- Symbol, direction, strategy, thesis, catalyst, invalidation level, target, expiration, premium, max loss, expected reward, and exit plan.
- Market regime inputs: SPY trend, QQQ trend, VIX condition, market breadth, macro risk.
- Technical inputs: trend, price versus 20MA, price versus 50MA, RSI condition, volume condition, support/resistance quality.
- Options quality inputs: bid/ask spread, option volume, open interest, days to expiration, implied volatility rank, premium as percent of portfolio.
- Behavior input: whether the idea is chasing.

## Score Modules

The total score is a weighted score from four modules.

| Module | Weight | Purpose |
| --- | ---: | --- |
| Market regime | 30% | Does the broad market support the trade direction? |
| Technical setup | 30% | Does the chart structure support the trade? |
| Options quality | 25% | Is the contract liquid, reasonably priced, and not too close to expiration? |
| Trade quality | 15% | Is the written plan clear and disciplined? |

Formula:

```text
moduleScore = clamp(baseScore + sum(ruleAdjustments), 0, 100)

totalScore =
  marketRegimeScore * 0.30 +
  technicalScore * 0.30 +
  optionsQualityScore * 0.25 +
  tradeQualityScore * 0.15
```

## Market Regime Score

Starts at 50 and adjusts based on broad conditions.

Positive inputs:

- SPY bullish: +15
- QQQ bullish: +15
- Strong market breadth: +10
- Low VIX: +5
- Low macro risk: +5

Negative inputs:

- SPY bearish: -15
- QQQ bearish: -15
- Weak breadth: -10
- Elevated VIX: -10
- Spiking VIX: -25
- High macro risk: -20

The output is clamped between 0 and 100.

## Technical Score

Starts at 50 and rewards alignment between trade direction and chart condition.

Examples:

- Bullish trade in an uptrend: +18
- Bearish trade in a downtrend: +18
- Neutral trade in a sideways trend: +12
- Bullish trade in a downtrend: -15
- Bearish trade in an uptrend: -15
- Strong volume: +8
- Weak volume: -8
- Good support/resistance quality: +10
- Poor support/resistance quality: -15

This keeps the model from approving trades where the option direction fights the current setup.

## Options Quality Score

Starts at 65 because an options contract can be usable only if liquidity, expiration, and premium are acceptable.

Positive inputs:

- Bid/ask spread <= 5%: +15
- Option volume >= 500: +8
- Open interest >= 1000: +8
- 21 to 60 days to expiration: +10
- Premium <= 0.5% of portfolio: +5

Negative inputs:

- Bid/ask spread > 5%: -8
- Bid/ask spread > 10%: -18
- Bid/ask spread > 15%: -35
- Option volume < 50: -15
- Open interest < 100: -15
- Days to expiration < 7: -40
- Days to expiration > 120: -8
- Premium > 1% of portfolio: -30
- IV rank > 80: -15

This module matters because a trade can have a good thesis and still be a bad option trade if the contract is illiquid, too expensive, or too close to expiration.

## Trade Quality Score

Starts at 40 and rewards planning discipline.

Positive inputs:

- Thesis is at least 30 characters: +20
- Catalyst exists: +8
- Invalidation level exists: +12
- Exit plan exists: +12
- Reward-to-risk is at least 2:1: +10

Negative inputs:

- Reward-to-risk is below 1.5:1: -12
- Trade is marked as chasing: -25

This score is intentionally less about market prediction and more about process quality.

## Decision Bands

After scoring, the model assigns an initial decision:

| Total score | Initial decision |
| ---: | --- |
| < 60 | reject |
| 60 to 74 | watchlist |
| 75 to 84 | approved_small |
| >= 85 | approved_normal |

## Hard Stops

Hard stops override the score and force a reject.

The current hard stops are:

- Missing written thesis.
- Missing invalidation level.
- Missing max loss or max loss <= 0.
- Missing exit plan.
- Bid/ask spread > 15%.
- Days to expiration < 7.
- Premium > 1% of portfolio.
- Option volume < 25 and open interest < 100.

This means a trade can score well but still be rejected if it lacks discipline or violates liquidity/risk rules.

## Position Sizing

If the final decision is approved, the model calculates suggested risk.

Formula:

```text
suggestedRisk =
  baseRiskPerTradeMXN *
  confidenceMultiplier *
  liquidityMultiplier *
  marketRegimeMultiplier *
  volatilityMultiplier
```

### Confidence Multiplier

| Score | Multiplier |
| ---: | ---: |
| < 75 | 0 |
| 75 to 79 | 0.25 |
| 80 to 84 | 0.50 |
| 85 to 89 | 0.75 |
| >= 90 | 1.00 |

### Liquidity Multiplier

| Bid/ask spread | Multiplier |
| ---: | ---: |
| > 15% | 0 |
| > 10% | 0.25 |
| > 5% | 0.50 |
| <= 5% | 1.00 |

### Market Regime Multiplier

| Condition | Multiplier |
| --- | ---: |
| Bullish regime and bullish trade | 1.00 |
| Bearish regime and bearish trade | 1.00 |
| Neutral regime | 0.50 |
| Direction fights regime | 0.25 |

Today this uses SPY trend as the regime proxy.

### Volatility Multiplier

| IV rank | Multiplier |
| ---: | ---: |
| Missing | 1.00 |
| > 80 | 0.25 |
| > 60 | 0.50 |
| < 20 | 0.75 |
| 20 to 60 | 1.00 |

## Portfolio Caps

After calculating uncapped suggested risk, the model applies final portfolio caps:

```text
suggestedRisk = min(
  uncappedRisk,
  remainingOptionsSleeve,
  remainingMonthlyLossLimit,
  remainingOpenOptionsRiskLimit
)
```

For the default 100,000 MXN account:

- Options sleeve: 3% = 3,000 MXN.
- Base risk per trade: 0.5% = 500 MXN.
- Max monthly options loss: 1% = 1000 MXN.
- Max open options risk: 2% = 2,000 MXN.

## Current Limitations

The current model is useful as a checklist and sizing guardrail, but it is still manual and simple.

Important limitations:

- Market regime inputs are manually selected.
- Technical inputs are manually selected.
- Options liquidity is manually entered.
- It does not verify bid, ask, mid, Greeks, IV, or volume from live data.
- It does not backtest rules.
- It does not estimate probability of profit.
- It does not model spread payoff diagrams.
- It does not account for earnings dates automatically.
- It does not adjust for sector, correlation, or concentration.
- It does not distinguish options strategies deeply enough yet. A long call, long put, debit spread, and protective put should eventually have different checks.

## Ticker Tracking

RiskGate now tracks symbols through a portfolio-specific Watchlist.

Current tracking design:

- Each portfolio has its own watchlist.
- Each watchlist row stores symbol, market, currency, data source, latest price, previous close, day change, day change percent, last updated time, and notes.
- The current quote refresh implementation uses Yahoo Finance's public chart endpoint for latest/previous-close style data.
- Manual prices remain supported because public/unofficial quote sources can fail, change, or be delayed.

Important: the current scoring model does not yet automatically calculate SPY trend, QQQ trend, VIX condition, RSI, moving averages, or breadth from the watchlist. The watchlist is the foundation for that next step.

## Better Version: Robustness Layers

A stronger version should be built in layers.

### Layer 1: Keep Manual Approval

Keep the final approve/reject decision in RiskGate and keep execution manual. This avoids broker-password storage and accidental trading automation.

### Layer 2: Add Read-Only Market Data

Use an official market-data API to fill:

- Underlying price.
- 20MA and 50MA.
- RSI.
- Volume.
- Option chain.
- Bid, ask, midpoint, spread.
- Option volume.
- Open interest.
- Days to expiration.
- Implied volatility and Greeks if available.

### Layer 3: Add Strategy-Specific Checks

Examples:

- Long calls/puts: require trend alignment, enough DTE, limited premium, and clear exit plan.
- Debit spreads: calculate max gain, max loss, break-even, reward-to-risk, and width.
- Protective puts: compare hedge cost against portfolio drawdown protection.
- Covered/cash-secured strategies later: require share/cash coverage.

### Layer 4: Add Backtesting and Review

Track historical model score versus actual result:

- Win rate by score band.
- Average P&L by score band.
- Best and worst setup tags.
- Mistake tags by loss.
- Whether model-approved trades outperform rejected/watchlist ideas.

### Layer 5: Add Broker Integration Only If Needed

If broker integration is added, use read-only first:

- Positions.
- Balances.
- Filled trades.
- Order history.

Order placement should be a separate phase, and ideally require explicit confirmation.

## Integration Candidates

These are possible external services to make the model more robust.

### Tradier

Tradier is a strong candidate for U.S. equities/options because its docs include market data, option chains, account data, sandbox mode, and options trading. The options chain endpoint can include Greeks and IV. Tradier's docs say real-time data is available to Tradier Brokerage account holders, while sandbox data is delayed. It is best suited if you want read-only options chain automation now and possible paper/live trading later.

Official docs:

- https://docs.tradier.com/docs/getting-started
- https://docs.tradier.com/reference/brokerage-api-markets-get-options-chains
- https://docs.tradier.com/docs/market-data

### Polygon.io

Polygon is a market-data-first choice. Its options docs describe U.S. options market data, including real-time prices, historical data, reference data, REST APIs, WebSockets, and flat files. It is best suited if the goal is robust pricing/history, not broker execution.

Official docs:

- https://polygon.io/docs/rest/options/overview

### MarketData.app

MarketData.app is another market-data-first option. Its docs include options expirations, strikes, option chains, quotes, and historical modes. It can be useful for filling chains and quotes without building broker execution.

Official docs:

- https://www.marketdata.app/docs/api/
- https://www.marketdata.app/docs/sdk/go/options/

### Alpaca

Alpaca now has options API support in its documentation, including options trading levels, option contracts, market data, positions, and order placement. It is a candidate if you want API-based paper trading or execution in a supported account. It is less directly tied to GBM, so it should be treated as a separate integration path.

Official docs:

- https://docs.alpaca.markets/docs/options-trading

## Recommended Next Step

The best next build is a read-only "Options Chain Analyzer" inside RiskGate:

1. User enters symbol and strategy.
2. App pulls expirations, strikes, bid/ask, volume, open interest, IV, and Greeks.
3. App pre-fills options quality fields.
4. App highlights contracts that pass liquidity and DTE filters.
5. User still writes thesis, invalidation, max loss, and exit plan manually.
6. RiskGate scores and sizes the idea.

This makes the model more objective while keeping the discipline and safety of manual approval.
