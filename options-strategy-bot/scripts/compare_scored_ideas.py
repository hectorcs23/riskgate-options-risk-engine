from __future__ import annotations

import argparse
import csv
from dataclasses import dataclass
from datetime import datetime, timedelta
from html import escape
from pathlib import Path
from statistics import median
from typing import Callable, Hashable

from backtest_riskgate_premiums import (
    Bar,
    Idea,
    LOCAL_TZ,
    Outcome,
    UTC,
    alpaca_json,
    evaluate_ideas,
    fetch_ideas,
    fetch_option_bars,
    format_money,
    format_percent,
    load_dot_env,
    parse_bar,
)


GOOD = "#15803d"
BAD = "#b91c1c"
HIGH_SCORE = "#0f766e"
MID_SCORE = "#2563eb"
MUTED = "#78716c"


@dataclass(frozen=True)
class ComparisonRow:
    idea: Idea
    stock_bars: tuple[Bar, ...]
    stock_entry: Bar | None
    stock_latest: Bar | None
    directional_return_percent: float | None
    stock_status: str
    premium: Outcome


@dataclass(frozen=True)
class Summary:
    label: str
    rows: tuple[ComparisonRow, ...]
    unique_stock: tuple[ComparisonRow, ...]
    unique_premium: tuple[ComparisonRow, ...]


def score_of(idea: Idea) -> float:
    return idea.total_score if idea.total_score is not None else 0.0


def score_bucket(idea: Idea) -> str:
    return "70+" if score_of(idea) >= 70 else "60-69.9"


def fetch_stock_bars(
    symbols: list[str],
    start: datetime,
    end: datetime,
    timeframe: str,
) -> dict[str, list[Bar]]:
    results: dict[str, list[Bar]] = {symbol: [] for symbol in symbols}
    if not symbols:
        return results
    page_token: str | None = None
    while True:
        params: dict[str, str] = {
            "symbols": ",".join(symbols),
            "timeframe": timeframe,
            "start": start.astimezone(UTC).isoformat().replace("+00:00", "Z"),
            "end": end.astimezone(UTC).isoformat().replace("+00:00", "Z"),
            "limit": "10000",
            "sort": "asc",
            "feed": "iex",
        }
        if page_token:
            params["page_token"] = page_token
        payload = alpaca_json("/v2/stocks/bars", params)
        for symbol, raw_bars in (payload.get("bars") or {}).items():
            results.setdefault(symbol, []).extend(parse_bar(raw) for raw in raw_bars)
        page_token = payload.get("next_page_token")
        if not page_token:
            break
    for symbol in results:
        results[symbol].sort(key=lambda bar: bar.timestamp)
    return results


def evaluate_stock_direction(
    idea: Idea,
    bars_by_symbol: dict[str, list[Bar]],
    as_of: datetime,
) -> tuple[tuple[Bar, ...], Bar | None, Bar | None, float | None, str]:
    bars = tuple(
        bar
        for bar in bars_by_symbol.get(idea.symbol, [])
        if bar.timestamp >= idea.created_at and bar.timestamp <= as_of and bar.close > 0
    )
    if not bars:
        return (), None, None, None, "No post-signal stock price yet"
    entry = bars[0]
    latest = bars[-1]
    if len(bars) < 2 or latest.timestamp <= entry.timestamp:
        return bars, entry, latest, None, "Entry observed; no later stock mark"
    raw_return = ((latest.close / entry.close) - 1) * 100
    if idea.direction == "bearish":
        directional_return = -raw_return
    elif idea.direction == "neutral":
        return bars, entry, latest, None, "Neutral direction has no directional return"
    else:
        directional_return = raw_return
    return bars, entry, latest, directional_return, "Evaluable"


def unique_rows(
    rows: list[ComparisonRow],
    key_fn: Callable[[ComparisonRow], Hashable],
) -> tuple[ComparisonRow, ...]:
    selected: dict[Hashable, ComparisonRow] = {}
    for row in rows:
        key = key_fn(row)
        previous = selected.get(key)
        if previous is None or score_of(row.idea) > score_of(previous.idea):
            selected[key] = row
    return tuple(sorted(selected.values(), key=lambda row: row.idea.created_at))


