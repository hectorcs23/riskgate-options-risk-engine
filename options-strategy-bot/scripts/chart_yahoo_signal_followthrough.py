from __future__ import annotations

import argparse
import csv
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from html import escape
import json
from pathlib import Path
from statistics import median
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

from backtest_riskgate_premiums import Idea, LOCAL_TZ, fetch_ideas, format_percent
from compare_scored_ideas import bar_chart_svg


COLORS = [
    "#0f766e",
    "#2563eb",
    "#b45309",
    "#be123c",
    "#6d28d9",
    "#15803d",
    "#0e7490",
    "#c2410c",
    "#4338ca",
    "#9f1239",
]


@dataclass(frozen=True)
class DailyPrice:
    day: date
    adjusted_close: float


@dataclass(frozen=True)
class SignalPath:
    idea: Idea
    prices: tuple[DailyPrice, ...]
    entry: DailyPrice | None
    latest: DailyPrice | None
    actual_return_percent: float | None
    directional_return_percent: float | None
    status: str


def score(idea: Idea) -> float:
    return idea.total_score if idea.total_score is not None else 0.0


def yahoo_daily_prices(symbol: str, start: date, end: date) -> list[DailyPrice]:
    start_timestamp = int(datetime.combine(start, time.min, tzinfo=LOCAL_TZ).timestamp())
    end_timestamp = int(datetime.combine(end + timedelta(days=1), time.min, tzinfo=LOCAL_TZ).timestamp())
    params = urlencode(
        {
            "period1": str(start_timestamp),
            "period2": str(end_timestamp),
            "interval": "1d",
            "events": "history",
            "includePrePost": "false",
        }
    )
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{quote(symbol)}?{params}"
    request = Request(url, headers={"User-Agent": "RiskGate research follow-through/1.0"})
    try:
        with urlopen(request, timeout=40) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Yahoo Finance returned HTTP {error.code} for {symbol}: {body[:180]}") from error
    except URLError as error:
        raise RuntimeError(f"Yahoo Finance connection failed for {symbol}: {error.reason}") from error
    chart = payload.get("chart") or {}
    if chart.get("error"):
        raise RuntimeError(f"Yahoo Finance returned an error for {symbol}: {chart['error']}")
    results = chart.get("result") or []
    if not results:
        return []
    result = results[0]
    timestamps = result.get("timestamp") or []
    indicators = result.get("indicators") or {}
    adjusted = (indicators.get("adjclose") or [{}])[0].get("adjclose") or []
    closes = (indicators.get("quote") or [{}])[0].get("close") or []
    prices: list[DailyPrice] = []
    for index, timestamp in enumerate(timestamps):
        value = adjusted[index] if index < len(adjusted) else None
        if value is None and index < len(closes):
            value = closes[index]
        if value is None or float(value) <= 0:
            continue
        day = datetime.fromtimestamp(timestamp, tz=LOCAL_TZ).date()
        prices.append(DailyPrice(day, float(value)))
    return prices


def evaluate_signal(idea: Idea, prices_by_symbol: dict[str, list[DailyPrice]]) -> SignalPath:
    signal_day = idea.created_at.astimezone(LOCAL_TZ).date()
    post_signal = tuple(price for price in prices_by_symbol.get(idea.symbol, []) if price.day > signal_day)
    if not post_signal:
        return SignalPath(idea, (), None, None, None, None, "No completed trading session after signal")
    entry = post_signal[0]
    latest = post_signal[-1]
    if latest.day == entry.day:
        return SignalPath(idea, post_signal, entry, latest, None, None, "Baseline session only")
    actual_return = ((latest.adjusted_close / entry.adjusted_close) - 1) * 100
    if idea.direction == "bullish":
        directional_return = actual_return
    elif idea.direction == "bearish":
        directional_return = -actual_return
    else:
        return SignalPath(idea, post_signal, entry, latest, actual_return, None, "Neutral idea excluded")
    return SignalPath(idea, post_signal, entry, latest, actual_return, directional_return, "Evaluable")


