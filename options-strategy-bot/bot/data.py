from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
import csv
import json
import math
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen


@dataclass(frozen=True)
class Bar:
    date: date
    open: float
    high: float
    low: float
    close: float
    volume: float


def load_csv(symbol: str, data_dir: str | Path) -> list[Bar]:
    path = Path(data_dir) / f"{symbol.upper()}.csv"
    if not path.exists():
      return []

    bars: list[Bar] = []
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            try:
                bars.append(
                    Bar(
                        date=datetime.strptime(row["date"], "%Y-%m-%d").date(),
                        open=float(row["open"]),
                        high=float(row["high"]),
                        low=float(row["low"]),
                        close=float(row["close"]),
                        volume=float(row.get("volume") or 0)
                    )
                )
            except (KeyError, ValueError):
                continue
    return sorted(bars, key=lambda bar: bar.date)


def fetch_yahoo(symbol: str, days: int = 420) -> list[Bar]:
    end = int(datetime.now(tz=timezone.utc).timestamp())
    start = int((datetime.now(tz=timezone.utc) - timedelta(days=days)).timestamp())
    url = (
        "https://query1.finance.yahoo.com/v8/finance/chart/"
        f"{quote(symbol)}?period1={start}&period2={end}&interval=1d"
    )
    request = Request(url, headers={"User-Agent": "OptionsStrategyBot/0.1"})
    with urlopen(request, timeout=20) as response:
        payload = json.loads(response.read().decode("utf-8"))

    result = payload["chart"]["result"][0]
    timestamps = result.get("timestamp", [])
    quote_data = result["indicators"]["quote"][0]
    bars: list[Bar] = []
    for index, timestamp in enumerate(timestamps):
        close = quote_data.get("close", [None])[index]
        if close is None:
            continue
        open_ = quote_data.get("open", [close])[index] or close
        high = quote_data.get("high", [close])[index] or close
        low = quote_data.get("low", [close])[index] or close
        volume = quote_data.get("volume", [0])[index] or 0
        bars.append(
            Bar(
                date=datetime.fromtimestamp(timestamp, tz=timezone.utc).date(),
                open=float(open_),
                high=float(high),
                low=float(low),
                close=float(close),
                volume=float(volume)
            )
        )
    return bars


def synthetic_bars(symbol: str, days: int = 360) -> list[Bar]:
    seed = sum(ord(ch) for ch in symbol.upper())
    price = 60 + seed % 180
    bars: list[Bar] = []
    start = date.today() - timedelta(days=days * 2)
    step = 0
    current = start

    while len(bars) < days:
        if current.weekday() >= 5:
            current += timedelta(days=1)
            continue
        drift = 0.00035 + ((seed % 9) - 4) * 0.00003
        cyc = math.sin((step + seed) / 17) * 0.012
        shock = math.sin((step * 7 + seed) / 11) * 0.006
        previous = price
        price = max(5, price * (1 + drift + cyc + shock))
        high = max(previous, price) * (1 + 0.006 + abs(shock))
        low = min(previous, price) * (1 - 0.006 - abs(shock) / 2)
        volume = 1_500_000 + (seed % 17) * 120_000 + abs(math.sin(step / 8)) * 900_000
        bars.append(Bar(current, previous, high, low, price, volume))
        step += 1
        current += timedelta(days=1)
    return bars


def load_history(symbol: str, data_dir: str | None, synthetic: bool, offline: bool) -> list[Bar]:
    if synthetic:
        return synthetic_bars(symbol)
    if data_dir:
        bars = load_csv(symbol, data_dir)
        if bars:
            return bars
    if offline:
        return []
    try:
        return fetch_yahoo(symbol)
    except Exception:
        return []


def slice_until(bars: list[Bar], index: int) -> list[Bar]:
    return bars[: index + 1]