def stock_key(row: ComparisonRow) -> tuple[str, str, datetime | None]:
    return row.idea.symbol, row.idea.direction, row.stock_entry.timestamp if row.stock_entry else None


def premium_key(row: ComparisonRow) -> tuple[str | None, datetime | None]:
    return (
        row.idea.contract_symbol,
        row.premium.entry_bar.timestamp if row.premium.entry_bar else None,
    )


def summarize(rows: list[ComparisonRow], label: str) -> Summary:
    evaluated_stock = [
        row for row in rows if row.stock_status == "Evaluable" and row.directional_return_percent is not None
    ]
    evaluated_premium = [
        row
        for row in rows
        if row.premium.status == "Evaluable" and row.premium.return_percent is not None
    ]
    return Summary(
        label,
        tuple(rows),
        unique_rows(evaluated_stock, stock_key),
        unique_rows(evaluated_premium, premium_key),
    )


def percent_average(values: list[float]) -> str:
    return "-" if not values else f"{sum(values) / len(values):+.1f}%"


def percent_median(values: list[float]) -> str:
    return "-" if not values else f"{median(values):+.1f}%"


def metric_row(summary: Summary) -> str:
    stock_values = [
        row.directional_return_percent
        for row in summary.unique_stock
        if row.directional_return_percent is not None
    ]
    stock_winners = sum(value > 0 for value in stock_values)
    premium_values = [
        row.premium.return_percent for row in summary.unique_premium if row.premium.return_percent is not None
    ]
    premium_winners = sum(value > 0 for value in premium_values)
    premium_pnl = sum(row.premium.pnl_usd or 0 for row in summary.unique_premium)
    selected_contracts = sum(1 for row in summary.rows if row.idea.contract_symbol)
    return (
        "<tr>"
        f"<td><strong>{escape(summary.label)}</strong></td>"
        f"<td>{len(summary.rows)}</td>"
        f"<td>{len(summary.unique_stock)}</td>"
        f"<td>{stock_winners}/{len(stock_values)} ({(100 * stock_winners / len(stock_values) if stock_values else 0):.1f}%)</td>"
        f"<td>{percent_average(stock_values)}</td>"
        f"<td>{selected_contracts}</td>"
        f"<td>{len(summary.unique_premium)}</td>"
        f"<td>{premium_winners}/{len(premium_values)} ({(100 * premium_winners / len(premium_values) if premium_values else 0):.1f}%)</td>"
        f"<td>{percent_median(premium_values)}</td>"
        f"<td>{format_money(premium_pnl)}</td>"
        "</tr>"
    )


