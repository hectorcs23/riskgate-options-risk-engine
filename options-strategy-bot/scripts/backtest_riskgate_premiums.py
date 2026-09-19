from __future__ import annotations

import argparse
import csv
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from html import escape
import json
import os
from pathlib import Path
import sqlite3
from typing import Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo


LOCAL_TZ = ZoneInfo("America/Mexico_City")
UTC = timezone.utc
COLORS = ["#0f766e", "#1d4ed8", "#b45309", "#be123c", "#6d28d9", "#166534"]


@dataclass(frozen=True)
class Idea:
    id: str
    symbol: str
    direction: str
    strategy: str
    contract_symbol: str | None
    option_type: str | None
    strike_price: float | None
    expiration_date: datetime | None
    stored_mid: float | None
    total_score: float | None
    decision: str | None
    created_at: datetime


@dataclass(frozen=True)
class Bar:
    timestamp: datetime
    open: float
    high: float
    low: float
    close: float
    volume: float | None


@dataclass(frozen=True)
class Outcome:
    idea: Idea
    bars: tuple[Bar, ...]
    entry_bar: Bar | None
    latest_bar: Bar | None
    pnl_usd: float | None
    return_percent: float | None
    status: str


def load_dot_env(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        name, value = stripped.split("=", 1)
        name = name.strip()
        if name and name not in os.environ:
            os.environ[name] = value.strip().strip('"').strip("'")


def from_db_timestamp(value: int | float | None) -> datetime | None:
    if value is None:
        return None
    return datetime.fromtimestamp(float(value) / 1000, tz=UTC)


def fetch_ideas(db_path: Path) -> list[Idea]:
    connection = sqlite3.connect(f"file:{db_path.as_posix()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    rows = connection.execute(
        """
        SELECT id, symbol, direction, strategy, optionContractSymbol, optionType,
               strikePrice, expirationDate, contractMid, totalScore, decision, createdAt
        FROM TradeIdea
        ORDER BY createdAt DESC
        """
    ).fetchall()
    connection.close()
    ideas: list[Idea] = []
    for row in rows:
        created_at = from_db_timestamp(row["createdAt"])
        if created_at is None:
            continue
        ideas.append(
            Idea(
                id=row["id"],
                symbol=row["symbol"],
                direction=row["direction"],
                strategy=row["strategy"],
                contract_symbol=row["optionContractSymbol"],
                option_type=row["optionType"],
                strike_price=row["strikePrice"],
                expiration_date=from_db_timestamp(row["expirationDate"]),
                stored_mid=row["contractMid"],
                total_score=row["totalScore"],
                decision=row["decision"],
                created_at=created_at
            )
        )
    return ideas


def local_day(value: datetime) -> date:
    return value.astimezone(LOCAL_TZ).date()


def group_batches(ideas: list[Idea]) -> dict[date, list[Idea]]:
    batches: dict[date, list[Idea]] = {}
    for idea in ideas:
        batches.setdefault(local_day(idea.created_at), []).append(idea)
    return batches


def api_headers() -> dict[str, str]:
    key = os.getenv("APCA_API_KEY_ID")
    secret = os.getenv("APCA_API_SECRET_KEY")
    if not key or not secret:
        raise RuntimeError("Missing APCA_API_KEY_ID or APCA_API_SECRET_KEY in the configured environment file.")
    return {
        "Accept": "application/json",
        "APCA-API-KEY-ID": key,
        "APCA-API-SECRET-KEY": secret
    }


def alpaca_json(path: str, params: dict[str, str], include_feed: bool = False) -> dict:
    effective = dict(params)
    if include_feed:
        effective["feed"] = os.getenv("ALPACA_DATA_FEED", "indicative")
    url = f"https://data.alpaca.markets{path}?{urlencode(effective)}"
    request = Request(url, headers=api_headers())
    try:
        with urlopen(request, timeout=45) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Alpaca returned HTTP {error.code}: {body[:240]}") from error
    except URLError as error:
        raise RuntimeError(f"Alpaca connection failed: {error.reason}") from error


def parse_bar(raw: dict) -> Bar:
    stamp = raw.get("t")
    if isinstance(stamp, str):
        timestamp = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    else:
        timestamp = datetime.now(tz=UTC)
    return Bar(
        timestamp=timestamp,
        open=float(raw.get("o", 0)),
        high=float(raw.get("h", 0)),
        low=float(raw.get("l", 0)),
        close=float(raw.get("c", 0)),
        volume=float(raw["v"]) if raw.get("v") is not None else None
    )


def fetch_option_bars(
    contract_symbols: list[str],
    start: datetime,
    end: datetime,
    timeframe: str,
    allow_delayed_retry: bool = True
) -> dict[str, list[Bar]]:
    results: dict[str, list[Bar]] = {symbol: [] for symbol in contract_symbols}
    if not contract_symbols:
        return results
    page_token: str | None = None
    while True:
        params: dict[str, str] = {
            "symbols": ",".join(contract_symbols),
            "timeframe": timeframe,
            "start": start.astimezone(UTC).isoformat().replace("+00:00", "Z"),
            "end": end.astimezone(UTC).isoformat().replace("+00:00", "Z"),
            "limit": "10000",
            "sort": "asc"
        }
        if page_token:
            params["page_token"] = page_token
        try:
            payload = alpaca_json("/v1beta1/options/bars", params)
        except RuntimeError as error:
            if allow_delayed_retry and "OPRA agreement is not signed" in str(error):
                return fetch_option_bars_delayed_default(contract_symbols, start, timeframe)
            raise
        for symbol, raw_bars in (payload.get("bars") or {}).items():
            results.setdefault(symbol, []).extend(parse_bar(raw) for raw in raw_bars)
        page_token = payload.get("next_page_token")
        if not page_token:
            break
    for symbol in results:
        results[symbol].sort(key=lambda bar: bar.timestamp)
    return results


def fetch_option_bars_delayed_default(
    contract_symbols: list[str],
    start: datetime,
    timeframe: str
) -> dict[str, list[Bar]]:
    results: dict[str, list[Bar]] = {symbol: [] for symbol in contract_symbols}
    page_token: str | None = None
    while True:
        params = {
            "symbols": ",".join(contract_symbols),
            "timeframe": timeframe,
            "start": start.astimezone(UTC).isoformat().replace("+00:00", "Z"),
            "limit": "10000",
            "sort": "asc"
        }
        if page_token:
            params["page_token"] = page_token
        payload = alpaca_json("/v1beta1/options/bars", params)
        for symbol, raw_bars in (payload.get("bars") or {}).items():
            results.setdefault(symbol, []).extend(parse_bar(raw) for raw in raw_bars)
        page_token = payload.get("next_page_token")
        if not page_token:
            break
    for symbol in results:
        results[symbol].sort(key=lambda bar: bar.timestamp)
    return results


def evaluate_ideas(ideas: list[Idea], bars_by_symbol: dict[str, list[Bar]], as_of: datetime) -> list[Outcome]:
    outcomes: list[Outcome] = []
    for idea in ideas:
        if not idea.contract_symbol:
            outcomes.append(Outcome(idea, (), None, None, None, None, "No option contract selected by RiskGate"))
            continue
        eligible = tuple(
            bar
            for bar in bars_by_symbol.get(idea.contract_symbol, [])
            if bar.timestamp >= idea.created_at and bar.timestamp <= as_of and bar.close > 0
        )
        if not eligible:
            outcomes.append(Outcome(idea, (), None, None, None, None, "No premium bars after idea creation"))
            continue
        entry = eligible[0]
        latest = eligible[-1]
        pnl_usd = (latest.close - entry.close) * 100
        change = ((latest.close / entry.close) - 1) * 100 if entry.close else None
        status = "Evaluable" if len(eligible) >= 2 and latest.timestamp > entry.timestamp else "Entry observed; no later mark"
        outcomes.append(Outcome(idea, eligible, entry, latest, pnl_usd, change, status))
    return outcomes


def format_money(value: float | None) -> str:
    return "-" if value is None else f"${value:,.2f}"


def format_percent(value: float | None) -> str:
    return "-" if value is None else f"{value:+.1f}%"


def chart_svg(
    path: Path,
    title: str,
    series: list[tuple[str, list[tuple[datetime, float]]]],
    ylabel: str
) -> None:
    width = 1120
    height = 560
    left = 88
    right = 28
    top = 62
    bottom = 74
    chart_width = width - left - right
    chart_height = height - top - bottom
    all_points = [point for _, points in series for point in points]
    if not all_points:
        path.write_text(
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}">'
            f'<rect width="100%" height="100%" fill="#ffffff"/>'
            f'<text x="40" y="55" font-family="Arial" font-size="24" fill="#17201c">{escape(title)}</text>'
            '<text x="40" y="108" font-family="Arial" font-size="16" fill="#57534e">No premium data returned.</text>'
            "</svg>",
            encoding="utf-8"
        )
        return

    min_time = min(point[0] for point in all_points)
    max_time = max(point[0] for point in all_points)
    values = [point[1] for point in all_points]
    minimum = min(values)
    maximum = max(values)
    if minimum == maximum:
        minimum -= 1
        maximum += 1
    padding = (maximum - minimum) * 0.12
    minimum -= padding
    maximum += padding
    duration = max((max_time - min_time).total_seconds(), 1)

    def x_value(stamp: datetime) -> float:
        return left + ((stamp - min_time).total_seconds() / duration) * chart_width

    def y_value(value: float) -> float:
        return top + (maximum - value) / (maximum - minimum) * chart_height

    lines = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">',
        '<rect width="100%" height="100%" fill="#ffffff"/>',
        f'<text x="{left}" y="34" font-family="Arial" font-size="23" font-weight="700" fill="#17201c">{escape(title)}</text>',
        f'<text x="22" y="{top + chart_height / 2:.0f}" transform="rotate(-90 22 {top + chart_height / 2:.0f})" font-family="Arial" font-size="13" fill="#57534e">{escape(ylabel)}</text>'
    ]
    for tick in range(6):
        y = top + chart_height * tick / 5
        value = maximum - (maximum - minimum) * tick / 5
        lines.extend(
            [
                f'<line x1="{left}" y1="{y:.2f}" x2="{width - right}" y2="{y:.2f}" stroke="#e7e5e4" stroke-width="1"/>',
                f'<text x="{left - 10}" y="{y + 5:.2f}" text-anchor="end" font-family="Arial" font-size="12" fill="#78716c">{value:,.1f}</text>'
            ]
        )
    for tick in range(5):
        x = left + chart_width * tick / 4
        stamp = min_time + (max_time - min_time) * (tick / 4)
        lines.append(
            f'<text x="{x:.2f}" y="{height - 40}" text-anchor="middle" font-family="Arial" font-size="12" fill="#78716c">{stamp.astimezone(LOCAL_TZ).strftime("%b %d")}</text>'
        )
    legend_x = left
    for index, (label, points) in enumerate(series):
        color = COLORS[index % len(COLORS)]
        if points:
            polyline = " ".join(f"{x_value(stamp):.2f},{y_value(value):.2f}" for stamp, value in points)
            lines.append(f'<polyline points="{polyline}" fill="none" stroke="{color}" stroke-width="2.6"/>')
            for stamp, value in (points[0], points[-1]):
                lines.append(f'<circle cx="{x_value(stamp):.2f}" cy="{y_value(value):.2f}" r="3.5" fill="{color}"/>')
        lines.extend(
            [
                f'<line x1="{legend_x}" y1="{height - 15}" x2="{legend_x + 22}" y2="{height - 15}" stroke="{color}" stroke-width="3"/>',
                f'<text x="{legend_x + 29}" y="{height - 10}" font-family="Arial" font-size="12" fill="#44403c">{escape(label)}</text>'
            ]
        )
        legend_x += 190
    lines.append("</svg>")
    path.write_text("\n".join(lines), encoding="utf-8")


