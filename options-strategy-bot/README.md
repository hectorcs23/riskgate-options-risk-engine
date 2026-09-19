# Options Strategy Bot

Standalone research bot for testing option strategy ideas without RiskGate.

This project is intentionally separate from the dashboard app. It is a Python research harness that can:

- scan a universe for options candidates,
- score setups with a RiskGate-style model,
- backtest strategy rules on historical underlying prices,
- simulate defined-risk option structures with Black-Scholes proxies,
- keep a local paper ledger,
- optionally read Alpaca option snapshots when API keys are available.

It does **not** place live trades.

## Quick Start

From this folder:

```powershell
python -m bot.cli backtest --config config.example.json --synthetic
python -m bot.cli scan --config config.example.json --synthetic
```

Outputs are written to `outputs/`.

## Real Data

You can provide CSV files in a data folder:

```text
data/AAPL.csv
data/MSFT.csv
data/SPY.csv
data/QQQ.csv
data/VIX.csv
```

CSV columns:

```text
date,open,high,low,close,volume
```

Then run:

```powershell
python -m bot.cli backtest --config config.example.json --data-dir data
python -m bot.cli scan --config config.example.json --data-dir data
```

If a CSV is missing, the bot can try Yahoo's public chart endpoint unless `--offline` is set.

## Alpaca

For read-only option chain scans, set:

```powershell
$env:APCA_API_KEY_ID="..."
$env:APCA_API_SECRET_KEY="..."
```

The Alpaca provider is read-only in this project. Order placement is intentionally absent.

## Alpaca Execution Adapter

`scripts/alpaca_riskgate_options_trader.py` is the live execution adapter for the
RiskLab strategy. It keeps the research model intact, scans with the existing
`bot.strategies.build_candidates` pipeline, sizes from the real Alpaca
`portfolio_value`, and then submits option orders through Alpaca.

Default behavior is dry-run:

```powershell
python scripts\alpaca_riskgate_options_trader.py --config config.alpaca.example.json
```

Real orders require `--live`:

```powershell
python scripts\alpaca_riskgate_options_trader.py --config config.alpaca.example.json --live
```

Important execution settings live under the `execution` key in
`config.alpaca.example.json`:

- `mode`: `debit_spread` uses Alpaca multileg orders for the tested spread
  strategies. `long_option` converts spread candidates into single long calls or
  puts when you only want level-2 premium buying.
- `options_sleeve_pct`: fraction of the full Alpaca portfolio that the options
  engine may use. The example is `1.0`, meaning the full portfolio is eligible
  for sizing.
- `risk_per_trade_pct`: max risk per new strategy unit as a fraction of Alpaca
  portfolio value.
- `allow_watchlist_entries`: when `true`, the execution adapter may trade
  candidates whose score is above `strategy.min_score_to_enter` even if the
  RiskLab decision band is still `watchlist`.
- `take_profit_pct` and `stop_loss_pct`: optional premium exits. If left `null`,
  the adapter exits by the research bot's `strategy.hold_days` and by near
  expiration.

The adapter writes managed position state to `outputs/alpaca_riskgate_state.json`.
It only auto-closes positions it opened and recorded there.

## Strategy Families

Current v1 strategies:

- `bull_call_debit_spread`
- `bear_put_debit_spread`
- `long_call_proxy`
- `long_put_proxy`

The backtester uses option-pricing proxies because full historical option chains are expensive and not always available. This is good for comparing strategy logic, but not enough to trust production execution.

## Useful Commands

```powershell
python -m bot.cli backtest --config config.example.json --synthetic
python -m bot.cli scan --config config.example.json --synthetic
python -m bot.cli paper-step --config config.example.json --synthetic --auto-open
```

## Follow Up Saved RiskGate Ideas

This standalone script reads saved option contract selections from the RiskGate SQLite file without changing the app, then pulls Alpaca historical option bars and produces premium-path charts:

```powershell
python scripts\backtest_riskgate_premiums.py --timeframe 1Hour
```

It automatically evaluates the newest saved batch with actual post-entry premium bars. Use `--batch-date YYYY-MM-DD` to review an older batch.

To compare every saved RiskGate idea above a score threshold, including ideas that did not receive an option contract, run:

```powershell
python scripts\compare_scored_ideas.py --min-score 60 --timeframe 1Hour
```

This comparison tests the predicted stock direction for every qualifying idea and uses actual historical option premium bars only where RiskGate saved a contract selection. It splits the report into `60-69.9` and `70+` groups and flags result concentration from unusually large winners.

To graph only the underlying-stock movement after bullish and bearish signals using Yahoo Finance daily adjusted closes:

```powershell
python scripts\chart_yahoo_signal_followthrough.py --min-score 60
```

The Yahoo report uses the first completed session after each signal as its baseline, so it measures later follow-through without counting the move that may have generated the signal.

## Model Scope

The model scores:

- market regime,
- technical setup,
- option structure quality,
- trade quality,
- risk/account fit.

The bot is best used to answer:

- Which market regimes fit my rules?
- Which strategy family survives more often?
- How often do high-scoring setups actually pay?
- What happens if I restrict to medium volatility and liquid mega caps?

It cannot yet prove:

- exact historical option fills,
- true bid/ask slippage,
- assignment and early exercise behavior,
- intraday execution quality,
- broker-specific margin treatment.