def bar_chart_svg(
    path: Path,
    title: str,
    items: list[tuple[str, float, str]],
    ylabel: str,
) -> None:
    width = max(1120, 118 + len(items) * 44)
    height = 600
    left, right, top, bottom = 82, 25, 54, 152
    plot_width = width - left - right
    plot_height = height - top - bottom
    if not items:
        path.write_text(
            f'<svg xmlns="http://www.w3.org/2000/svg" width="1120" height="300">'
            '<rect width="100%" height="100%" fill="#ffffff"/>'
            f'<text x="45" y="52" font-family="Arial" font-size="23" font-weight="700" fill="#17201c">{escape(title)}</text>'
            '<text x="45" y="102" font-family="Arial" font-size="16" fill="#57534e">No evaluable observations.</text>'
            "</svg>",
            encoding="utf-8",
        )
        return
    values = [value for _, value, _ in items]
    floor = min(min(values), 0)
    ceiling = max(max(values), 0)
    spread = max(ceiling - floor, 1)
    floor -= spread * 0.12
    ceiling += spread * 0.12
    total_range = ceiling - floor
    zero_y = top + (ceiling / total_range) * plot_height
    step = plot_width / len(items)
    bar_width = min(28, step * 0.7)

    def y_value(value: float) -> float:
        return top + (ceiling - value) / total_range * plot_height

    lines = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        '<rect width="100%" height="100%" fill="#ffffff"/>',
        f'<text x="{left}" y="31" font-family="Arial" font-size="23" font-weight="700" fill="#17201c">{escape(title)}</text>',
        f'<text x="20" y="{top + plot_height / 2:.0f}" transform="rotate(-90 20 {top + plot_height / 2:.0f})" font-family="Arial" font-size="13" fill="#57534e">{escape(ylabel)}</text>',
    ]
    for tick in range(6):
        value = floor + total_range * tick / 5
        y = y_value(value)
        lines.append(
            f'<line x1="{left}" y1="{y:.2f}" x2="{width - right}" y2="{y:.2f}" stroke="#e7e5e4" stroke-width="1"/>'
        )
        lines.append(
            f'<text x="{left - 8}" y="{y + 4:.2f}" text-anchor="end" font-family="Arial" font-size="12" fill="#78716c">{value:.1f}</text>'
        )
    lines.append(
        f'<line x1="{left}" y1="{zero_y:.2f}" x2="{width - right}" y2="{zero_y:.2f}" stroke="#57534e" stroke-width="1.4"/>'
    )
    for index, (label, value, color) in enumerate(items):
        x = left + step * index + (step - bar_width) / 2
        target_y = y_value(value)
        y = min(zero_y, target_y)
        bar_height = max(abs(zero_y - target_y), 1)
        fill = GOOD if value > 0 else BAD if value < 0 else color
        lines.append(
            f'<rect x="{x:.2f}" y="{y:.2f}" width="{bar_width:.2f}" height="{bar_height:.2f}" rx="2" fill="{fill}" opacity="0.9"/>'
        )
        lines.append(
            f'<text x="{x + bar_width / 2:.2f}" y="{height - bottom + 18}" transform="rotate(55 {x + bar_width / 2:.2f} {height - bottom + 18})" text-anchor="start" font-family="Arial" font-size="11" fill="#57534e">{escape(label)}</text>'
        )
    lines.extend(
        [
            f'<rect x="{left}" y="{height - 29}" width="12" height="12" fill="{GOOD}"/>',
            f'<text x="{left + 18}" y="{height - 19}" font-family="Arial" font-size="12" fill="#57534e">Favorable</text>',
            f'<rect x="{left + 100}" y="{height - 29}" width="12" height="12" fill="{BAD}"/>',
            f'<text x="{left + 118}" y="{height - 19}" font-family="Arial" font-size="12" fill="#57534e">Unfavorable</text>',
            "</svg>",
        ]
    )
    path.write_text("\n".join(lines), encoding="utf-8")


def write_csv(path: Path, rows: list[ComparisonRow]) -> None:
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            [
                "idea_date_local",
                "symbol",
                "direction",
                "strategy",
                "score",
                "score_bucket",
                "decision",
                "stock_entry",
                "stock_latest",
                "directional_stock_return_percent",
                "stock_status",
                "option_contract",
                "premium_scope",
                "premium_entry",
                "premium_latest",
                "premium_return_percent",
                "one_contract_pnl_usd",
                "premium_status",
            ]
        )
        for row in sorted(rows, key=lambda item: item.idea.created_at):
            idea = row.idea
            premium_scope = "long_leg_only" if "spread" in idea.strategy else "single_long_option"
            writer.writerow(
                [
                    idea.created_at.astimezone(LOCAL_TZ).date().isoformat(),
                    idea.symbol,
                    idea.direction,
                    idea.strategy,
                    score_of(idea),
                    score_bucket(idea),
                    idea.decision or "",
                    row.stock_entry.close if row.stock_entry else "",
                    row.stock_latest.close if row.stock_latest else "",
                    round(row.directional_return_percent, 3)
                    if row.directional_return_percent is not None
                    else "",
                    row.stock_status,
                    idea.contract_symbol or "",
                    premium_scope if idea.contract_symbol else "",
                    row.premium.entry_bar.close if row.premium.entry_bar else "",
                    row.premium.latest_bar.close if row.premium.latest_bar else "",
                    round(row.premium.return_percent, 3) if row.premium.return_percent is not None else "",
                    round(row.premium.pnl_usd, 2) if row.premium.pnl_usd is not None else "",
                    row.premium.status,
                ]
            )


