"""Walk-forward value test for probabilistic exit overlays.

This is deliberately independent from the RiskGate application and database.
It evaluates decisions known at close t against close-to-close return t+1.
"""

from __future__ import annotations

import json
import math
import random
import time
import urllib.parse
import urllib.request
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import torch
from arch import arch_model
from scipy.stats import norm
from torch import nn
from torch.utils.data import DataLoader, TensorDataset

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
RESULTS = ROOT / "results"
SYMBOLS = ["SPY", "QQQ", "IWM", "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA"]
START = "2015-01-01"
TRAIN_END = "2021-12-31"
VALID_END = "2023-12-31"
TEST_START = "2024-01-01"
SEQ = 40
COST = 0.0005
SEED = 1729


def seed_all() -> None:
    random.seed(SEED)
    np.random.seed(SEED)
    torch.manual_seed(SEED)


def epoch(value: str) -> int:
    return int(pd.Timestamp(value, tz="UTC").timestamp())


def download(symbol: str) -> pd.DataFrame:
    DATA.mkdir(parents=True, exist_ok=True)
    path = DATA / f"{symbol}.csv"
    if path.exists():
        return pd.read_csv(path, parse_dates=["date"]).set_index("date")
    query = urllib.parse.urlencode({
        "period1": epoch(START), "period2": int(time.time()),
        "interval": "1d", "events": "div,splits", "includeAdjustedClose": "true",
    })
    url = f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?{query}"
    request = urllib.request.Request(url, headers={"User-Agent": "RiskGate-Research/1.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        result = json.load(response)["chart"]["result"][0]
    quote = result["indicators"]["quote"][0]
    adjusted = result["indicators"].get("adjclose", [{}])[0].get("adjclose", quote["close"])
    frame = pd.DataFrame({
        "date": pd.to_datetime(result["timestamp"], unit="s", utc=True).tz_convert(None).normalize(),
        "close": adjusted,
        "volume": quote["volume"],
    }).dropna(subset=["close"]).drop_duplicates("date").set_index("date").sort_index()
    frame.to_csv(path)
    return frame


def features(frame: pd.DataFrame) -> pd.DataFrame:
    out = frame.copy()
    out["ret"] = np.log(out.close).diff()
    out["absret"] = out.ret.abs()
    out["rv5"] = out.ret.rolling(5).std()
    out["rv20"] = out.ret.rolling(20).std()
    out["mom5"] = np.log(out.close / out.close.shift(5))
    out["mom20"] = np.log(out.close / out.close.shift(20))
    out["logvol"] = np.log1p(out.volume).diff()
    out["target"] = out.ret.shift(-1)
    return out.replace([np.inf, -np.inf], np.nan).dropna()


FEATURES = ["ret", "absret", "rv5", "rv20", "mom5", "mom20", "logvol"]


def sequences(frames: dict[str, pd.DataFrame], start=None, end=None):
    xs, ys, keys = [], [], []
    for symbol, frame in frames.items():
        values = frame[FEATURES].to_numpy(np.float32)
        targets = frame.target.to_numpy(np.float32)
        dates = frame.index
        for i in range(SEQ - 1, len(frame)):
            date = dates[i]
            if start is not None and date < pd.Timestamp(start):
                continue
            if end is not None and date > pd.Timestamp(end):
                continue
            xs.append(values[i - SEQ + 1:i + 1])
            ys.append(targets[i])
            keys.append((symbol, date))
    return np.asarray(xs), np.asarray(ys), keys


class DeepARStyle(nn.Module):
    def __init__(self, n_features: int):
        super().__init__()
        self.rnn = nn.LSTM(n_features, 32, num_layers=2, dropout=0.1, batch_first=True)
        self.head = nn.Linear(32, 2)

    def forward(self, x):
        state, _ = self.rnn(x)
        output = self.head(state[:, -1])
        return output[:, 0], output[:, 1].clamp(-7, 1)


def train_deepar(frames):
    cache = RESULTS / "deepar_style.pt"
    if cache.exists():
        saved = torch.load(cache, weights_only=False)
        model = DeepARStyle(len(FEATURES))
        model.load_state_dict(saved["state_dict"])
        return model, saved["mean"], saved["std"]
    x, y, _ = sequences(frames, end=TRAIN_END)
    mean = x.reshape(-1, x.shape[-1]).mean(0)
    std = x.reshape(-1, x.shape[-1]).std(0).clip(1e-6)
    x = (x - mean) / std
    dataset = TensorDataset(torch.tensor(x), torch.tensor(y))
    loader = DataLoader(dataset, batch_size=256, shuffle=True, generator=torch.Generator().manual_seed(SEED))
    model = DeepARStyle(len(FEATURES))
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-3, weight_decay=1e-4)
    model.train()
    for _ in range(20):
        for xb, yb in loader:
            mu, log_sigma = model(xb)
            sigma = log_sigma.exp()
            loss = (log_sigma + 0.5 * ((yb - mu) / sigma).square()).mean()
            optimizer.zero_grad()
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
    torch.save({"state_dict": model.state_dict(), "mean": mean, "std": std}, RESULTS / "deepar_style.pt")
    return model, mean, std


def deepar_forecasts(model, mean, std, frames):
    x, y, keys = sequences(frames, start="2022-01-01")
    x = (x - mean) / std
    model.eval()
    with torch.no_grad():
        mu, log_sigma = model(torch.tensor(x))
    sigma = log_sigma.exp().numpy()
    rows = [{"symbol": s, "date": d, "actual": a, "deep_mu": m, "deep_sigma": v,
             "deep_pneg": norm.cdf(0, loc=m, scale=v)}
            for (s, d), a, m, v in zip(keys, y, mu.numpy(), sigma)]
    return pd.DataFrame(rows).set_index(["symbol", "date"])


def volatility_forecasts(frames, forecasts):
    parts = []
    for symbol, frame in frames.items():
        sample = frame.loc[frame.index >= "2022-01-01"].copy()
        sample["ewma_sigma"] = frame.ret.ewm(span=20, adjust=False).std().reindex(sample.index)
        gjr = pd.Series(index=sample.index, dtype=float)
        fitted = None
        for j, date in enumerate(sample.index):
            if fitted is None or j % 21 == 0:
                history = frame.loc[frame.index <= date, "ret"].tail(1250) * 100
                try:
                    fitted = arch_model(history, mean="Constant", vol="GARCH", p=1, o=1, q=1,
                                        dist="StudentsT", rescale=False).fit(disp="off")
                except Exception:
                    fitted = None
            if fitted is not None:
                try:
                    gjr.loc[date] = math.sqrt(float(fitted.forecast(horizon=1).variance.iloc[-1, 0])) / 100
                except Exception:
                    pass
        sample["garch_sigma"] = gjr.ffill()
        sample["symbol"] = symbol
        parts.append(sample.reset_index().set_index(["symbol", "date"])[["ewma_sigma", "garch_sigma"]])
    return forecasts.join(pd.concat(parts))


def portfolio_returns(table, signal_col, threshold, high_is_exit=True):
    data = table.copy()
    if signal_col == "hold":
        data["active"] = 1.0
    elif high_is_exit:
        data["active"] = (data[signal_col] <= threshold).astype(float)
    else:
        data["active"] = (data[signal_col] >= threshold).astype(float)
    data["turn"] = data.groupby(level=0).active.diff().abs().fillna(0)
    data["strategy_ret"] = data.active * data.actual - COST * data.turn
    return data.groupby(level=1).strategy_ret.mean().sort_index(), data


def stats(returns):
    returns = returns.dropna()
    equity = np.exp(returns.cumsum())
    drawdown = equity / equity.cummax() - 1
    ann_ret = float(np.exp(returns.mean() * 252) - 1)
    ann_vol = float(returns.std(ddof=1) * math.sqrt(252))
    return {"annual_return": ann_ret, "annual_volatility": ann_vol,
            "sharpe": ann_ret / ann_vol if ann_vol else 0.0,
            "max_drawdown": float(drawdown.min()), "final_wealth": float(equity.iloc[-1])}


def choose_threshold(table, signal, grid):
    valid = table[(table.index.get_level_values(1) <= pd.Timestamp(VALID_END))]
    scored = []
    for threshold in grid:
        ret, _ = portfolio_returns(valid, signal, threshold)
        scored.append((stats(ret)["sharpe"], threshold))
    return max(scored)[1]


def gaussian_crps(y, mu, sigma):
    z = (y - mu) / sigma
    return sigma * (z * (2 * norm.cdf(z) - 1) + 2 * norm.pdf(z) - 1 / math.sqrt(math.pi))


def block_bootstrap_difference(left, right, statistic, iterations=2000, block=20):
    paired = pd.concat([left.rename("left"), right.rename("right")], axis=1).dropna()
    n = len(paired)
    rng = np.random.default_rng(SEED)
    values = []
    for _ in range(iterations):
        indices = []
        while len(indices) < n:
            start = int(rng.integers(0, max(n - block + 1, 1)))
            indices.extend(range(start, min(start + block, n)))
        sample = paired.iloc[indices[:n]]
        values.append(statistic(sample.left) - statistic(sample.right))
    return [float(x) for x in np.quantile(values, [.05, .5, .95])]


def main():
    seed_all()
    RESULTS.mkdir(parents=True, exist_ok=True)
    frames = {symbol: features(download(symbol)) for symbol in SYMBOLS}
    model, mean, std = train_deepar(frames)
    forecasts = volatility_forecasts(frames, deepar_forecasts(model, mean, std, frames)).dropna().sort_index()
    validation = forecasts[forecasts.index.get_level_values(1) <= pd.Timestamp(VALID_END)]
    thresholds = {
        "DeepAR-style": choose_threshold(forecasts, "deep_pneg", np.arange(0.50, 0.76, 0.025)),
        "EWMA": choose_threshold(forecasts, "ewma_sigma", validation.ewma_sigma.quantile(np.arange(.65, .96, .05))),
        "GJR-GARCH-t": choose_threshold(forecasts, "garch_sigma", validation.garch_sigma.quantile(np.arange(.65, .96, .05))),
    }
    test = forecasts[forecasts.index.get_level_values(1) >= pd.Timestamp(TEST_START)]
    definitions = [("Buy & hold", "hold", 0), ("EWMA", "ewma_sigma", thresholds["EWMA"]),
                   ("GJR-GARCH-t", "garch_sigma", thresholds["GJR-GARCH-t"]),
                   ("DeepAR-style", "deep_pneg", thresholds["DeepAR-style"])]
    metrics, curves, strategy_returns, per_symbol = [], {}, {}, []
    for name, signal, threshold in definitions:
        returns, detailed = portfolio_returns(test, signal, threshold)
        result = {"model": name, "threshold": threshold, **stats(returns),
                  "exposure": float(detailed.active.mean()), "turnover_events": int(detailed.turn.sum())}
        metrics.append(result)
        curves[name] = np.exp(returns.cumsum())
        strategy_returns[name] = returns
        for symbol, group in detailed.groupby(level=0):
            per_symbol.append({"model": name, "symbol": symbol, **stats(group.strategy_ret),
                               "exposure": float(group.active.mean())})
    metrics_frame = pd.DataFrame(metrics)
    metrics_frame.to_csv(RESULTS / "metrics.csv", index=False)
    pd.DataFrame(per_symbol).to_csv(RESULTS / "metrics_by_symbol.csv", index=False)
    deep_crps = gaussian_crps(test.actual.to_numpy(), test.deep_mu.to_numpy(), test.deep_sigma.to_numpy())
    forecast_metrics = pd.DataFrame([{
        "model": "DeepAR-style", "mean_crps": float(np.mean(deep_crps)),
        "directional_accuracy": float(np.mean((test.deep_mu > 0) == (test.actual > 0))),
        "negative_brier": float(np.mean((test.deep_pneg - (test.actual < 0).astype(float)) ** 2)),
        "interval_90_coverage": float(np.mean(np.abs(test.actual - test.deep_mu) <= 1.644854 * test.deep_sigma)),
    }])
    forecast_metrics.to_csv(RESULTS / "forecast_metrics.csv", index=False)
    pd.DataFrame(curves).plot(figsize=(9, 5), linewidth=1.4)
    plt.ylabel("Riqueza acumulada (inicial = 1)")
    plt.xlabel("Fecha")
    plt.grid(alpha=.25)
    plt.tight_layout()
    plt.savefig(RESULTS / "equity_curves.pdf")
    plt.close()
    sharpe_stat = lambda x: stats(pd.Series(np.asarray(x)))["sharpe"]
    bootstrap = {
        "garch_minus_hold_sharpe_90ci": block_bootstrap_difference(
            strategy_returns["GJR-GARCH-t"], strategy_returns["Buy & hold"], sharpe_stat),
        "garch_minus_hold_mean_daily_return_90ci": block_bootstrap_difference(
            strategy_returns["GJR-GARCH-t"], strategy_returns["Buy & hold"], lambda x: float(np.mean(x))),
    }
    summary = {"generated_at": pd.Timestamp.utcnow().isoformat(), "seed": SEED, "symbols": SYMBOLS,
               "train_end": TRAIN_END, "validation_end": VALID_END, "test_start": TEST_START,
               "transaction_cost_bps": COST * 10000, "thresholds": thresholds,
               "test_observations": int(len(test)), "metrics": metrics,
               "forecast_metrics": forecast_metrics.to_dict(orient="records"), "bootstrap": bootstrap}
    (RESULTS / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(metrics_frame.to_string(index=False))
    print(forecast_metrics.to_string(index=False))


if __name__ == "__main__":
    main()
