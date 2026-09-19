import Link from "next/link";
import { Trash2 } from "lucide-react";
import { deleteJournalEntry } from "@/app/actions";
import { JournalForm } from "@/components/journal-form";
import { StatCard } from "@/components/stat-card";
import { prisma } from "@/lib/db";
import { getSelectedPortfolio } from "@/lib/data";
import { formatMXN, formatNumber } from "@/lib/format";
import { journalBootstrap, journalStats, scoreBandBacktest } from "@/lib/calculations";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<{ portfolio?: string }>;
};

export default async function JournalPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const { selectedPortfolio } = await getSelectedPortfolio(params?.portfolio);
  const [tradeIdeas, journal] = await Promise.all([
    prisma.tradeIdea.findMany({
      where: { portfolioId: selectedPortfolio.id },
      orderBy: { createdAt: "desc" }
    }),
    prisma.tradeJournal.findMany({
      where: { tradeIdea: { portfolioId: selectedPortfolio.id } },
      orderBy: { entryDate: "desc" },
      include: { tradeIdea: true }
    })
  ]);
  const stats = journalStats(journal);
  const bandBacktest = scoreBandBacktest(journal);
  const bootstrap = journalBootstrap(journal);
  const portfolioQuery = `?portfolio=${encodeURIComponent(selectedPortfolio.id)}`;

  return (
    <div className="grid gap-6">
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="field-label">Performance feedback loop</p>
          <h1 className="mt-2 text-3xl font-bold text-ink">Trade Journal</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-600">
            Viewing {selectedPortfolio.name}. Track entered and closed options trades so sizing rules stay aligned with this account results.
          </p>
        </div>
        <Link className="btn-secondary" href={`/trade-ideas${portfolioQuery}`}>
          Manage ideas
        </Link>
      </header>

      <section className="grid gap-4 md:grid-cols-5">
        <StatCard label="Win rate" value={`${formatNumber(stats.winRate)}%`} detail={`${stats.closedCount} closed trades`} />
        <StatCard label="Average win" value={formatMXN(stats.averageWin)} />
        <StatCard label="Average loss" value={formatMXN(stats.averageLoss)} />
        <StatCard label="Expectancy" value={formatMXN(stats.expectancy)} />
        <StatCard label="Total options P&L" value={formatMXN(stats.totalPnl)} />
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <StatCard label="Sharpe proxy" value={formatNumber(stats.sharpe, 2)} detail="Based on closed-trade P&L, not daily returns." />
        <StatCard label="Sortino proxy" value={formatNumber(stats.sortino, 2)} detail="Uses downside P&L dispersion." />
        <StatCard label="Avg duration" value={`${formatNumber(stats.averageDurationDays, 1)} days`} detail={`P&L stdev ${formatMXN(stats.pnlStdDev)}`} />
      </section>

      <section className="panel-pad">
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div>
            <h2 className="text-lg font-bold text-ink">Bootstrap Confidence</h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-stone-600">
              Resamples closed trades to estimate how stable the journal stats are. Wide intervals mean the model needs more closed trades before the numbers deserve trust.
            </p>
          </div>
          <span className="rounded-full bg-stone-100 px-3 py-1 text-xs font-bold text-stone-600">
            {bootstrap.enoughData ? "95% interval" : "Need 5+ closed trades"}
          </span>
        </div>
        {bootstrap.enoughData ? (
          <div className="mt-4 grid gap-4 md:grid-cols-3">
            <StatCard
              label="Win rate interval"
              value={`${formatNumber(bootstrap.winRateCI[0], 1)}% to ${formatNumber(bootstrap.winRateCI[1], 1)}%`}
              detail="Closed-trade resampling."
            />
            <StatCard
              label="Expectancy interval"
              value={`${formatMXN(bootstrap.expectancyCI[0])} to ${formatMXN(bootstrap.expectancyCI[1])}`}
              detail="Expected P&L per trade."
            />
            <StatCard
              label="Sharpe interval"
              value={`${formatNumber(bootstrap.sharpeCI[0], 2)} to ${formatNumber(bootstrap.sharpeCI[1], 2)}`}
              detail="Proxy from closed-trade P&L."
            />
          </div>
        ) : (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-900">
            Close at least 5 trades before using win rate, expectancy, or Sharpe as calibration evidence. Until then, keep sizing capped by the fixed risk settings.
          </div>
        )}
      </section>

      <section className="panel overflow-hidden">
        <div className="p-5">
          <h2 className="text-lg font-bold text-ink">Score Band Backtest</h2>
          <p className="mt-1 text-sm leading-6 text-stone-600">
            This checks whether higher model scores are actually producing better closed-trade outcomes in this portfolio.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px]">
            <thead className="table-head">
              <tr>
                <th className="px-4 py-3">Score band</th>
                <th className="px-4 py-3 text-right">Trades</th>
                <th className="px-4 py-3 text-right">Win rate</th>
                <th className="px-4 py-3 text-right">Avg win</th>
                <th className="px-4 py-3 text-right">Avg loss</th>
                <th className="px-4 py-3 text-right">Expectancy</th>
                <th className="px-4 py-3 text-right">Total P&L</th>
              </tr>
            </thead>
            <tbody>
              {bandBacktest.map((band) => (
                <tr key={band.label}>
                  <td className="table-cell font-bold text-ink">{band.label}</td>
                  <td className="table-cell text-right">{band.count}</td>
                  <td className="table-cell text-right">{formatNumber(band.winRate)}%</td>
                  <td className="table-cell text-right">{formatMXN(band.averageWin)}</td>
                  <td className="table-cell text-right">{formatMXN(band.averageLoss)}</td>
                  <td className="table-cell text-right">{formatMXN(band.expectancy)}</td>
                  <td className="table-cell text-right">{formatMXN(band.totalPnl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel-pad">
        <h2 className="text-lg font-bold text-ink">Add Journal Entry</h2>
        {tradeIdeas.length ? (
          <div className="mt-4">
            <JournalForm tradeIdeas={tradeIdeas} />
          </div>
        ) : (
          <p className="mt-3 text-sm text-stone-500">Create a trade idea before adding journal entries.</p>
        )}
      </section>

      <section className="panel overflow-hidden">
        <div className="p-5">
          <h2 className="text-lg font-bold text-ink">Entries</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px]">
            <thead className="table-head">
              <tr>
                <th className="px-4 py-3">Trade</th>
                <th className="px-4 py-3">Entry</th>
                <th className="px-4 py-3">Exit</th>
                <th className="px-4 py-3 text-right">Entry price</th>
                <th className="px-4 py-3 text-right">Exit price</th>
                <th className="px-4 py-3 text-right">P&L</th>
                <th className="px-4 py-3">Result</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {journal.map((entry) => {
                const pnl = entry.realizedPnL ?? 0;

                return (
                  <tr key={entry.id} className="align-top">
                    <td className="table-cell">
                      <p className="font-bold text-ink">{entry.tradeIdea.symbol}</p>
                      <p className="text-xs text-stone-500">{entry.tradeIdea.strategy.replaceAll("_", " ")}</p>
                    </td>
                    <td className="table-cell">{entry.entryDate.toLocaleDateString("es-MX")}</td>
                    <td className="table-cell">{entry.exitDate?.toLocaleDateString("es-MX") ?? "Open"}</td>
                    <td className="table-cell text-right">{formatMXN(entry.entryPrice)}</td>
                    <td className="table-cell text-right">{entry.exitPrice ? formatMXN(entry.exitPrice) : "-"}</td>
                    <td className={pnl >= 0 ? "table-cell text-right text-emerald-700" : "table-cell text-right text-red-700"}>
                      {entry.realizedPnL === null || entry.realizedPnL === undefined ? "-" : formatMXN(pnl)}
                    </td>
                    <td className="table-cell capitalize">{entry.result ?? "open"}</td>
                    <td className="table-cell">
                      <div className="flex flex-wrap gap-2">
                        <details className="w-full max-w-xl rounded-md border border-stone-200 bg-stone-50 p-3">
                          <summary className="cursor-pointer text-sm font-semibold text-ink">Edit</summary>
                          <div className="mt-4">
                            <JournalForm entry={entry} tradeIdeas={tradeIdeas} />
                          </div>
                        </details>
                        <form action={deleteJournalEntry}>
                          <input type="hidden" name="id" value={entry.id} />
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
              {!journal.length ? (
                <tr>
                  <td className="table-cell text-stone-500" colSpan={8}>
                    No journal entries yet.
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
