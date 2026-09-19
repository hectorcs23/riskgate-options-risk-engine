import { Trash2 } from "lucide-react";
import { deletePosition, recordPortfolioSnapshot, refreshPortfolioPricesAndSnapshot } from "@/app/actions";
import { GbmImportForm } from "@/components/gbm-import-form";
import { IntradayPerformanceChart } from "@/components/charts";
import { PositionForm } from "@/components/position-form";
import { StatCard } from "@/components/stat-card";
import { prisma } from "@/lib/db";
import { getRiskSettings, getSelectedPortfolio } from "@/lib/data";
import { formatMXN, formatNumber } from "@/lib/format";
import { ensurePortfolioSnapshot, getIntradayPerformance } from "@/lib/performance";
import { refreshPortfolioMarketPrices } from "@/lib/portfolio-prices";
import {
  positionCostBasis,
  positionMarketValue,
  positionPnl,
  positionPnlPercent,
  summarizePositions
} from "@/lib/calculations";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<{ imported?: string; portfolio?: string }>;
};

export default async function PortfolioPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const { selectedPortfolio } = await getSelectedPortfolio(params?.portfolio);
  await refreshPortfolioMarketPrices(selectedPortfolio.id);
  const settings = await getRiskSettings(selectedPortfolio.id);
  const positions = await prisma.position.findMany({
    where: { portfolioId: selectedPortfolio.id },
    orderBy: [{ assetType: "asc" }, { symbol: "asc" }]
  });
  const summary = summarizePositions(positions, settings);
  await ensurePortfolioSnapshot({
    portfolioId: selectedPortfolio.id,
    totalValue: summary.totalValue,
    cashValue: summary.cash,
    stockValue: summary.stocks,
    optionValue: summary.options,
    source: "portfolio"
  });
  const intraday = await getIntradayPerformance(selectedPortfolio.id, summary.totalValue);

  return (
    <div className="grid gap-6">
      <header>
        <p className="field-label">Manual position tracking</p>
        <h1 className="mt-2 text-3xl font-bold text-ink">Portfolio</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-600">
          Viewing {selectedPortfolio.name}. RiskGate can refresh delayed Yahoo quotes for tracked positions, convert U.S. quotes to MXN, and record snapshots without broker credentials.
        </p>
      </header>

      {params?.imported ? (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm font-semibold text-emerald-900">
          {params.imported === "0"
            ? "No GBM positions were found in that file."
            : `Imported ${params.imported} position${params.imported === "1" ? "" : "s"} into ${selectedPortfolio.name}.`}
        </div>
      ) : null}

      <section className="grid gap-4 md:grid-cols-4">
        <StatCard label="Total tracked value" value={formatMXN(summary.totalValue)} detail={summary.manualValue > 0 ? "From entered positions." : "Using settings fallback."} />
        <StatCard label="Cash" value={formatMXN(summary.cash)} detail={`${formatNumber((summary.cash / summary.totalValue) * 100)}% weight`} />
        <StatCard label="Stocks / ETFs" value={formatMXN(summary.stocks)} detail={`${formatNumber((summary.stocks / summary.totalValue) * 100)}% weight`} />
        <StatCard label="Options" value={formatMXN(summary.options)} detail={`${formatNumber((summary.options / summary.totalValue) * 100)}% weight`} />
      </section>

      <section className="grid gap-4 lg:grid-cols-[1fr_2fr]">
        <div className="panel-pad">
          <p className="field-label">Today</p>
          <p className={intraday.intradayChangeMXN >= 0 ? "mt-2 text-3xl font-bold text-emerald-700" : "mt-2 text-3xl font-bold text-red-700"}>
            {formatMXN(intraday.intradayChangeMXN)}
          </p>
          <p className="mt-1 text-sm text-stone-600">
            {intraday.intradayChangeMXN >= 0 ? "+" : ""}
            {formatNumber(intraday.intradayChangePercent, 2)}% since first snapshot today.
          </p>
          <p className="mt-3 text-sm text-stone-500">
            {intraday.snapshotCount} snapshot{intraday.snapshotCount === 1 ? "" : "s"} recorded today.
          </p>
          <form action={recordPortfolioSnapshot} className="mt-4">
            <input type="hidden" name="portfolioId" value={selectedPortfolio.id} />
            <input type="hidden" name="source" value="manual_portfolio" />
            <button className="btn-primary w-full" type="submit">
              Record snapshot
            </button>
          </form>
          <form action={refreshPortfolioPricesAndSnapshot} className="mt-3">
            <input type="hidden" name="portfolioId" value={selectedPortfolio.id} />
            <button className="btn-secondary w-full" type="submit">
              Refresh prices + snapshot
            </button>
          </form>
        </div>
        <div className="panel-pad">
          <h2 className="text-lg font-bold text-ink">Intraday Performance</h2>
          <p className="mt-1 text-sm leading-6 text-stone-600">
            The line uses your recorded portfolio values. Import GBM files or edit prices during the day, then record a new snapshot.
          </p>
          <IntradayPerformanceChart data={intraday.chartData} />
        </div>
      </section>

      <section className="panel-pad">
        <h2 className="text-lg font-bold text-ink">Import GBM Excel</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-600">
          Upload the GBM portfolio detail file for this account. The importer reads ticker rows and liquidity, converts USD values to MXN using the rate below, and updates the selected portfolio.
        </p>
        <div className="mt-4">
          <GbmImportForm portfolioId={selectedPortfolio.id} />
        </div>
      </section>

      <section className="panel-pad">
        <h2 className="text-lg font-bold text-ink">Add Position</h2>
        <div className="mt-4">
          <PositionForm portfolioId={selectedPortfolio.id} />
        </div>
      </section>

      <section className="panel overflow-hidden">
        <div className="p-5">
          <h2 className="text-lg font-bold text-ink">Open Positions</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px]">
            <thead className="table-head">
              <tr>
                <th className="px-4 py-3">Symbol</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Market</th>
                <th className="px-4 py-3 text-right">Qty</th>
                <th className="px-4 py-3 text-right">Avg cost</th>
                <th className="px-4 py-3 text-right">Price</th>
                <th className="px-4 py-3 text-right">Value</th>
                <th className="px-4 py-3 text-right">P&L</th>
                <th className="px-4 py-3 text-right">Weight</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((position) => {
                const marketValue = positionMarketValue(position);
                const pnl = positionPnl(position);
                const weight = summary.totalValue ? (marketValue / summary.totalValue) * 100 : 0;

                return (
                  <tr key={position.id} className="align-top">
                    <td className="table-cell font-bold text-ink">{position.symbol}</td>
                    <td className="table-cell capitalize">{position.assetType}</td>
                    <td className="table-cell">{position.market}</td>
                    <td className="table-cell text-right">{formatNumber(position.quantity, 4)}</td>
                    <td className="table-cell text-right">{formatMXN(position.averageCost)}</td>
                    <td className="table-cell text-right">{formatMXN(position.currentPrice)}</td>
                    <td className="table-cell text-right font-semibold">{formatMXN(marketValue)}</td>
                    <td className={pnl >= 0 ? "table-cell text-right text-emerald-700" : "table-cell text-right text-red-700"}>
                      {formatMXN(pnl)}
                      <span className="ml-1 text-xs">({formatNumber(positionPnlPercent(position))}%)</span>
                    </td>
                    <td className="table-cell text-right">{formatNumber(weight)}%</td>
                    <td className="table-cell">
                      <div className="flex flex-wrap gap-2">
                        <details className="w-full max-w-xl rounded-md border border-stone-200 bg-stone-50 p-3">
                          <summary className="cursor-pointer text-sm font-semibold text-ink">Edit</summary>
                          <div className="mt-4">
                            <PositionForm portfolioId={selectedPortfolio.id} position={position} />
                          </div>
                          <p className="mt-3 text-xs text-stone-500">
                            Cost basis: {formatMXN(positionCostBasis(position))}
                          </p>
                        </details>
                        <form action={deletePosition}>
                          <input type="hidden" name="id" value={position.id} />
                          <button className="btn-danger" type="submit">
                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                            Delete
                          </button>
                        </form>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!positions.length ? (
                <tr>
                  <td className="table-cell text-stone-500" colSpan={10}>
                    Add a cash line and your first stock position to start calculating allocation.
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
