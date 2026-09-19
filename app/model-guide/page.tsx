import Link from "next/link";
import { BookOpenCheck, ExternalLink, ShieldCheck } from "lucide-react";
import { getSelectedPortfolio } from "@/lib/data";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<{ portfolio?: string }>;
};

const scoreRows = [
  ["Market regime", "25-35%", "Composite SPY, QQQ, breadth, and VIX regime. Weight adapts to regime."],
  ["Technical setup", "20-30%", "Calculated trend, SMA20/50/200, RSI14, ATR14, relative volume, BWAP, and support/resistance context."],
  ["Options quality", "25-35%", "Continuous bid/ask spread, volume, open interest, DTE, IV rank/proxy, premium size, and theta decay."],
  ["Trade quality", "15-20%", "Continuous thesis quality, catalyst, invalidation, exit plan, reward/risk, chasing flag."]
];

const hardStops = [
  "Missing written thesis.",
  "Missing invalidation level.",
  "Missing or invalid max loss.",
  "Missing exit plan.",
  "Bid/ask spread wider than 15%.",
  "Days to expiration below 7.",
  "Premium above 1% of portfolio.",
  "Option volume below 25 and open interest below 100.",
  "Missing leg price data when max loss cannot be calculated.",
  "Undefined max loss for a strategy that should be defined-risk.",
  "Short naked option leg detected without an explicit advanced override."
];

const approvalCaps = [
  "Chasing or extended setup: cannot be approved, capped at watchlist.",
  "IV rank above 80: cannot be approved, capped at watchlist.",
  "Current contract IV above 85%: cannot be approved, capped at watchlist.",
  "Theta above 8% of contract mid per day: cannot be approved, capped at watchlist.",
  "High gamma with less than 30 DTE: cannot be approved, capped at watchlist."
];

const moduleMath = [
  {
    name: "Market regime",
    base: "50",
    rules: [
      "SPY and QQQ trend are normalized from price versus SMA20/SMA50, SMA alignment, and 20-day change when available.",
      "Breadth is the share of the universe above SMA50.",
      "VIX is inverted: low VIX helps, elevated or spiking VIX hurts.",
      "Missing components lower confidence and available weights are normalized.",
      "VIX stress can force the label to stress."
    ]
  },
  {
    name: "Technical setup",
    base: "50",
    rules: [
      "Bullish trade in uptrend +18",
      "Bearish trade in downtrend +18",
      "Neutral trade in sideways trend +12",
      "Bullish trade in downtrend -15",
      "Bearish trade in uptrend -15",
      "Price above 20MA +8 unless bearish, then -6",
      "Price above 50MA +10 unless bearish, then -8",
      "RSI oversold with bullish trade +8",
      "RSI overbought with bearish trade +8",
      "RSI overbought with bullish trade -8",
      "Strong volume +8; weak volume -8",
      "Good support/resistance +10; poor -15"
    ]
  },
  {
    name: "Options quality",
    base: "continuous",
    rules: [
      "Score = 100 x (0.24 spread + 0.15 DTE + 0.12 volume + 0.12 open interest + 0.08 IV rank/proxy + 0.07 premium size + 0.10 theta + 0.08 delta-fit + 0.04 gamma-risk)",
      "Spread quality is smooth: full credit near 2%, decays as spread widens.",
      "DTE quality ramps from 5 to 21 days, is best from 21 to 60 days, then decays gradually.",
      "Volume and open interest use square-root scaling toward 500 volume and 1000 open interest.",
      "IV rank is penalized quadratically: high IV rank reduces quality faster than moderate IV.",
      "Premium size remains conservative and decays after 0.25% to 1% of portfolio.",
      "Theta quality penalizes contracts where daily theta is large compared with the contract mid.",
      "Delta-fit rewards directional contracts near 0.40 absolute delta and rejects wrong-sign delta.",
      "Gamma-risk penalizes contracts with jumpy delta exposure."
    ]
  },
  {
    name: "Trade quality",
    base: "continuous",
    rules: [
      "Score = 100 x weighted quality of thesis, catalyst, invalidation, exit plan, reward/risk, and chasing discipline.",
      "Thesis and exit plan scale with detail instead of flipping at a single text threshold.",
      "Reward/risk quality scales up to 3.0x.",
      "Chasing setup gets zero credit for the discipline component."
    ]
  }
];

