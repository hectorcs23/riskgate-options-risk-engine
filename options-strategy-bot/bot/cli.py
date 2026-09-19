from __future__ import annotations

import argparse
import csv
from pathlib import Path

from .backtest import run_backtest, write_backtest
from .config import load_config
from .data import load_history
from .features import build_market_regime, technical_features
from .paper import open_candidates
from .strategies import Candidate, build_candidates


def _write_candidates(candidates: list[Candidate], out_dir: str | Path) -> Path:
    path = Path(out_dir)
    path.mkdir(parents=True, exist_ok=True)
    out = path / "candidates.csv"
    rows = [candidate.to_row() for candidate in candidates]
    fields = list(rows[0].keys()) if rows else [
        "symbol", "strategy", "direction", "decision", "total_score", "warnings"
    ]
    with out.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
    return out


def scan(args: argparse.Namespace) -> list[Candidate]:
    config = load_config(args.config)
    histories = {
        symbol: load_history(symbol, args.data_dir, args.synthetic, args.offline)
        for symbol in [*config.universe, "SPY", "QQQ", "VIX"]
    }
    regime = build_market_regime(histories.get("SPY", []), histories.get("QQQ", []), histories.get("VIX", []), [histories.get(symbol, []) for symbol in config.universe[:8]])
    candidates: list[Candidate] = []
    for symbol in config.universe:
        features = technical_features(histories.get(symbol, []))
        if not features:
            continue
        candidates.extend(build_candidates(symbol, features, regime, config))
    candidates.sort(key=lambda item: item.score.total_score, reverse=True)
    candidates = candidates[: config.risk.max_daily_candidates]
    out = _write_candidates(candidates, args.out)
    print(f"Wrote {len(candidates)} candidates to {out}")
    for candidate in candidates[:8]:
        print(
            f"{candidate.symbol:5s} {candidate.strategy:26s} "
            f"{candidate.score.total_score:5.1f} {candidate.score.decision:12s} "
            f"loss={candidate.structure.max_loss_mxn:7.0f}MXN rr={candidate.structure.reward_risk:4.2f}"
        )
    return candidates


def backtest(args: argparse.Namespace) -> None:
    config = load_config(args.config)
    result = run_backtest(config, args.data_dir, args.synthetic, args.offline)
    write_backtest(result, args.out)
    print("Backtest summary")
    for key, value in result.summary.items():
        print(f"{key}: {value}")
    print(f"Wrote outputs to {Path(args.out).resolve()}")


def paper_step(args: argparse.Namespace) -> None:
    config = load_config(args.config)
    candidates = scan(args)
    if args.auto_open:
        rows = open_candidates(
            candidates,
            Path(args.out) / "paper_ledger.json",
            config.strategy.min_score_to_enter,
            max_new=2
        )
        print(f"Paper ledger rows: {len(rows)}")
    else:
        print("Use --auto-open to add qualifying candidates to the local paper ledger.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Standalone options strategy research bot.")
    sub = parser.add_subparsers(dest="command", required=True)

    def add_common(command: argparse.ArgumentParser) -> None:
        command.add_argument("--config", default="config.example.json")
        command.add_argument("--data-dir", default=None)
        command.add_argument("--out", default="outputs")
        command.add_argument("--synthetic", action="store_true")
        command.add_argument("--offline", action="store_true")

    scan_parser = sub.add_parser("scan", help="Rank current candidates.")
    add_common(scan_parser)
    scan_parser.set_defaults(func=scan)

    backtest_parser = sub.add_parser("backtest", help="Backtest strategy rules.")
    add_common(backtest_parser)
    backtest_parser.set_defaults(func=backtest)

    paper_parser = sub.add_parser("paper-step", help="Update a local paper research ledger.")
    add_common(paper_parser)
    paper_parser.add_argument("--auto-open", action="store_true")
    paper_parser.set_defaults(func=paper_step)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
