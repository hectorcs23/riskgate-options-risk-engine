from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import csv

from .config import BotConfig
from .data import Bar, load_history, slice_until
from .features import build_market_regime, technical_features
from .options import mark_structure_value
from .strategies import Candidate, build_candidates


@dataclass
class Position:
    candidate: Candidate
    entry_index: int
    entry_value_mxn: float


@dataclass(frozen=True)
class Trade:
    symbol: str
    strategy: str
    entry_date: str
    exit_date: str
    score: float
    decision: str
    entry_value_mxn: float
    exit_value_mxn: float
    pnl_mxn: float
    return_r: float


@dataclass(frozen=True)
class BacktestResult:
    trades: tuple[Trade, ...]
    equity_curve: tuple[tuple[str, float], ...]
    summary: dict[str, float]


def _market_slice(histories: dict[str, list[Bar]], symbol: str, index: int) -> list[Bar]:
    return slice_until(histories.get(symbol, []), min(index, len(histories.get(symbol, [])) - 1))


def run_backtest(config: BotConfig, data_dir: str | None, synthetic: bool, offline: bool) -> BacktestResult:
    symbols = list(dict.fromkeys([*config.universe, "SPY", "QQQ", "VIX"]))
    histories = {symbol: load_history(symbol, data_dir, synthetic, offline) for symbol in symbols}
    usable_lengths = [len(histories[symbol]) for symbol in config.universe if len(histories.get(symbol, [])) >= 80]
    if not usable_lengths:
        return BacktestResult((), (), {"trade_count": 0, "total_pnl_mxn": 0, "expectancy_mxn": 0, "win_rate": 0})

    length = min(usable_lengths)
    equity = config.initial_equity_mxn
    open_positions: list[Position] = []
    trades: list[Trade] = []
    equity_curve: list[tuple[str, float]] = []

    for index in range(60, length - config.strategy.hold_days - 1):
        current_date = histories[config.universe[0]][index].date.isoformat()
        next_open: list[Position] = []
        for position in open_positions:
            held = index - position.entry_index
            if held < config.strategy.hold_days:
                next_open.append(position)
                continue
            bars = histories[position.candidate.symbol]
            exit_bar = bars[index]
            remaining_dte = max(position.candidate.structure.dte - held, 1)
            exit_value = mark_structure_value(position.candidate.structure, exit_bar.close, remaining_dte, config.usd_mxn)
            pnl = exit_value - position.entry_value_mxn
            equity += pnl
            trades.append(
                Trade(
                    symbol=position.candidate.symbol,
                    strategy=position.candidate.strategy,
                    entry_date=bars[position.entry_index].date.isoformat(),
                    exit_date=exit_bar.date.isoformat(),
                    score=position.candidate.score.total_score,
                    decision=position.candidate.score.decision,
                    entry_value_mxn=round(position.entry_value_mxn, 2),
                    exit_value_mxn=round(exit_value, 2),
                    pnl_mxn=round(pnl, 2),
                    return_r=round(pnl / max(position.candidate.structure.max_loss_mxn, 1), 3)
                )
            )
        open_positions = next_open

        spy = _market_slice(histories, config.market_symbols.get("spy", "SPY"), index)
        qqq = _market_slice(histories, config.market_symbols.get("qqq", "QQQ"), index)
        vix = _market_slice(histories, config.market_symbols.get("vix", "VIX"), index)
        breadth = [_market_slice(histories, symbol, index) for symbol in config.universe[:8]]
        regime = build_market_regime(spy, qqq, vix, breadth)
        candidates: list[Candidate] = []

        for symbol in config.universe:
            bars = histories.get(symbol, [])
            if len(bars) <= index:
                continue
            features = technical_features(slice_until(bars, index))
            if not features:
                continue
            candidates.extend(build_candidates(symbol, features, regime, config))

        candidates.sort(key=lambda item: item.score.total_score, reverse=True)
        open_symbols = {position.candidate.symbol for position in open_positions}
        for candidate in candidates:
            if len(open_positions) >= config.risk.max_open_positions:
                break
            if candidate.symbol in open_symbols:
                continue
            if candidate.score.total_score < config.strategy.min_score_to_enter:
                continue
            if candidate.score.decision not in {"paper_small", "paper_normal"}:
                continue
            open_positions.append(Position(candidate, index, candidate.structure.max_loss_mxn))
            open_symbols.add(candidate.symbol)

        equity_curve.append((current_date, round(equity, 2)))

    wins = [trade.pnl_mxn for trade in trades if trade.pnl_mxn > 0]
    losses = [trade.pnl_mxn for trade in trades if trade.pnl_mxn <= 0]
    total = sum(trade.pnl_mxn for trade in trades)
    summary = {
        "trade_count": len(trades),
        "total_pnl_mxn": round(total, 2),
        "ending_equity_mxn": round(equity, 2),
        "expectancy_mxn": round(total / len(trades), 2) if trades else 0,
        "win_rate": round(len(wins) / len(trades), 4) if trades else 0,
        "average_win_mxn": round(sum(wins) / len(wins), 2) if wins else 0,
        "average_loss_mxn": round(sum(losses) / len(losses), 2) if losses else 0
    }
    return BacktestResult(tuple(trades), tuple(equity_curve), summary)


def write_backtest(result: BacktestResult, out_dir: str | Path) -> None:
    path = Path(out_dir)
    path.mkdir(parents=True, exist_ok=True)
    with (path / "trades.csv").open("w", encoding="utf-8", newline="") as handle:
        fields = list(Trade.__dataclass_fields__.keys())
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for trade in result.trades:
            writer.writerow(trade.__dict__)
    with (path / "equity_curve.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["date", "equity_mxn"])
        writer.writerows(result.equity_curve)
    with (path / "summary.csv").open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["metric", "value"])
        writer.writerows(result.summary.items())
