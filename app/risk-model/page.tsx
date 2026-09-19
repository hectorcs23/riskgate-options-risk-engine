import Link from "next/link";
import { ScoreLineChart } from "@/components/charts";
import { DecisionBadge } from "@/components/decision-badge";
import { StatCard } from "@/components/stat-card";
import { refreshDailyModel } from "@/app/actions";
import { prisma } from "@/lib/db";
import { getRiskSettings, getSelectedPortfolio } from "@/lib/data";
import { formatMXN, formatNumber } from "@/lib/format";
import { optionsRiskUsed } from "@/lib/calculations";
import { concentrationAnalytics } from "@/lib/concentration";
import { aggregateOptionAnalytics, analyzeOptionTrade } from "@/lib/options-math";
import { compositeMarketRegimeFromInput } from "@/lib/risk";
import { tradeIdeaToInput } from "@/lib/trade-input";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<{ portfolio?: string }>;
};

const weights = [
  { module: "Bull regime", weight: "25 / 30 / 25 / 20", description: "Technical setup and trade quality get more weight when market regime supports momentum." },
  { module: "Neutral regime", weight: "35 / 25 / 25 / 15", description: "Market regime is emphasized when conditions are mixed." },
  { module: "Bear or stressed regime", weight: "30 / 20 / 35 / 15", description: "Options quality receives more weight when volatility and liquidity risk rise." }
];

const decisions = [
  { range: "< 60", decision: "reject" },
  { range: "60-74", decision: "watchlist" },
  { range: "75-84", decision: "approved_small" },
  { range: "85+", decision: "approved_normal" }
];

const multipliers = [
  { name: "Confidence", detail: "0 below 75, then 0.25 / 0.50 / 0.75 / 1.00 as score rises." },
  { name: "Liquidity", detail: "0 if spread > 15%, 0.25 above 10%, 0.50 above 5%, 1.00 at 5% or tighter." },
  { name: "Market regime", detail: "Composite SPY/QQQ/breadth/VIX multiplier, capped when regime confidence is low." },
  { name: "Volatility", detail: "High IV rank or high current contract IV blocks approval; normal IV keeps the full multiplier." }
];

