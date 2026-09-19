# Exit Forecasting Experiment

Reproducible, isolated study of whether probabilistic forecasts add value to a
long-position exit overlay. It does not modify the RiskGate database.

## Run

```powershell
cd experiments/exit-forecasting
python run_experiment.py
latexmk -pdf -interaction=nonstopmode informe.tex
```

The script downloads adjusted daily prices from Yahoo's chart endpoint and
writes `results/metrics.csv`, `results/forecast_metrics.csv`,
`results/summary.json`, and the figures consumed by the LaTeX report.

Models compared:

- buy-and-hold;
- EWMA high-volatility filter;
- GJR-GARCH(1,1)-t high-volatility filter;
- a global Gaussian DeepAR-style LSTM directional filter.

The experiment concerns underlying returns. It is a first gate before testing
option P&L, which requires historical bid/ask, implied volatility, and Greeks.

## Experiment 02

The second experiment tests normalized and gradual exits plus a quantile
LightGBM benchmark across several market blocks:

```powershell
python run_experiment_02.py
latexmk -pdf -interaction=nonstopmode informe_experimento_02.tex
```