const probabilisticRows = [
  ["Probability of profit", "Uses the best available options-derived source: Monte Carlo, lognormal IV, delta proxy, IV proxy, then unavailable. The model score is never used as probability."],
  ["Expected value", "EV = PoP x expectedReward - (1 - PoP) x maxLoss. Reward and max loss still come from your trade plan."],
  ["Quarter-Kelly cap", "Kelly fraction = 0.25 x max((p x b - q) / b, 0), where b is reward/loss. Suggested size cannot exceed this cap."],
  ["Monte Carlo scenarios", "Simulates terminal underlying prices with geometric Brownian motion and evaluates the full multi-leg payoff at expiration. It is a scenario engine, not a prediction."],
  ["Greeks exposure", "Delta, gamma, theta, and vega are multiplied by a 100-share contract multiplier and aggregated across active approved/entered ideas."],
  ["Tail-risk proxy", "One-day VaR95 and CVaR95 use a delta/gamma/vega/theta approximation capped by the trade max loss."]
];

const integrations = [
  {
    name: "Tradier",
    fit: "Best candidate for U.S. options chain data plus possible paper/live trading later.",
    link: "https://docs.tradier.com/reference/brokerage-api-markets-get-options-chains"
  },
  {
    name: "Polygon.io",
    fit: "Best for market-data depth: historical data, reference data, REST, WebSockets, and flat files.",
    link: "https://polygon.io/docs/rest/options/overview"
  },
  {
    name: "MarketData.app",
    fit: "Good market-data-only route for expirations, strikes, option chains, and quotes.",
    link: "https://www.marketdata.app/docs/api/"
  },
  {
    name: "Alpaca",
    fit: "Useful if you want a separate API-based paper/live options account workflow.",
    link: "https://docs.alpaca.markets/docs/options-trading"
  }
];

