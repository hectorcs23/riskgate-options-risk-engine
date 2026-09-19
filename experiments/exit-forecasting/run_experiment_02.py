"""Experiment 02: normalized, gradual exit overlays and quantile boosting."""

from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
from arch import arch_model
from lightgbm import LGBMRegressor

import run_experiment as base

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "results" / "experiment_02"
TRAIN_END = pd.Timestamp("2018-12-31")
VALID_START = pd.Timestamp("2019-01-01")
VALID_END = pd.Timestamp("2019-12-31")
TEST_START = pd.Timestamp("2020-01-01")
BLOCKS = {
    "2020-2021": ("2020-01-01", "2021-12-31"),
    "2022": ("2022-01-01", "2022-12-31"),
    "2023-2024": ("2023-01-01", "2024-12-31"),
    "2025-2026": ("2025-01-01", "2099-12-31"),
}


def panel(frames: dict[str, pd.DataFrame]) -> pd.DataFrame:
    rows = []
    spy = frames["SPY"][["ret", "rv20", "mom20"]].rename(
        columns={"ret": "spy_ret", "rv20": "spy_rv20", "mom20": "spy_mom20"}
    )
    for symbol, frame in frames.items():
        item = frame.join(spy, how="left").copy()
        item["symbol"] = symbol
        item["dow"] = item.index.dayofweek
        rows.append(item.reset_index())
    return pd.concat(rows, ignore_index=True).sort_values(["date", "symbol"])


MODEL_FEATURES = base.FEATURES + ["spy_ret", "spy_rv20", "spy_mom20", "dow"]


def fit_quantiles(data: pd.DataFrame, train_end: pd.Timestamp):
    train = data[data.date <= train_end]
    x = pd.get_dummies(train[["symbol"] + MODEL_FEATURES], columns=["symbol"], dtype=float)
    models = {}
    for quantile in (0.1, 0.5, 0.9):
        model = LGBMRegressor(
            objective="quantile", alpha=quantile, n_estimators=350, learning_rate=0.025,
            num_leaves=15, min_child_samples=80, subsample=0.8, colsample_bytree=0.8,
            reg_lambda=1.0, random_state=base.SEED, verbosity=-1, n_jobs=-1,
        )
        model.fit(x, train.target)
        models[quantile] = (model, x.columns)
    return models


def predict_quantiles(models, data: pd.DataFrame) -> pd.DataFrame:
    raw = pd.get_dummies(data[["symbol"] + MODEL_FEATURES], columns=["symbol"], dtype=float)
    result = data[["symbol", "date", "target"]].rename(columns={"target": "actual"}).copy()
    for quantile, (model, columns) in models.items():
        x = raw.reindex(columns=columns, fill_value=0)
        result[f"q{int(quantile * 100):02d}"] = model.predict(x)
    width = (result.q90 - result.q10).clip(lower=1e-6)
    result["quantile_score"] = result.q50 / width
    result["interval_hit"] = ((result.actual >= result.q10) & (result.actual <= result.q90)).astype(float)
    return result.set_index(["symbol", "date"]).sort_index()


def normalized_garch(frames: dict[str, pd.DataFrame]) -> pd.DataFrame:
    pieces = []
    for symbol, frame in frames.items():
        dates = frame.loc[frame.index >= VALID_START].index
        sigma = pd.Series(index=dates, dtype=float)
        fitted = None
        for j, date in enumerate(dates):
            if fitted is None or j % 21 == 0:
                history = frame.loc[frame.index <= date, "ret"].tail(1250) * 100
                try:
                    fitted = arch_model(history, mean="Constant", vol="GARCH", p=1, o=1, q=1,
                                        dist="StudentsT", rescale=False).fit(disp="off")
                except Exception:
                    fitted = None
            if fitted is not None:
                sigma.loc[date] = math.sqrt(float(fitted.forecast(horizon=1).variance.iloc[-1, 0])) / 100
        historical_rv = frame.rv20
        ranks = []
        for date, value in sigma.items():
            history = historical_rv.loc[historical_rv.index < date].tail(504).dropna()
            ranks.append(float((history <= value).mean()) if len(history) >= 100 else np.nan)
        pieces.append(pd.DataFrame({"symbol": symbol, "date": dates, "garch_sigma": sigma.values,
                                    "garch_percentile": ranks}).set_index(["symbol", "date"]))
    return pd.concat(pieces).sort_index()