def deduplicate(paths: list[SignalPath]) -> list[SignalPath]:
    chosen: dict[tuple[str, str, date | None], SignalPath] = {}
    for path in paths:
        key = (path.idea.symbol, path.idea.direction, path.entry.day if path.entry else None)
        current = chosen.get(key)
        if current is None or score(path.idea) > score(current.idea):
            chosen[key] = path
    return sorted(chosen.values(), key=lambda path: (path.entry.day if path.entry else date.max, path.idea.symbol))


def score_band(path: SignalPath) -> str:
    return "70+" if score(path.idea) >= 70 else "60-69.9"


def path_points(path: SignalPath) -> list[tuple[date, float]]:
    if not path.entry:
        return []
    return [
        (price.day, ((price.adjusted_close / path.entry.adjusted_close) - 1) * 100)
        for price in path.prices
    ]


def line_chart_svg(
    output: Path,
    title: str,
    subtitle: str,
    paths: list[SignalPath],
    success_note: str,
) -> None:
    series = [(path, path_points(path)) for path in paths if path.status == "Evaluable"]
    width = 1180
    legend_rows = max(1, (len(series) + 3) // 4)
    height = 510 + legend_rows * 26
    left, right, top, bottom = 82, 28, 76, 76 + legend_rows * 26
    chart_width = width - left - right
    chart_height = height - top - bottom
    all_points = [point for _, points in series for point in points]
    lines = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        '<rect width="100%" height="100%" fill="#ffffff"/>',
        f'<text x="{left}" y="30" font-family="Arial" font-size="22" font-weight="700" fill="#17201c">{escape(title)}</text>',
        f'<text x="{left}" y="54" font-family="Arial" font-size="13" fill="#57534e">{escape(subtitle)}</text>',
    ]
    if not all_points:
        lines.append(
            f'<text x="{left}" y="108" font-family="Arial" font-size="16" fill="#57534e">No evaluable signals.</text>'
        )
        lines.append("</svg>")
        output.write_text("\n".join(lines), encoding="utf-8")
        return
    first_day = min(day for day, _ in all_points)
    last_day = max(day for day, _ in all_points)
    values = [value for _, value in all_points]
    low = min(min(values), 0)
    high = max(max(values), 0)
    spread = max(high - low, 1)
    low -= spread * 0.12
    high += spread * 0.12
    span = max((last_day - first_day).days, 1)

    def x_value(day: date) -> float:
        return left + ((day - first_day).days / span) * chart_width

    def y_value(value: float) -> float:
        return top + (high - value) / (high - low) * chart_height

    for tick in range(6):
        value = low + ((high - low) * tick / 5)
        y = y_value(value)
        lines.extend(
            [
                f'<line x1="{left}" y1="{y:.2f}" x2="{width - right}" y2="{y:.2f}" stroke="#e7e5e4"/>',
                f'<text x="{left - 9}" y="{y + 4:.2f}" text-anchor="end" font-family="Arial" font-size="12" fill="#78716c">{value:+.1f}%</text>',
            ]
        )
    zero_y = y_value(0)
    lines.append(
        f'<line x1="{left}" y1="{zero_y:.2f}" x2="{width - right}" y2="{zero_y:.2f}" stroke="#57534e" stroke-width="1.5"/>'
    )
    for tick in range(span + 1):
        day = first_day + timedelta(days=tick)
        if day.weekday() < 5:
            x = x_value(day)
            lines.append(
                f'<text x="{x:.2f}" y="{top + chart_height + 24}" text-anchor="middle" font-family="Arial" font-size="12" fill="#78716c">{day.strftime("%b %d")}</text>'
            )
    for index, (path, points) in enumerate(series):
        color = COLORS[index % len(COLORS)]
        dash = "" if score(path.idea) >= 70 else ' stroke-dasharray="6 4"'
        coordinates = " ".join(f"{x_value(day):.2f},{y_value(value):.2f}" for day, value in points)
        lines.append(
            f'<polyline points="{coordinates}" fill="none" stroke="{color}" stroke-width="2.7"{dash}/>'
        )
        end_day, end_value = points[-1]
        lines.append(f'<circle cx="{x_value(end_day):.2f}" cy="{y_value(end_value):.2f}" r="3.3" fill="{color}"/>')
        legend_x = left + (index % 4) * 264
        legend_y = height - 50 - (index // 4) * 25
        label = (
            f"{path.idea.symbol} {path.entry.day.strftime('%m/%d')} "
            f"S{score(path.idea):.0f} ({path.actual_return_percent:+.1f}%)"
        )
        lines.extend(
            [
                f'<line x1="{legend_x}" y1="{legend_y}" x2="{legend_x + 21}" y2="{legend_y}" stroke="{color}" stroke-width="3"{dash}/>',
                f'<text x="{legend_x + 27}" y="{legend_y + 4}" font-family="Arial" font-size="12" fill="#44403c">{escape(label)}</text>',
            ]
        )
    lines.append(
        f'<text x="{left}" y="{height - 13}" font-family="Arial" font-size="12" fill="#57534e">{escape(success_note)} Solid line: score 70+. Dashed line: score 60-69.9.</text>'
    )
    lines.append("</svg>")
    output.write_text("\n".join(lines), encoding="utf-8")


def band_metrics(paths: list[SignalPath], band: str) -> str:
    selected = [path for path in paths if score_band(path) == band and path.directional_return_percent is not None]
    values = [path.directional_return_percent for path in selected if path.directional_return_percent is not None]
    wins = sum(value > 0 for value in values)
    average = sum(values) / len(values) if values else None
    middle = median(values) if values else None
    return (
        "<tr>"
        f"<td><strong>{escape(band)}</strong></td>"
        f"<td>{len(selected)}</td>"
        f"<td>{wins}/{len(values)} ({(wins / len(values) * 100 if values else 0):.1f}%)</td>"
        f"<td>{format_percent(average)}</td>"
        f"<td>{format_percent(middle)}</td>"
        "</tr>"
    )


def write_csv(output: Path, all_paths: list[SignalPath]) -> None:
    with output.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            [
                "signal_date",
                "symbol",
                "direction",
                "score",
                "decision",
                "baseline_date",
                "baseline_adjusted_close",
                "latest_date",
                "latest_adjusted_close",
                "actual_stock_return_percent",
                "directional_return_percent",
                "status",
            ]
        )
        for path in sorted(all_paths, key=lambda result: result.idea.created_at):
            writer.writerow(
                [
                    path.idea.created_at.astimezone(LOCAL_TZ).date().isoformat(),
                    path.idea.symbol,
                    path.idea.direction,
                    score(path.idea),
                    path.idea.decision or "",
                    path.entry.day.isoformat() if path.entry else "",
                    round(path.entry.adjusted_close, 4) if path.entry else "",
                    path.latest.day.isoformat() if path.latest else "",
                    round(path.latest.adjusted_close, 4) if path.latest else "",
                    round(path.actual_return_percent, 3) if path.actual_return_percent is not None else "",
                    round(path.directional_return_percent, 3)
                    if path.directional_return_percent is not None
                    else "",
                    path.status,
                ]
            )