def write_html(
    path: Path,
    rows: list[ComparisonRow],
    summaries: list[Summary],
    min_score: float,
    as_of: datetime,
    timeframe: str,
) -> None:
    detail_rows = []
    for row in sorted(rows, key=lambda item: item.idea.created_at, reverse=True):
        idea = row.idea
        contract = escape(idea.contract_symbol or "No selected option")
        premium_note = (
            "Long leg only" if idea.contract_symbol and "spread" in idea.strategy else row.premium.status
        )
        detail_rows.append(
            "<tr>"
            f"<td>{idea.created_at.astimezone(LOCAL_TZ).strftime('%Y-%m-%d')}</td>"
            f"<td><strong>{escape(idea.symbol)}</strong><br><small>{escape(idea.direction)} / {escape(idea.strategy)}</small></td>"
            f"<td>{score_of(idea):.1f}<br><small>{escape(score_bucket(idea))}</small></td>"
            f"<td>{format_percent(row.directional_return_percent)}<br><small>{escape(row.stock_status)}</small></td>"
            f"<td>{contract}<br><small>{escape(premium_note)}</small></td>"
            f"<td>{format_percent(row.premium.return_percent)}</td>"
            f"<td>{format_money(row.premium.pnl_usd)}</td>"
            "</tr>"
        )
    missing_contracts = sum(1 for row in rows if not row.idea.contract_symbol)
    pending = sum(1 for row in rows if row.stock_status != "Evaluable")
    premium_symbol_pnl: dict[str, float] = {}
    all_premium = summaries[-1].unique_premium
    for row in all_premium:
        premium_symbol_pnl[row.idea.symbol] = premium_symbol_pnl.get(row.idea.symbol, 0) + (row.premium.pnl_usd or 0)
    total_premium_pnl = sum(premium_symbol_pnl.values())
    if premium_symbol_pnl:
        leading_symbol, leading_pnl = max(premium_symbol_pnl.items(), key=lambda item: item[1])
        robustness_text = (
            f"Concentration check: {leading_symbol} contributes {format_money(leading_pnl)} of "
            f"{format_money(total_premium_pnl)} total selected-premium P&L. "
            f"Excluding {leading_symbol}, the total is {format_money(total_premium_pnl - leading_pnl)}. "
            "Treat the aggregate result as exploratory until it survives a larger sample without a single-name outlier."
        )
    else:
        robustness_text = "No selected option premium path is evaluable yet."
    html = f"""<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>RiskGate scored ideas comparison</title>
<style>
body {{ font-family: Arial, sans-serif; color: #17201c; margin: 34px; background: #fafaf8; }}
h1, h2 {{ margin-bottom: 8px; }}
p {{ max-width: 1120px; line-height: 1.45; }}
.note {{ max-width: 1120px; padding: 14px 16px; background: #fff7ed; border: 1px solid #fed7aa; border-radius: 8px; }}
.definition {{ max-width: 1120px; padding: 14px 16px; background: #ecfeff; border: 1px solid #a5f3fc; border-radius: 8px; margin: 14px 0; }}
table {{ border-collapse: collapse; width: 100%; max-width: 1350px; background: white; margin: 14px 0 28px; }}
th, td {{ border-bottom: 1px solid #e7e5e4; padding: 10px; text-align: left; font-size: 13px; vertical-align: top; }}
th {{ background: #f5f5f4; color: #57534e; font-size: 11px; text-transform: uppercase; }}
small {{ color: #78716c; }}
.chart-scroll {{ overflow-x: auto; max-width: 100%; }}
img {{ background: white; border: 1px solid #e7e5e4; border-radius: 8px; margin: 10px 0 28px; max-height: 620px; }}
</style>
</head>
<body>
<h1>RiskGate Scored Ideas: Signal and Premium Comparison</h1>
<p>All saved ideas scoring <strong>{min_score:g} or higher</strong>, as of <strong>{as_of.astimezone(LOCAL_TZ).strftime('%Y-%m-%d %H:%M %Z')}</strong>. Stock and option history was retrieved from Alpaca using {escape(timeframe)} bars. Score buckets are exclusive: <strong>60-69.9</strong> and <strong>70+</strong>.</p>
<p class="note"><strong>Why the earlier report looked smaller:</strong> {missing_contracts} of {len(rows)} qualifying ideas did not have a saved option contract. Those ideas can be checked against the underlying stock direction, but an option premium cannot be reconstructed honestly without choosing a strike, expiration, spread, and entry quote after the fact. {pending} new ideas have no post-signal market observation yet.</p>
<div class="definition"><strong>Two tests:</strong> Directional stock return asks whether bullish ideas rose or bearish ideas fell after the signal. Premium return asks whether the actual selected long option premium moved favorably; for stored debit spreads, it measures only the saved long leg, not a complete multi-leg spread.</div>
<h2>Comparison by Score Group</h2>
<table>
<thead><tr><th>Score group</th><th>Saved ideas</th><th>Unique stock signals</th><th>Directional wins</th><th>Avg directional return</th><th>Contracts saved</th><th>Unique premium paths</th><th>Premium wins</th><th>Median premium return</th><th>One-contract P&amp;L</th></tr></thead>
<tbody>{''.join(metric_row(summary) for summary in summaries)}</tbody>
</table>
<p class="note"><strong>Robustness warning:</strong> {escape(robustness_text)}</p>
<h2>Directional Follow-through: All Qualifying Signals</h2>
<p>Positive bars mean the stock later moved in the direction predicted by the idea, regardless of whether RiskGate selected an option.</p>
<div class="chart-scroll"><img src="directional_stock_return.svg" alt="Directional stock returns for all qualifying ideas"></div>
<h2>Premium Follow-through: Selected Contracts Only</h2>
<p>Positive bars mean the selected option premium rose after the signal. Duplicate observations of the same contract and same first available entry bar are shown once.</p>
<div class="chart-scroll"><img src="premium_return.svg" alt="Selected option premium returns"></div>
<h2>All Saved Ideas Above Threshold</h2>
<table>
<thead><tr><th>Date</th><th>Idea</th><th>Score</th><th>Directional Stock Return</th><th>Option Contract</th><th>Premium Return</th><th>P&amp;L / Contract</th></tr></thead>
<tbody>{''.join(detail_rows)}</tbody>
</table>
<p><small>Limits: Alpaca historical close bars are observations, not guaranteed executable fills. Option results are for one long contract and deliberately ignore RiskGate position caps. Repeated daily scans can identify the same practical entry; summary metrics deduplicate identical symbol/direction/stock-entry or option-contract/premium-entry pairs.</small></p>
</body>
</html>"""
    path.write_text(html, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Compare all RiskGate ideas above a score threshold using Alpaca stock and selected-option history."
    )
    base = Path(__file__).resolve().parents[2]
    parser.add_argument("--riskgate-db", type=Path, default=base / "prisma" / "dev.db")
    parser.add_argument("--env-file", type=Path, default=base / ".env.local")
    parser.add_argument("--min-score", type=float, default=60)
    parser.add_argument("--as-of", type=str, default=None)
    parser.add_argument("--timeframe", type=str, default="1Hour")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("reports") / "riskgate-scored-ideas-comparison",
    )
    args = parser.parse_args()

    load_dot_env(args.env_file)
    as_of = (
        datetime.fromisoformat(args.as_of).replace(tzinfo=LOCAL_TZ).astimezone(UTC)
        if args.as_of
        else datetime.now(tz=UTC)
    )
    ideas = [
        idea for idea in fetch_ideas(args.riskgate_db) if idea.total_score is not None and score_of(idea) >= args.min_score
    ]
    if not ideas:
        raise RuntimeError(f"No saved RiskGate ideas scored at least {args.min_score:g}.")
    start = min(idea.created_at for idea in ideas) - timedelta(hours=1)
    symbols = sorted({idea.symbol for idea in ideas})
    contracts = sorted({idea.contract_symbol for idea in ideas if idea.contract_symbol})
    stock_bars = fetch_stock_bars(symbols, start, as_of, args.timeframe)
    premium_bars = fetch_option_bars(contracts, start, as_of, args.timeframe)
    premium_outcomes = {outcome.idea.id: outcome for outcome in evaluate_ideas(ideas, premium_bars, as_of)}
    rows: list[ComparisonRow] = []
    for idea in ideas:
        stock_history, stock_entry, stock_latest, directional_return, stock_status = evaluate_stock_direction(
            idea, stock_bars, as_of
        )
        rows.append(
            ComparisonRow(
                idea,
                stock_history,
                stock_entry,
                stock_latest,
                directional_return,
                stock_status,
                premium_outcomes[idea.id],
            )
        )

    high_rows = [row for row in rows if score_of(row.idea) >= 70]
    mid_rows = [row for row in rows if args.min_score <= score_of(row.idea) < 70]
    summaries = [summarize(mid_rows, f"{args.min_score:g}-69.9"), summarize(high_rows, "70+")]
    all_summary = summarize(rows, f"All {args.min_score:g}+")
    summaries.append(all_summary)

    unique_stock = all_summary.unique_stock
    unique_premium = all_summary.unique_premium
    stock_items = [
        (
            f"{row.idea.symbol} {row.idea.created_at.astimezone(LOCAL_TZ).strftime('%m/%d')} {score_of(row.idea):.0f}",
            row.directional_return_percent or 0,
            HIGH_SCORE if score_of(row.idea) >= 70 else MID_SCORE,
        )
        for row in unique_stock
    ]
    premium_items = [
        (
            f"{row.idea.symbol} {row.idea.created_at.astimezone(LOCAL_TZ).strftime('%m/%d')} {score_of(row.idea):.0f}",
            row.premium.return_percent or 0,
            HIGH_SCORE if score_of(row.idea) >= 70 else MID_SCORE,
        )
        for row in unique_premium
    ]
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    bar_chart_svg(
        output_dir / "directional_stock_return.svg",
        "Underlying Return in Predicted Direction",
        stock_items,
        "Directional return (%)",
    )
    bar_chart_svg(
        output_dir / "premium_return.svg",
        "Selected Option Premium Return",
        premium_items,
        "Premium return (%)",
    )
    write_csv(output_dir / "ideas_comparison.csv", rows)
    write_html(output_dir / "report.html", rows, summaries, args.min_score, as_of, args.timeframe)

    print(f"Qualifying ideas scored >= {args.min_score:g}: {len(rows)}")
    print(f"Saved contracts: {sum(1 for row in rows if row.idea.contract_symbol)}")
    for summary in summaries:
        stock_values = [
            row.directional_return_percent
            for row in summary.unique_stock
            if row.directional_return_percent is not None
        ]
        premium_values = [
            row.premium.return_percent
            for row in summary.unique_premium
            if row.premium.return_percent is not None
        ]
        pnl = sum(row.premium.pnl_usd or 0 for row in summary.unique_premium)
        print(
            f"{summary.label:14s} ideas={len(summary.rows):2d} "
            f"stock={len(stock_values):2d} wins={sum(value > 0 for value in stock_values):2d} "
            f"avg={percent_average(stock_values):>7s} "
            f"premiums={len(premium_values):2d} wins={sum(value > 0 for value in premium_values):2d} "
            f"median={percent_median(premium_values):>7s} pnl={format_money(pnl)}"
        )
    print(f"Report: {output_dir / 'report.html'}")


if __name__ == "__main__":
    main()