def strategy_table(data: pd.DataFrame, quantile_threshold: float) -> pd.DataFrame:
    out = data.copy()
    out["Buy & hold"] = 1.0
    out["GARCH gradual"] = np.select(
        [out.garch_percentile >= 0.90, out.garch_percentile >= 0.80], [0.0, 0.5], default=1.0
    )
    margin = out.quantile_score - quantile_threshold
    out["Quantile LGBM"] = np.select([margin < -0.05, margin < 0.05], [0.0, 0.5], default=1.0)
    out["Hybrid"] = np.minimum(out["GARCH gradual"], out["Quantile LGBM"])
    return out


def returns_for(data: pd.DataFrame, strategy: str):
    active = data[strategy]
    turnover = active.groupby(level=0).diff().abs().fillna(0)
    detail = active * data.actual - base.COST * turnover
    return detail.groupby(level=1).mean().sort_index(), float(active.mean()), int((turnover > 0).sum())


def select_threshold(validation: pd.DataFrame):
    candidates = np.arange(-0.20, 0.201, 0.025)
    scored = []
    for threshold in candidates:
        table = strategy_table(validation, threshold)
        returns, _, _ = returns_for(table, "Quantile LGBM")
        scored.append((base.stats(returns)["sharpe"], float(threshold)))
    return max(scored)[1]


def bootstrap_sharpe(left, right, iterations=2000, block=20):
    stat = lambda x: base.stats(pd.Series(np.asarray(x)))["sharpe"]
    return base.block_bootstrap_difference(left, right, stat, iterations, block)


def main():
    base.seed_all()
    OUT.mkdir(parents=True, exist_ok=True)
    frames = {symbol: base.features(base.download(symbol)) for symbol in base.SYMBOLS}
    data = panel(frames)
    models = fit_quantiles(data, TRAIN_END)
    predictions = predict_quantiles(models, data[data.date >= VALID_START])
    combined = predictions.join(normalized_garch(frames)).dropna().sort_index()
    validation = combined[(combined.index.get_level_values(1) >= VALID_START) &
                          (combined.index.get_level_values(1) <= VALID_END)]
    threshold = select_threshold(validation)
    test = strategy_table(combined[combined.index.get_level_values(1) >= TEST_START], threshold)

    strategies = ["Buy & hold", "GARCH gradual", "Quantile LGBM", "Hybrid"]
    rows, block_rows, return_map = [], [], {}
    for strategy in strategies:
        returns, exposure, changes = returns_for(test, strategy)
        return_map[strategy] = returns
        rows.append({"strategy": strategy, **base.stats(returns), "exposure": exposure, "changes": changes})
        for label, (start, end) in BLOCKS.items():
            block_returns = returns.loc[start:end]
            block_rows.append({"strategy": strategy, "block": label, **base.stats(block_returns)})

    metrics = pd.DataFrame(rows)
    by_block = pd.DataFrame(block_rows)
    metrics.to_csv(OUT / "metrics.csv", index=False)
    by_block.to_csv(OUT / "metrics_by_block.csv", index=False)
    forecast_metrics = {
        "pinball_q10": float(np.mean(np.maximum(.1 * (test.actual - test.q10), -.9 * (test.actual - test.q10)))),
        "pinball_q50": float(np.mean(np.maximum(.5 * (test.actual - test.q50), -.5 * (test.actual - test.q50)))),
        "interval_80_coverage": float(test.interval_hit.mean()),
        "median_direction_accuracy": float(np.mean((test.q50 > 0) == (test.actual > 0))),
    }
    bootstrap = {strategy: bootstrap_sharpe(return_map[strategy], return_map["Buy & hold"])
                 for strategy in strategies if strategy != "Buy & hold"}
    summary = {"seed": base.SEED, "train_end": str(TRAIN_END.date()),
               "validation": [str(VALID_START.date()), str(VALID_END.date())],
               "test_start": str(TEST_START.date()), "quantile_threshold": threshold,
               "transaction_cost_bps": base.COST * 10000, "forecast_metrics": forecast_metrics,
               "bootstrap_sharpe_difference_90ci": bootstrap,
               "metrics": rows, "metrics_by_block": block_rows}
    (OUT / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    curves = {name: np.exp(series.cumsum()) for name, series in return_map.items()}
    pd.DataFrame(curves).plot(figsize=(9, 5), linewidth=1.35).get_figure().savefig(
        OUT / "equity_curves.pdf", bbox_inches="tight"
    )
    print(metrics.to_string(index=False))
    print("\nBy block\n", by_block[["strategy", "block", "sharpe", "max_drawdown"]].to_string(index=False))
    print("\nForecast", forecast_metrics)
    print("Bootstrap", bootstrap)


if __name__ == "__main__":
    main()