def write_report(
    output: Path,
    min_score: float,
    as_of: date,
    all_paths: list[SignalPath],
    chart_paths: list[SignalPath],
) -> None:
    bullish = [path for path in chart_paths if path.idea.direction == "bullish"]
    bearish = [path for path in chart_paths if path.idea.direction == "bearish"]
    pending = sum(path.status != "Evaluable" for path in all_paths)
    rows = []
    for path in sorted(chart_paths, key=lambda result: (score(result.idea), result.idea.symbol), reverse=True):
        successful = (
            "Correct"
            if path.directional_return_percent is not None and path.directional_return_percent > 0
            else "Incorrect"
            if path.directional_return_percent is not None
            else "Pending"
        )
        rows.append(
            "<tr>"
            f"<td>{path.idea.created_at.astimezone(LOCAL_TZ).date().isoformat()}</td>"
            f"<td><strong>{escape(path.idea.symbol)}</strong></td>"
            f"<td>{escape(path.idea.direction)}</td>"
            f"<td>{score(path.idea):.1f}</td>"
            f"<td>{path.entry.day.isoformat() if path.entry else '-'}</td>"
            f"<td>{path.latest.day.isoformat() if path.latest else '-'}</td>"
            f"<td>{format_percent(path.actual_return_percent)}</td>"
            f"<td>{escape(successful)}</td>"
            "</tr>"
        )
    html = f"""<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>RiskGate Yahoo Finance signal follow-through</title>
<style>
body {{ margin: 34px; background: #fafaf8; color: #17201c; font-family: Arial, sans-serif; }}
h1, h2 {{ margin-bottom: 8px; }}
p {{ max-width: 1160px; line-height: 1.45; }}
.note {{ max-width: 1160px; border: 1px solid #a5f3fc; background: #ecfeff; border-radius: 8px; padding: 14px 16px; }}
table {{ border-collapse: collapse; background: white; width: 100%; max-width: 1180px; margin: 18px 0 30px; }}
th, td {{ border-bottom: 1px solid #e7e5e4; padding: 10px; text-align: left; font-size: 13px; }}
th {{ background: #f5f5f4; color: #57534e; text-transform: uppercase; font-size: 11px; }}
.chart {{ overflow-x: auto; margin: 10px 0 28px; }}
img {{ border: 1px solid #e7e5e4; border-radius: 8px; background: white; max-width: none; }}
small {{ color: #78716c; }}
</style>
</head>
<body>
<h1>RiskGate Direction Follow-through Using Yahoo Finance</h1>
<p>Saved RiskGate ideas with scores of <strong>{min_score:g} or higher</strong>, evaluated through <strong>{as_of.isoformat()}</strong> using Yahoo Finance daily adjusted closing prices.</p>
<p class="note"><strong>Fair baseline:</strong> each path begins at the first completed trading-session close after the signal date. For bullish ideas, rising lines support the signal. For bearish ideas, falling lines support the signal. Repeated signals for the same ticker, direction, and baseline date are shown once, retaining the higher score. {pending} stored ideas are not yet evaluable because they have no later completed session.</p>
<h2>Directional Summary</h2>
<table>
<thead><tr><th>Score group</th><th>Unique signals</th><th>Correct direction</th><th>Average directional return</th><th>Median directional return</th></tr></thead>
<tbody>{band_metrics(chart_paths, "60-69.9")}{band_metrics(chart_paths, "70+")}</tbody>
</table>
<h2>Bullish Signals: Actual Stock Movement After Marking</h2>
<p>A line finishing above zero means the stock price increased after RiskGate marked it bullish.</p>
<div class="chart"><img src="bullish_after_signal.svg" alt="Bullish ideas stock movement after signal"></div>
<h2>Bearish Signals: Actual Stock Movement After Marking</h2>
<p>A line finishing below zero means the stock price decreased after RiskGate marked it bearish.</p>
<div class="chart"><img src="bearish_after_signal.svg" alt="Bearish ideas stock movement after signal"></div>
<h2>Correct-Direction Comparison</h2>
<p>For this chart only, bearish price declines are flipped positive so every green bar represents a move in the predicted direction.</p>
<div class="chart"><img src="directional_outcomes.svg" alt="Directional outcome comparison"></div>
<h2>Signals Used In Charts</h2>
<table>
<thead><tr><th>Signal Date</th><th>Ticker</th><th>Direction</th><th>Score</th><th>Baseline</th><th>Latest</th><th>Actual Price Move</th><th>Direction Result</th></tr></thead>
<tbody>{''.join(rows)}</tbody>
</table>
<p><small>Yahoo Finance adjusted closing prices measure underlying movement, not option execution. This report answers whether direction was useful; it does not test Greeks, volatility crush, theta decay, bid/ask spread, or chosen strikes and expirations.</small></p>
</body>
</html>"""
    output.write_text(html, encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Graph post-signal stock movement for RiskGate ideas using Yahoo Finance daily prices."
    )
    base = Path(__file__).resolve().parents[2]
    parser.add_argument("--riskgate-db", type=Path, default=base / "prisma" / "dev.db")
    parser.add_argument("--min-score", type=float, default=60)
    parser.add_argument("--as-of", type=str, default=None)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("reports") / "riskgate-yahoo-direction-followthrough",
    )
    args = parser.parse_args()
    as_of = date.fromisoformat(args.as_of) if args.as_of else datetime.now(tz=LOCAL_TZ).date()
    ideas = [
        idea
        for idea in fetch_ideas(args.riskgate_db)
        if idea.total_score is not None
        and score(idea) >= args.min_score
        and idea.direction in {"bullish", "bearish"}
    ]
    if not ideas:
        raise RuntimeError(f"No bullish or bearish ideas scored at least {args.min_score:g}.")
    start = min(idea.created_at.astimezone(LOCAL_TZ).date() for idea in ideas)
    prices_by_symbol = {
        symbol: yahoo_daily_prices(symbol, start, as_of)
        for symbol in sorted({idea.symbol for idea in ideas})
    }
    all_paths = [evaluate_signal(idea, prices_by_symbol) for idea in ideas]
    chart_paths = [path for path in deduplicate(all_paths) if path.status == "Evaluable"]
    bullish = [path for path in chart_paths if path.idea.direction == "bullish"]
    bearish = [path for path in chart_paths if path.idea.direction == "bearish"]
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    line_chart_svg(
        output_dir / "bullish_after_signal.svg",
        "Bullish Signals: Yahoo Adjusted Close After Signal",
        "Percentage price move from first completed session after each bullish signal",
        bullish,
        "A finish above 0% supports a bullish call.",
    )
    line_chart_svg(
        output_dir / "bearish_after_signal.svg",
        "Bearish Signals: Yahoo Adjusted Close After Signal",
        "Percentage price move from first completed session after each bearish signal",
        bearish,
        "A finish below 0% supports a bearish call.",
    )
    outcome_items = [
        (
            f"{path.idea.symbol} {path.idea.direction[0].upper()} {path.entry.day.strftime('%m/%d')} S{score(path.idea):.0f}",
            path.directional_return_percent or 0,
            "#0f766e" if score(path.idea) >= 70 else "#2563eb",
        )
        for path in sorted(chart_paths, key=lambda result: result.directional_return_percent or 0, reverse=True)
    ]
    bar_chart_svg(
        output_dir / "directional_outcomes.svg",
        "Movement in Predicted Direction",
        outcome_items,
        "Directional return (%)",
    )
    write_csv(output_dir / "yahoo_signal_followthrough.csv", all_paths)
    write_report(output_dir / "report.html", args.min_score, as_of, all_paths, chart_paths)
    print(f"Saved qualifying signals: {len(ideas)}")
    print(f"Unique evaluable chart paths: {len(chart_paths)} ({len(bullish)} bullish, {len(bearish)} bearish)")
    for band in ("60-69.9", "70+"):
        selected = [path for path in chart_paths if score_band(path) == band]
        values = [
            path.directional_return_percent
            for path in selected
            if path.directional_return_percent is not None
        ]
        winners = sum(value > 0 for value in values)
        average = sum(values) / len(values) if values else None
        print(f"{band:8s}: {winners}/{len(values)} correct, average directional return {format_percent(average)}")
    print(f"Report: {output_dir / 'report.html'}")


if __name__ == "__main__":
    main()