export default async function RiskModelPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const { selectedPortfolio } = await getSelectedPortfolio(params?.portfolio);
  const settings = await getRiskSettings(selectedPortfolio.id);
  const ideas = await prisma.tradeIdea.findMany({
    where: { portfolioId: selectedPortfolio.id },
    orderBy: { createdAt: "desc" },
    include: {
      optionLegs: true
    }
  });
  const portfolioQuery = `?portfolio=${encodeURIComponent(selectedPortfolio.id)}`;
  const used = optionsRiskUsed(ideas);
  const portfolioGreeks = aggregateOptionAnalytics(ideas);
  const concentration = concentrationAnalytics(ideas);
  const compositeRegime = ideas[0]
    ? compositeMarketRegimeFromInput(tradeIdeaToInput(ideas[0]))
    : compositeMarketRegimeFromInput({
        spyTrend: "neutral",
        qqqTrend: "neutral",
        vixCondition: "normal",
        marketBreadth: "neutral"
      });

  return (
    <div className="grid gap-6">
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="field-label">Weighted approval model</p>
          <h1 className="mt-2 text-3xl font-bold text-ink">Risk Model</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-600">
            Viewing {selectedPortfolio.name}. The model uses continuous option/trade-quality functions, adaptive regime weights, refreshable market data, hard stops, and portfolio caps.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <form action={refreshDailyModel}>
            <input type="hidden" name="portfolioId" value={selectedPortfolio.id} />
            <button className="btn-secondary" type="submit">
              Refresh daily model
            </button>
          </form>
          <Link className="btn-secondary" href={`/model-guide${portfolioQuery}`}>
            Read model guide
          </Link>
          <Link className="btn-primary" href={`/trade-ideas${portfolioQuery}`}>
            New scored idea
          </Link>
        </div>
      </header>

      <section className="grid gap-4 md:grid-cols-3">
        <div className="panel-pad">
          <p className="field-label">Base risk</p>
          <p className="mt-2 text-2xl font-bold text-ink">{formatMXN(settings.baseRiskPerTradeMXN)}</p>
          <p className="mt-2 text-sm text-stone-500">{formatNumber(settings.baseRiskPerTradePercent)}% of portfolio.</p>
        </div>
        <div className="panel-pad">
          <p className="field-label">Options sleeve</p>
          <p className="mt-2 text-2xl font-bold text-ink">{formatMXN(settings.maxOptionsSleeveMXN)}</p>
          <p className="mt-2 text-sm text-stone-500">{formatMXN(Math.max(settings.maxOptionsSleeveMXN - used, 0))} remaining.</p>
        </div>
        <div className="panel-pad">
          <p className="field-label">Open options risk</p>
          <p className="mt-2 text-2xl font-bold text-ink">{formatMXN(used)}</p>
          <p className="mt-2 text-sm text-stone-500">Capped at {formatMXN(settings.maxOpenOptionsRiskMXN)}.</p>
        </div>
      </section>

      <section className="panel overflow-hidden">
        <div className="p-5">
          <h2 className="text-lg font-bold text-ink">Composite Market Regime</h2>
          <p className="mt-2 text-sm leading-6 text-stone-600">
            Score {formatNumber(compositeRegime.compositeScore, 2)}, label {compositeRegime.label.replaceAll("_", " ")}, confidence {formatNumber(compositeRegime.confidence * 100, 0)}%.
          </p>
          {compositeRegime.warnings.length ? (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-950">
              {compositeRegime.warnings.map((warning) => (
                <p key={warning}>- {warning}</p>
              ))}
            </div>
          ) : null}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px]">
            <thead className="table-head">
              <tr>
                <th className="px-4 py-3">Component</th>
                <th className="px-4 py-3 text-right">Weight</th>
                <th className="px-4 py-3 text-right">Score</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Reason</th>
              </tr>
            </thead>
            <tbody>
              {compositeRegime.components.map((component) => (
                <tr key={component.name}>
                  <td className="table-cell font-bold text-ink">{component.name}</td>
                  <td className="table-cell text-right">{formatNumber(component.weight * 100, 0)}%</td>
                  <td className="table-cell text-right">{formatNumber(component.score, 2)}</td>
                  <td className="table-cell capitalize">{component.status.replaceAll("_", " ")}</td>
                  <td className="table-cell text-stone-600">{component.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-4">
        <div className="panel-pad">
          <p className="field-label">Portfolio delta</p>
          <p className="mt-2 text-2xl font-bold text-ink">{formatNumber(portfolioGreeks.deltaExposure, 2)}</p>
          <p className="mt-2 text-sm text-stone-500">{portfolioGreeks.activeCount} active option idea(s).</p>
        </div>
        <div className="panel-pad">
          <p className="field-label">Daily theta</p>
          <p className="mt-2 text-2xl font-bold text-ink">{formatMXN(portfolioGreeks.thetaDailyMXN)}</p>
          <p className="mt-2 text-sm text-stone-500">Per day, based on stored Greeks.</p>
        </div>
        <div className="panel-pad">
          <p className="field-label">VaR95 proxy</p>
          <p className="mt-2 text-2xl font-bold text-ink">{formatMXN(portfolioGreeks.var95MXN)}</p>
          <p className="mt-2 text-sm text-stone-500">One-day delta/gamma/vega approximation.</p>
        </div>
        <div className="panel-pad">
          <p className="field-label">CVaR95 proxy</p>
          <p className="mt-2 text-2xl font-bold text-ink">{formatMXN(portfolioGreeks.cvar95MXN)}</p>
          <p className="mt-2 text-sm text-stone-500">Expected shortfall approximation.</p>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
        <div className="panel-pad">
          <h2 className="text-lg font-bold text-ink">Concentration Risk</h2>
          <p className="mt-2 text-sm leading-6 text-stone-600">
            Approved and entered ideas are grouped by sector/theme. The HHI value rises when risk is concentrated in one group, then reduces future sizing through the concentration multiplier.
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-3">
            <StatCard label="HHI" value={formatNumber(concentration.hhi, 3)} detail="0 diversified, 1 fully concentrated." />
            <StatCard label="Top group" value={concentration.topSector?.sector ?? "-"} detail={concentration.topSector ? `${formatNumber(concentration.topSector.weight * 100, 1)}% of active risk` : "No active option risk."} />
            <StatCard label="Size multiplier" value={formatNumber(concentration.concentrationPenalty, 2)} detail="Applied as a risk-control penalty." />
          </div>
          {concentration.warning ? (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">{concentration.warning}</div>
          ) : null}
        </div>

        <div className="panel overflow-hidden">
          <div className="p-5">
            <h2 className="text-lg font-bold text-ink">Sector Exposure</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px]">
              <thead className="table-head">
                <tr>
                  <th className="px-4 py-3">Sector/theme</th>
                  <th className="px-4 py-3 text-right">Risk</th>
                  <th className="px-4 py-3 text-right">Weight</th>
                </tr>
              </thead>
              <tbody>
                {concentration.sectors.map((sector) => (
                  <tr key={sector.sector}>
                    <td className="table-cell font-bold text-ink">{sector.sector}</td>
                    <td className="table-cell text-right">{formatMXN(sector.risk)}</td>
                    <td className="table-cell text-right">{formatNumber(sector.weight * 100, 1)}%</td>
                  </tr>
                ))}
                {!concentration.sectors.length ? (
                  <tr>
                    <td className="table-cell text-stone-500" colSpan={3}>
                      No active option risk to group yet.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <div className="panel-pad">
          <h2 className="text-lg font-bold text-ink">Adaptive Score Weights</h2>
          <p className="mt-2 text-sm leading-6 text-stone-600">
            Values are market / technical / options / trade quality. This implements the PDF regime-dependent weighting before a future HMM layer.
          </p>
          <div className="mt-4 grid gap-3">
            {weights.map((item) => (
              <div className="rounded-lg border border-stone-200 bg-stone-50 p-4" key={item.module}>
                <div className="flex items-center justify-between gap-3">
                  <p className="font-bold text-ink">{item.module}</p>
                  <span className="rounded-full bg-white px-2.5 py-1 text-xs font-bold text-moss">{item.weight}</span>
                </div>
                <p className="mt-2 text-sm leading-5 text-stone-600">{item.description}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="panel-pad">
          <h2 className="text-lg font-bold text-ink">Scored Ideas</h2>
          <ScoreLineChart
            data={ideas
              .filter((idea) => idea.totalScore !== null)
              .slice()
              .reverse()
              .map((idea) => ({ symbol: idea.symbol, score: idea.totalScore ?? 0 }))}
          />
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <div className="panel-pad">
          <h2 className="text-lg font-bold text-ink">Decision Bands</h2>
          <div className="mt-4 grid gap-3">
            {decisions.map((item) => (
              <div className="flex items-center justify-between rounded-lg border border-stone-200 bg-white p-4" key={item.range}>
                <span className="font-bold text-ink">{item.range}</span>
                <DecisionBadge decision={item.decision} />
              </div>
            ))}
          </div>
        </div>

        <div className="panel-pad">
          <h2 className="text-lg font-bold text-ink">Sizing Formula</h2>
          <div className="mt-4 rounded-lg border border-stone-200 bg-stone-50 p-4 font-mono text-sm text-ink">
            suggestedRisk = baseRisk x confidence x liquidity x regime x volatility x concentration x monteCarlo x sentiment x event
          </div>
          <div className="mt-4 grid gap-3">
            {multipliers.map((item) => (
              <div key={item.name}>
                <p className="text-sm font-bold text-ink">{item.name}</p>
                <p className="text-sm leading-5 text-stone-600">{item.detail}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="panel overflow-hidden">
        <div className="p-5">
          <h2 className="text-lg font-bold text-ink">Trade Score Ledger</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1180px]">
            <thead className="table-head">
              <tr>
                <th className="px-4 py-3">Symbol</th>
                <th className="px-4 py-3 text-right">Market</th>
                <th className="px-4 py-3 text-right">Technical</th>
                <th className="px-4 py-3 text-right">Options</th>
                <th className="px-4 py-3 text-right">Trade</th>
                <th className="px-4 py-3 text-right">Total</th>
                <th className="px-4 py-3 text-right">PoP</th>
                <th className="px-4 py-3 text-right">EV</th>
                <th className="px-4 py-3 text-right">Kelly</th>
                <th className="px-4 py-3">Decision</th>
                <th className="px-4 py-3 text-right">Size</th>
              </tr>
            </thead>
            <tbody>
              {ideas.map((idea) => {
                const analytics = analyzeOptionTrade(tradeIdeaToInput(idea), settings);

                return (
                  <tr key={idea.id}>
                    <td className="table-cell font-bold text-ink">{idea.symbol}</td>
                    <td className="table-cell text-right">{formatNumber(idea.marketRegimeScore, 1)}</td>
                    <td className="table-cell text-right">{formatNumber(idea.technicalScore, 1)}</td>
                    <td className="table-cell text-right">{formatNumber(idea.optionsQualityScore, 1)}</td>
                    <td className="table-cell text-right">{formatNumber(idea.tradeQualityScore, 1)}</td>
                    <td className="table-cell text-right font-bold">{formatNumber(idea.totalScore, 1)}</td>
                    <td className="table-cell text-right">
                      {analytics.probabilityOfProfit === null ? "-" : `${formatNumber(analytics.probabilityOfProfit * 100, 1)}%`}
                    </td>
                    <td className="table-cell text-right">{analytics.expectedValueMXN === null ? "-" : formatMXN(analytics.expectedValueMXN)}</td>
                    <td className="table-cell text-right">{analytics.kellyRiskMXN === null ? "-" : formatMXN(analytics.kellyRiskMXN)}</td>
                    <td className="table-cell">
                      <DecisionBadge decision={idea.decision} />
                    </td>
                    <td className="table-cell text-right font-semibold">{formatMXN(idea.suggestedRiskMXN)}</td>
                  </tr>
                );
              })}
              {!ideas.length ? (
                <tr>
                  <td className="table-cell text-stone-500" colSpan={11}>
                    No scored ideas yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