def write_results_csv(path: Path, outcomes: list[Outcome]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(
            [
                "symbol",
                "strategy",
                "contract",
                "idea_created_local",
                "score",
                "decision",
                "entry_timestamp",
                "entry_premium_usd",
                "latest_timestamp",
                "latest_premium_usd",
                "return_percent",
                "long_contract_pnl_usd",
                "status"
            ]
        )
        for outcome in outcomes:
            writer.writerow(
                [
                    outcome.idea.symbol,
                    outcome.idea.strategy,
                    outcome.idea.contract_symbol or "",
                    outcome.idea.created_at.astimezone(LOCAL_TZ).isoformat(),
                    outcome.idea.total_score,
                    outcome.idea.decision or "",
                    outcome.entry_bar.timestamp.isoformat() if outcome.entry_bar else "",
                    outcome.entry_bar.close if outcome.entry_bar else "",
                    outcome.latest_bar.timestamp.isoformat() if outcome.latest_bar else "",
                    outcome.latest_bar.close if outcome.latest_bar else "",
                    round(outcome.return_percent, 3) if outcome.return_percent is not None else "",
                    round(outcome.pnl_usd, 2) if outcome.pnl_usd is not None else "",
                    outcome.status
                ]
            )


def write_html_report(
    path: Path,
    batch_day: date,
    newest_day: date,
    as_of: datetime,
    timeframe: str,
    outcomes: list[Outcome],
    newest_batch: list[Idea],
    data_note: str
) -> None:
    total_pnl = sum(outcome.pnl_usd for outcome in outcomes if outcome.status == "Evaluable" and outcome.pnl_usd is not None)
    evaluated = [outcome for outcome in outcomes if outcome.status == "Evaluable"]
    winners = [outcome for outcome in evaluated if (outcome.pnl_usd or 0) > 0]
    rows = []
    for outcome in outcomes:
        idea = outcome.idea
        score_text = f"{idea.total_score:.1f}" if idea.total_score is not None else "-"
        rows.append(
            "<tr>"
            f"<td><strong>{escape(idea.symbol)}</strong><br><small>{escape(idea.strategy)}</small></td>"
            f"<td>{escape(idea.contract_symbol or '-')}</td>"
            f"<td>{score_text}</td><td>{escape(idea.decision or '-')}</td>"
            f"<td>{format_money(outcome.entry_bar.close if outcome.entry_bar else None)}</td>"
            f"<td>{format_money(outcome.latest_bar.close if outcome.latest_bar else None)}</td>"
            f"<td>{format_percent(outcome.return_percent)}</td>"
            f"<td>{format_money(outcome.pnl_usd)}</td>"
            f"<td>{escape(outcome.status)}</td></tr>"
        )
    newest_note = (
        f"The newest saved batch is {newest_day.isoformat()} with {len(newest_batch)} ideas. "
        "It was created after the most recent completed market session, so no honest post-entry performance exists for it yet."
        if newest_day > batch_day
        else "This is the newest batch with post-entry pricing available."
    )
    html = f"""<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>RiskGate premium backtest - {batch_day.isoformat()}</title>
<style>
body {{ font-family: Arial, sans-serif; color: #17201c; margin: 34px; background: #fafaf8; }}
h1, h2 {{ margin-bottom: 8px; }}
.note {{ background: #fff7ed; border: 1px solid #fed7aa; padding: 14px; border-radius: 8px; max-width: 1100px; }}
.stats {{ display: flex; gap: 12px; margin: 22px 0; }}
.stat {{ background: white; border: 1px solid #e7e5e4; padding: 13px; border-radius: 8px; min-width: 160px; }}
.label {{ font-size: 12px; color: #78716c; text-transform: uppercase; font-weight: bold; }}
.value {{ font-size: 24px; font-weight: bold; margin-top: 5px; }}
img {{ max-width: 1120px; width: 100%; background: white; border: 1px solid #e7e5e4; border-radius: 8px; margin: 12px 0 24px; }}
table {{ border-collapse: collapse; width: 100%; max-width: 1300px; background: white; }}
th, td {{ border-bottom: 1px solid #e7e5e4; padding: 10px; text-align: left; font-size: 13px; }}
th {{ background: #f5f5f4; color: #57534e; text-transform: uppercase; font-size: 11px; }}
small {{ color: #78716c; }}
</style>
</head>
<body>
<h1>RiskGate Ideas: Actual Option Premium Follow-up</h1>
<p>Evaluated batch: <strong>{batch_day.isoformat()}</strong>. As of: <strong>{as_of.astimezone(LOCAL_TZ).strftime("%Y-%m-%d %H:%M %Z")}</strong>. Alpaca timeframe: {escape(timeframe)}. Data mode: {escape(data_note)}.</p>
<p class="note">{escape(newest_note)} Premium results below ignore position-size caps as requested and assume purchasing one option contract at the first available Alpaca closing bar after the idea was created.</p>
<div class="stats">
<div class="stat"><div class="label">Evaluated contracts</div><div class="value">{len(evaluated)}</div></div>
<div class="stat"><div class="label">Winners</div><div class="value">{len(winners)}</div></div>
<div class="stat"><div class="label">Win rate</div><div class="value">{(len(winners) / len(evaluated) * 100 if evaluated else 0):.1f}%</div></div>
<div class="stat"><div class="label">1 contract total</div><div class="value">{format_money(total_pnl)}</div></div>
</div>
<h2>Premium Return Since Entry</h2>
<img src="premium_return_percent.svg" alt="Premium percentage return paths">
<h2>Premium Price Per Contract</h2>
<img src="premium_prices.svg" alt="Option premium price paths">
<h2>Outcome Table</h2>
<table>
<thead><tr><th>Idea</th><th>Contract</th><th>Score</th><th>Decision</th><th>Entry Premium</th><th>Latest Premium</th><th>Return</th><th>P&amp;L / Contract</th><th>Status</th></tr></thead>
<tbody>{''.join(rows)}</tbody>
</table>
<p><small>Interpretation warning: historical bars are closing premium observations, not guaranteed executable fills. This report measures whether selected premiums moved favorably, not whether each entry and exit could be filled at that price.</small></p>
</body>
</html>"""
    path.write_text(html, encoding="utf-8")


def find_latest_evaluable_batch(
    batches: dict[date, list[Idea]],
    as_of: datetime,
    timeframe: str
) -> tuple[date, list[Idea], dict[str, list[Bar]]]:
    for batch_day in sorted(batches.keys(), reverse=True):
        ideas = batches[batch_day]
        contracts = [idea.contract_symbol for idea in ideas if idea.contract_symbol]
        if not contracts:
            continue
        start = min(idea.created_at for idea in ideas) - timedelta(hours=1)
        bars = fetch_option_bars(contracts, start, as_of, timeframe)
        outcomes = evaluate_ideas(ideas, bars, as_of)
        if any(outcome.status == "Evaluable" for outcome in outcomes):
            return batch_day, ideas, bars
    raise RuntimeError("No batch has at least one idea with post-entry option premium bars through the selected as-of time.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Backtest RiskGate saved option ideas using Alpaca premium bars.")
    base = Path(__file__).resolve().parents[2]
    parser.add_argument("--riskgate-db", type=Path, default=base / "prisma" / "dev.db")
    parser.add_argument("--env-file", type=Path, default=base / ".env.local")
    parser.add_argument("--batch-date", type=str, default=None)
    parser.add_argument("--as-of", type=str, default=None)
    parser.add_argument("--timeframe", type=str, default="1Hour")
    parser.add_argument("--output-dir", type=Path, default=Path("reports") / "riskgate-premium-follow-up")
    args = parser.parse_args()

    load_dot_env(args.env_file)
    ideas = fetch_ideas(args.riskgate_db)
    batches = group_batches(ideas)
    if not batches:
        raise RuntimeError("No RiskGate trade ideas were found in the database.")

    as_of = (
        datetime.fromisoformat(args.as_of).replace(tzinfo=LOCAL_TZ).astimezone(UTC)
        if args.as_of
        else datetime.now(tz=UTC)
    )
    newest_day = max(batches.keys())
    newest_batch = batches[newest_day]
    if args.batch_date:
        batch_day = date.fromisoformat(args.batch_date)
        selected = batches.get(batch_day)
        if not selected:
            raise RuntimeError(f"No RiskGate ideas found for {batch_day.isoformat()}.")
        contracts = [idea.contract_symbol for idea in selected if idea.contract_symbol]
        start = min(idea.created_at for idea in selected) - timedelta(hours=1)
        bars_by_symbol = fetch_option_bars(contracts, start, as_of, args.timeframe)
    else:
        batch_day, selected, bars_by_symbol = find_latest_evaluable_batch(batches, as_of, args.timeframe)

    outcomes = evaluate_ideas(selected, bars_by_symbol, as_of)
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    raw_series = [
        (outcome.idea.symbol, [(bar.timestamp, bar.close) for bar in outcome.bars])
        for outcome in outcomes
        if outcome.bars
    ]
    normalized_series = [
        (
            outcome.idea.symbol,
            [
                (bar.timestamp, ((bar.close / outcome.entry_bar.close) - 1) * 100)
                for bar in outcome.bars
            ]
        )
        for outcome in outcomes
        if outcome.entry_bar and outcome.bars
    ]
    chart_svg(output_dir / "premium_prices.svg", "Option Premium Prices", raw_series, "Premium (USD)")
    chart_svg(output_dir / "premium_return_percent.svg", "Option Premium Return Since Entry", normalized_series, "Return (%)")
    write_results_csv(output_dir / "outcomes.csv", outcomes)
    data_note = "historical option bars; delayed/basic account constraints may apply"
    write_html_report(
        output_dir / "report.html",
        batch_day,
        newest_day,
        as_of,
        args.timeframe,
        outcomes,
        newest_batch,
        data_note
    )
    evaluated = [outcome for outcome in outcomes if outcome.status == "Evaluable"]
    total_pnl = sum(outcome.pnl_usd or 0 for outcome in evaluated)
    print(f"Newest saved batch: {newest_day.isoformat()} ({len(newest_batch)} ideas)")
    print(f"Evaluated batch: {batch_day.isoformat()} ({len(selected)} ideas; {len(evaluated)} premium paths)")
    print(f"Total P&L for one long contract each: ${total_pnl:,.2f}")
    for outcome in outcomes:
        contract = outcome.idea.contract_symbol or "no-contract"
        print(
            f"{outcome.idea.symbol:6s} {contract:24s} {outcome.status:36s} "
            f"{format_percent(outcome.return_percent):>10s} {format_money(outcome.pnl_usd):>12s}"
        )
    print(f"Report: {output_dir / 'report.html'}")


if __name__ == "__main__":
    main()
