import Link from "next/link";
import { AlertTriangle, CheckCircle2, ShieldCheck } from "lucide-react";
import { recordPortfolioSnapshot, refreshDailyModel, refreshPortfolioPricesAndSnapshot } from "@/app/actions";
import { prisma } from "@/lib/db";
import { getRiskSettings, getSelectedPortfolio } from "@/lib/data";
import { formatMXN, formatNumber } from "@/lib/format";
import { journalStats, optionsRiskUsed, summarizePositions } from "@/lib/calculations";
import { AllocationChart, EquityCurve, IntradayPerformanceChart, RiskBarChart } from "@/components/charts";
import { ensurePortfolioSnapshot, getIntradayPerformance } from "@/lib/performance";
import { DecisionBadge } from "@/components/decision-badge";
import { StatCard } from "@/components/stat-card";
import { buildIdeaDisplayGroups } from "@/lib/idea-variants";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<{ portfolio?: string }>;
};

function shortDate(value: Date | null | undefined) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(value);
}

export default async function DashboardPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const { selectedPortfolio } = await getSelectedPortfolio(params?.portfolio);
  const settings = await getRiskSettings(selectedPortfolio.id);
  const [positions, tradeIdeas, journal] = await Promise.all([
    prisma.position.findMany({ where: { portfolioId: selectedPortfolio.id }, orderBy: { symbol: "asc" } }),
    prisma.tradeIdea.findMany({ where: { portfolioId: selectedPortfolio.id }, orderBy: { createdAt: "desc" } }),
    prisma.tradeJournal.findMany({
      where: { tradeIdea: { portfolioId: selectedPortfolio.id } },
      orderBy: { entryDate: "asc" }
    })
  ]);
  const portfolioQuery = `?portfolio=${encodeURIComponent(selectedPortfolio.id)}`;
  const summary = summarizePositions(positions, settings);
  await ensurePortfolioSnapshot({
    portfolioId: selectedPortfolio.id,
    totalValue: summary.totalValue,
    cashValue: summary.cash,
    stockValue: summary.stocks,
    optionValue: summary.options,
    source: "dashboard"
  });
  const intraday = await getIntradayPerformance(selectedPortfolio.id, summary.totalValue);
  const riskUsed = optionsRiskUsed(tradeIdeas);
  const stats = journalStats(journal);
  const openTrades = tradeIdeas.filter((idea) => idea.status === "entered").length;
  const approvedTrades = tradeIdeas.filter((idea) => idea.decision?.startsWith("approved")).length;
  const recentTickerIdeas = buildIdeaDisplayGroups(tradeIdeas)
    .map((group) => group.representative)
    .sort(
      (left, right) =>
        (right.lastEvaluatedAt ?? right.updatedAt ?? right.createdAt).getTime() -
        (left.lastEvaluatedAt ?? left.updatedAt ?? left.createdAt).getTime()
    );
  const allocationData = [
    { name: "Cash", value: summary.cash },
    { name: "Stocks / ETFs", value: summary.stocks },
    { name: "Options", value: summary.options },
    {
      name: "Unallocated",
      value: Math.max(summary.totalValue - summary.cash - summary.stocks - summary.options, 0)
    }
  ];
  let runningEquity = settings.totalPortfolioValue;
  const equityData = [
    { label: "Start", value: settings.totalPortfolioValue },
    ...journal
      .filter((entry) => entry.realizedPnL !== null && entry.realizedPnL !== undefined)
      .map((entry) => {
        runningEquity += entry.realizedPnL ?? 0;
        return {
          label: entry.exitDate?.toLocaleDateString("es-MX", { month: "short", day: "numeric" }) ?? "Open",
          value: runningEquity
        };
      }),
    { label: "Now", value: summary.totalValue }
  ];

  return (
    <div className="grid gap-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="field-label">Local-first trading console</p>
          <h1 className="mt-2 text-3xl font-bold text-ink">RiskGate Dashboard</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-600">
            Viewing {selectedPortfolio.name}. Manual portfolio tracking, option idea scoring, and position sizing guardrails stay scoped to this account. Use the refresh buttons when you want live Yahoo/Alpaca data updated.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <form action={refreshDailyModel}>
            <input type="hidden" name="portfolioId" value={selectedPortfolio.id} />
            <button className="btn-secondary" type="submit">
              Refresh daily model
            </button>
          </form>
          <form action={refreshPortfolioPricesAndSnapshot}>
            <input type="hidden" name="portfolioId" value={selectedPortfolio.id} />
            <button className="btn-secondary" type="submit">
              Refresh prices
            </button>
          </form>
          <Link className="btn-primary" href={`/trade-ideas${portfolioQuery}`}>
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
            Score a trade
          </Link>
        </div>
      </header>

      <section className="grid gap-3 md:grid-cols-3">
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
          <div className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            Options risk warning
          </div>
          <p className="mt-1 leading-5">Options are risky and can expire worthless.</p>
        </div>
        <div className="rounded-lg border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950">
          <div className="flex items-center gap-2 font-semibold">
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            Decision support only
          </div>
          <p className="mt-1 leading-5">The model is not financial advice.</p>
        </div>
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-950">
          <div className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            No broker passwords
          </div>
          <p className="mt-1 leading-5">Do not enter GBM or broker credentials here.</p>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total equity" value={formatMXN(summary.totalValue)} detail="Uses manual positions when available." />
        <StatCard label="Cash" value={formatMXN(summary.cash)} detail={`${formatNumber((summary.cash / summary.totalValue) * 100)}% of account`} />
        <StatCard label="Stock exposure" value={formatMXN(summary.stocks)} detail={`${formatNumber((summary.stocks / summary.totalValue) * 100)}% of account`} />
        <StatCard label="Options exposure" value={formatMXN(summary.options)} detail={`${formatNumber((summary.options / summary.totalValue) * 100)}% of account`} />
        <StatCard
          label="Intraday change"
          value={formatMXN(intraday.intradayChangeMXN)}
          detail={`${intraday.intradayChangeMXN >= 0 ? "+" : ""}${formatNumber(intraday.intradayChangePercent, 2)}% since first snapshot`}
        />
        <StatCard
          label="Last snapshot move"
          value={formatMXN(intraday.lastChangeMXN)}
          detail={`${intraday.snapshotCount} snapshot${intraday.snapshotCount === 1 ? "" : "s"} today`}
        />
        <StatCard label="Options risk used" value={formatMXN(riskUsed)} detail={`${formatMXN(settings.maxOptionsSleeveMXN)} sleeve limit`} />
        <StatCard label="Monthly options loss cap" value={formatMXN(settings.maxMonthlyOptionsLossMXN)} detail={`${formatMXN(stats.totalPnl)} total options P&L`} />
        <StatCard label="Open trades" value={openTrades} detail="Journal-linked entered ideas." />
        <StatCard label="Model-approved ideas" value={approvedTrades} detail="Approved small or normal." />
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <div className="panel-pad">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-bold text-ink">Portfolio Allocation</h2>
            <Link className="text-sm font-semibold text-moss hover:text-ink" href={`/portfolio${portfolioQuery}`}>
              Manage
            </Link>
          </div>
          <AllocationChart data={allocationData} />
        </div>
        <div className="panel-pad">
          <h2 className="text-lg font-bold text-ink">Equity Curve</h2>
          <EquityCurve data={equityData} />
        </div>
      </section>

      <section className="panel-pad">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <h2 className="text-lg font-bold text-ink">Intraday Portfolio Performance</h2>
            <p className="mt-1 text-sm leading-6 text-stone-600">
              Tracks this portfolio from the first snapshot recorded today. Refresh/import prices, then record a snapshot to build the line.
            </p>
          </div>
          <form action={recordPortfolioSnapshot}>
            <input type="hidden" name="portfolioId" value={selectedPortfolio.id} />
            <input type="hidden" name="source" value="manual_dashboard" />
            <button className="btn-secondary" type="submit">
              Record snapshot
            </button>
          </form>
        </div>
        <IntradayPerformanceChart data={intraday.chartData} />
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <div className="panel-pad">
          <h2 className="text-lg font-bold text-ink">Risk Exposure</h2>
          <RiskBarChart
            data={[
              { name: "Sleeve", used: riskUsed, limit: settings.maxOptionsSleeveMXN },
              { name: "Monthly", used: Math.max(-stats.totalPnl, 0), limit: settings.maxMonthlyOptionsLossMXN },
              { name: "Open Risk", used: riskUsed, limit: settings.maxOpenOptionsRiskMXN }
            ]}
          />
        </div>

        <div className="panel overflow-hidden">
          <div className="flex items-center justify-between gap-3 p-5">
            <h2 className="text-lg font-bold text-ink">Recent Trade Ideas</h2>
            <Link className="text-sm font-semibold text-moss hover:text-ink" href={`/trade-ideas${portfolioQuery}`}>
              View all
            </Link>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px]">
              <thead className="table-head">
                <tr>
                  <th className="px-4 py-3">Ticker</th>
                  <th className="px-4 py-3">Direction</th>
                  <th className="px-4 py-3">Score</th>
                  <th className="px-4 py-3">Decision</th>
                  <th className="px-4 py-3">Created</th>
                  <th className="px-4 py-3">Last evaluated</th>
                  <th className="px-4 py-3 text-right">Suggested Size</th>
                </tr>
              </thead>
              <tbody>
                {recentTickerIdeas.slice(0, 6).map((idea) => (
                  <tr key={idea.id}>
                    <td className="table-cell font-bold text-ink">{idea.symbol}</td>
                    <td className="table-cell capitalize">{idea.direction}</td>
                    <td className="table-cell">{idea.totalScore ?? 0}/100</td>
                    <td className="table-cell">
                      <DecisionBadge decision={idea.decision} />
                    </td>
                    <td className="table-cell">{shortDate(idea.createdAt)}</td>
                    <td className="table-cell">{shortDate(idea.lastEvaluatedAt)}</td>
                    <td className="table-cell text-right font-semibold">{formatMXN(idea.suggestedRiskMXN)}</td>
                  </tr>
                ))}
                {!tradeIdeas.length ? (
                  <tr>
                    <td className="table-cell text-stone-500" colSpan={7}>
                      No trade ideas yet.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}