export default async function ModelGuidePage({ searchParams }: PageProps) {
  const params = await searchParams;
  const { selectedPortfolio } = await getSelectedPortfolio(params?.portfolio);
  const portfolioQuery = `?portfolio=${encodeURIComponent(selectedPortfolio.id)}`;

  return (
    <div className="grid gap-6">
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="field-label">Methodology document</p>
          <h1 className="mt-2 text-3xl font-bold text-ink">Trade Idea Model Guide</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-600">
            This explains the current RiskGate logic for {selectedPortfolio.name}: scoring, hard stops, Alpaca option snapshots, sizing, limitations, and the best path to make it more robust.
          </p>
        </div>
        <Link className="btn-primary" href={`/risk-model${portfolioQuery}`}>
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          Back to model
        </Link>
      </header>

      <section className="rounded-lg border border-amber-200 bg-amber-50 p-5 text-sm leading-6 text-amber-950">
        <p className="font-bold">Important</p>
        <p className="mt-1">
          RiskGate is a decision-support tool. It does not provide financial advice, predict prices, or place trades. Yahoo Finance sentiment and Monte Carlo simulations are contextual tools and should not be used as standalone trade signals.
        </p>
      </section>

      <section className="panel-pad">
        <h2 className="text-xl font-bold text-ink">Core Rule</h2>
        <div className="mt-4 rounded-lg border border-stone-200 bg-stone-50 p-4 font-mono text-sm leading-6 text-ink">
          No options trade should be approved unless the written plan, score, liquidity checks, expiration rules, and portfolio risk caps all pass.
        </div>
      </section>

      <section className="panel-pad">
        <h2 className="text-xl font-bold text-ink">Exact Mathematical Shape</h2>
        <p className="mt-2 text-sm leading-6 text-stone-600">
          Market and technical context still use transparent rule adjustments, while option quality and trade quality now use continuous functions from the robustness roadmap. The total score uses regime-adaptive weights.
        </p>
        <div className="mt-4 rounded-lg border border-stone-200 bg-stone-50 p-4 font-mono text-sm leading-6 text-ink">
          optionsQuality = 100 x sum(weight_k x qualityFunction_k)
          <br />
          baseScore = market x w_m + technical x w_t + options x w_o + trade x w_q
          <br />
          finalScore = clamp(baseScore + strategyChecks + monteCarloOverlay + yahooSentimentOverlay)
          <br />
          bull weights = 25 / 30 / 25 / 20
          <br />
          neutral weights = 35 / 25 / 25 / 15
          <br />
          stressed weights = 30 / 20 / 35 / 15
        </div>
      </section>

      <section className="panel-pad">
        <h2 className="text-xl font-bold text-ink">Multi-Leg Option Structure</h2>
        <p className="mt-2 text-sm leading-6 text-stone-600">
          New ideas can store option legs separately. Long calls, long puts, bull call debit spreads, bear put debit spreads, protective puts, and collars are evaluated at the strategy level: net debit or credit, max loss, max profit, breakeven points, total Greeks, and an expiration payoff curve. Old single-contract ideas still work through a virtual legacy leg.
        </p>
      </section>

      <section className="panel-pad">
        <h2 className="text-xl font-bold text-ink">Calculated Technicals and BWAP</h2>
        <p className="mt-2 text-sm leading-6 text-stone-600">
          RiskGate stores daily OHLCV price bars and calculates SMA20, SMA50, SMA200, RSI14, ATR14, relative volume, and BWAP / VWAP-style weighted average price. Technical scoring now uses continuous quality components instead of only manual above/below labels, while still showing warnings when manual labels conflict with calculated indicators.
        </p>
      </section>

      <section className="panel-pad">
        <h2 className="text-xl font-bold text-ink">Automatic Contract Selection</h2>
        <p className="mt-2 text-sm leading-6 text-stone-600">
          Daily auto ideas first search for 21-75 DTE Alpaca contracts, then rank delta fit, spread, liquidity, IV, theta drag, gamma risk, and account-size fit. If a single long option is too expensive, RiskGate attempts a debit-spread structure with a farther out-of-the-money short leg before falling back to a rejected research lead.
        </p>
      </section>

      <section className="panel overflow-hidden">
        <div className="p-5">
          <h2 className="text-xl font-bold text-ink">Score Modules</h2>
          <p className="mt-2 text-sm leading-6 text-stone-600">
            The total score is weighted, then clamped through safety checks before any risk size is assigned.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px]">
            <thead className="table-head">
              <tr>
                <th className="px-4 py-3">Module</th>
                <th className="px-4 py-3">Weight</th>
                <th className="px-4 py-3">Purpose</th>
              </tr>
            </thead>
            <tbody>
              {scoreRows.map(([module, weight, purpose]) => (
                <tr key={module}>
                  <td className="table-cell font-bold text-ink">{module}</td>
                  <td className="table-cell">{weight}</td>
                  <td className="table-cell text-stone-600">{purpose}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <div className="panel-pad">
          <h2 className="text-xl font-bold text-ink">Decision Bands</h2>
          <div className="mt-4 grid gap-3 text-sm">
            <div className="rounded-lg border border-red-200 bg-red-50 p-3 font-semibold text-red-800">Score below 60: reject</div>
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 font-semibold text-amber-900">60 to 74: watchlist</div>
            <div className="rounded-lg border border-lime-200 bg-lime-50 p-3 font-semibold text-lime-800">75 to 84: approved small</div>
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 font-semibold text-emerald-800">85 and above: approved normal</div>
          </div>
        </div>

        <div className="panel-pad">
          <h2 className="text-xl font-bold text-ink">Hard Stops</h2>
          <ul className="mt-4 grid gap-2 text-sm leading-6 text-stone-700">
            {hardStops.map((item) => (
              <li key={item}>- {item}</li>
            ))}
          </ul>
        </div>
      </section>

      <section className="panel-pad">
        <h2 className="text-xl font-bold text-ink">Approval Caps</h2>
        <p className="mt-2 text-sm leading-6 text-stone-600">
          These do not always reject an idea, but they block approved risk sizing. The idea can remain visible for research until the option chain and setup normalize.
        </p>
        <ul className="mt-4 grid gap-2 text-sm leading-6 text-stone-700">
          {approvalCaps.map((item) => (
            <li key={item}>- {item}</li>
          ))}
        </ul>
      </section>

      <section className="grid gap-4">
        <h2 className="text-xl font-bold text-ink">Module Logic</h2>
        <div className="grid gap-4 xl:grid-cols-2">
          {moduleMath.map((module) => (
            <div className="panel-pad" key={module.name}>
              <div className="flex items-center justify-between gap-3">
                <h3 className="font-bold text-ink">{module.name}</h3>
                <span className="rounded-full border border-stone-200 bg-stone-50 px-2.5 py-1 text-xs font-bold text-stone-700">
                  Base {module.base}
                </span>
              </div>
              <ul className="mt-4 grid gap-2 text-sm leading-6 text-stone-700">
                {module.rules.map((rule) => (
                  <li key={rule}>- {rule}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section className="panel-pad">
        <h2 className="text-xl font-bold text-ink">Sizing Logic</h2>
        <p className="mt-2 text-sm leading-6 text-stone-600">
          Approval does not mean full size. Suggested risk starts with base risk, then gets reduced by score confidence, option liquidity, composite market-regime alignment, volatility, concentration, Monte Carlo risk, Yahoo Finance sentiment risk when enabled, event risk, options-derived Kelly, and portfolio caps.
        </p>
        <div className="mt-4 rounded-lg border border-stone-200 bg-stone-50 p-4 font-mono text-sm leading-6 text-ink">
          multiplierRisk = baseRisk x confidence x liquidity x regime x volatility x concentration x monteCarlo x sentiment x event
          <br />
          probabilisticKelly = portfolioValue x 0.25 x max((p x b - (1 - p)) / b, 0)
          <br />
          finalRisk = min(multiplierRisk, probabilisticKelly, remaining sleeve, remaining monthly loss cap, remaining open risk cap)
        </div>
      </section>

      <section className="panel-pad">
        <h2 className="text-xl font-bold text-ink">Yahoo Finance Sentiment</h2>
        <p className="mt-2 text-sm leading-6 text-stone-600">
          The Yahoo Finance news module is off by default. When enabled, it fetches public Yahoo Finance news best-effort, stores only useful audit fields locally, scores relevance to the ticker and catalyst, and classifies the narrative as bullish, bearish, mixed, hype, fear, or low signal. It is optional, secondary, and public endpoints may fail or change.
        </p>
      </section>

      <section className="panel-pad">
        <h2 className="text-xl font-bold text-ink">Event Risk and Strategy Checks</h2>
        <p className="mt-2 text-sm leading-6 text-stone-600">
          Static local macro events and optional earnings inputs can warn, reduce sizing, cap approval, or reject severe naked-short event exposure. Strategy checks validate long calls, long puts, bull call debit spreads, bear put debit spreads, protective puts, and collars with hard stops, caps, warnings, and small score adjustments.
        </p>
      </section>

      <section className="panel overflow-hidden">
        <div className="p-5">
          <h2 className="text-xl font-bold text-ink">Options Analytics Overlay</h2>
          <p className="mt-2 text-sm leading-6 text-stone-600">
            When a trade idea has an Alpaca contract symbol and snapshot data, the model adds a probabilistic layer on top of the rule score.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px]">
            <thead className="table-head">
              <tr>
                <th className="px-4 py-3">Metric</th>
                <th className="px-4 py-3">How it is used</th>
              </tr>
            </thead>
            <tbody>
              {probabilisticRows.map(([metric, logic]) => (
                <tr key={metric}>
                  <td className="table-cell font-bold text-ink">{metric}</td>
                  <td className="table-cell text-stone-600">{logic}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel-pad">
        <h2 className="text-xl font-bold text-ink">Ticker Tracking</h2>
        <p className="mt-2 text-sm leading-6 text-stone-600">
          RiskGate now tracks tickers through a portfolio-specific Watchlist. The app stores symbols locally, can refresh latest and previous-close data from the Yahoo Finance public chart endpoint, and uses Alpaca for option contract snapshots when configured. Manual editing stays available if a source is unavailable or you prefer your own prices.
        </p>
        <div className="mt-4">
          <Link className="btn-secondary" href={`/watchlist${portfolioQuery}`}>
            Open watchlist
          </Link>
        </div>
      </section>

      <section className="panel-pad">
        <h2 className="text-xl font-bold text-ink">How to Make It More Robust</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {integrations.map((item) => (
            <a
              className="rounded-lg border border-stone-200 bg-white p-4 transition hover:border-moss hover:bg-mist"
              href={item.link}
              key={item.name}
              rel="noreferrer"
              target="_blank"
            >
              <div className="flex items-center justify-between gap-3">
                <p className="font-bold text-ink">{item.name}</p>
                <ExternalLink className="h-4 w-4 text-stone-500" aria-hidden="true" />
              </div>
              <p className="mt-2 text-sm leading-6 text-stone-600">{item.fit}</p>
            </a>
          ))}
        </div>
      </section>

      <section className="panel-pad">
        <div className="flex items-start gap-3">
          <BookOpenCheck className="mt-1 h-5 w-5 text-moss" aria-hidden="true" />
          <div>
            <h2 className="text-xl font-bold text-ink">Recommended Next Build</h2>
            <p className="mt-2 text-sm leading-6 text-stone-600">
              The model is now structured around composite market regime, multi-leg payoff, calculated technicals, continuous options quality, Monte Carlo scenarios, event risk, strategy checks, and optional Yahoo Finance news context. The next robustness step is richer broker-read-only reconciliation and more complete earnings data.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
