import { RefreshCw, Trash2 } from "lucide-react";
import {
  createWatchlistItem,
  deleteWatchlistItem,
  refreshPortfolioWatchlist,
  refreshWatchlistItem,
  updateWatchlistItem
} from "@/app/actions";
import { prisma } from "@/lib/db";
import { getSelectedPortfolio } from "@/lib/data";
import { formatCurrency, formatNumber } from "@/lib/format";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<{ portfolio?: string }>;
};

function dateLabel(value: Date | null) {
  if (!value) return "Never";
  return value.toLocaleString("es-MX", {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

export default async function WatchlistPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const { selectedPortfolio } = await getSelectedPortfolio(params?.portfolio);
  const items = await prisma.watchlistItem.findMany({
    where: { portfolioId: selectedPortfolio.id },
    orderBy: [{ symbol: "asc" }]
  });

  return (
    <div className="grid gap-6">
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="field-label">Tracked symbols</p>
          <h1 className="mt-2 text-3xl font-bold text-ink">Watchlist</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-600">
            Viewing {selectedPortfolio.name}. These are the tickers RiskGate follows for portfolio context, trade ideas, and future technical/model automation. Quote refresh runs from the button so the page stays available when Yahoo is slow.
          </p>
        </div>
        <form action={refreshPortfolioWatchlist}>
          <input type="hidden" name="portfolioId" value={selectedPortfolio.id} />
          <button className="btn-primary" type="submit">
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Refresh Yahoo quotes
          </button>
        </form>
      </header>

      <section className="rounded-lg border border-sky-200 bg-sky-50 p-5 text-sm leading-6 text-sky-950">
        <p className="font-bold">How ticker tracking works</p>
        <p className="mt-1">
          RiskGate stores the watchlist locally in SQLite. Quote refresh uses the Yahoo Finance public chart endpoint for latest/previous close data, then saves the values locally. If that source fails or changes, you can still edit prices manually.
        </p>
      </section>

      <section className="panel-pad">
        <h2 className="text-lg font-bold text-ink">Add Ticker</h2>
        <form action={createWatchlistItem} className="mt-4 grid gap-4 md:grid-cols-6">
          <input type="hidden" name="portfolioId" value={selectedPortfolio.id} />
          <label>
            <span className="field-label">Symbol</span>
            <input className="field-input" name="symbol" required placeholder="MSFT" />
          </label>
          <label>
            <span className="field-label">Name</span>
            <input className="field-input" name="name" placeholder="Optional" />
          </label>
          <label>
            <span className="field-label">Market</span>
            <select className="field-input" name="market" defaultValue="US">
              <option value="US">US</option>
              <option value="MX">MX</option>
              <option value="INDEX">INDEX</option>
            </select>
          </label>
          <label>
            <span className="field-label">Currency</span>
            <select className="field-input" name="currency" defaultValue="USD">
              <option value="USD">USD</option>
              <option value="MXN">MXN</option>
            </select>
          </label>
          <label>
            <span className="field-label">Source</span>
            <select className="field-input" name="dataSource" defaultValue="yahoo">
              <option value="yahoo">Yahoo</option>
              <option value="manual">Manual</option>
            </select>
          </label>
          <div className="flex items-end">
            <button className="btn-primary w-full" type="submit">
              Add ticker
            </button>
          </div>
        </form>
      </section>

      <section className="panel overflow-hidden">
        <div className="p-5">
          <h2 className="text-lg font-bold text-ink">Following</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1040px]">
            <thead className="table-head">
              <tr>
                <th className="px-4 py-3">Symbol</th>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Source</th>
                <th className="px-4 py-3 text-right">Last</th>
                <th className="px-4 py-3 text-right">Prev close</th>
                <th className="px-4 py-3 text-right">Day change</th>
                <th className="px-4 py-3">Updated</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const positive = (item.dayChange ?? 0) >= 0;

                return (
                  <tr key={item.id} className="align-top">
                    <td className="table-cell font-bold text-ink">{item.symbol}</td>
                    <td className="table-cell">{item.name ?? "-"}</td>
                    <td className="table-cell capitalize">{item.dataSource}</td>
                    <td className="table-cell text-right font-semibold">
                      {item.currentPrice === null || item.currentPrice === undefined
                        ? "-"
                        : formatCurrency(item.currentPrice, item.currency)}
                    </td>
                    <td className="table-cell text-right">
                      {item.previousClose === null || item.previousClose === undefined
                        ? "-"
                        : formatCurrency(item.previousClose, item.currency)}
                    </td>
                    <td className={positive ? "table-cell text-right text-emerald-700" : "table-cell text-right text-red-700"}>
                      {item.dayChange === null || item.dayChange === undefined
                        ? "-"
                        : `${formatCurrency(item.dayChange, item.currency)} (${formatNumber(item.dayChangePercent, 2)}%)`}
                    </td>
                    <td className="table-cell">{dateLabel(item.lastUpdated)}</td>
                    <td className="table-cell">
                      <div className="flex flex-wrap gap-2">
                        <form action={refreshWatchlistItem}>
                          <input type="hidden" name="id" value={item.id} />
                          <input type="hidden" name="symbol" value={item.symbol} />
                          <button className="btn-secondary" type="submit">
                            <RefreshCw className="h-4 w-4" aria-hidden="true" />
                            Refresh
                          </button>
                        </form>
                        <details className="w-full max-w-xl rounded-md border border-stone-200 bg-stone-50 p-3">
                          <summary className="cursor-pointer text-sm font-semibold text-ink">Edit</summary>
                          <form action={updateWatchlistItem} className="mt-4 grid gap-4">
                            <input type="hidden" name="id" value={item.id} />
                            <div className="grid gap-4 md:grid-cols-3">
                              <label>
                                <span className="field-label">Symbol</span>
                                <input className="field-input" name="symbol" required defaultValue={item.symbol} />
                              </label>
                              <label>
                                <span className="field-label">Name</span>
                                <input className="field-input" name="name" defaultValue={item.name ?? ""} />
                              </label>
                              <label>
                                <span className="field-label">Source</span>
                                <select className="field-input" name="dataSource" defaultValue={item.dataSource}>
                                  <option value="yahoo">Yahoo</option>
                                  <option value="manual">Manual</option>
                                </select>
                              </label>
                            </div>
                            <div className="grid gap-4 md:grid-cols-5">
                              <label>
                                <span className="field-label">Market</span>
                                <input className="field-input" name="market" defaultValue={item.market} />
                              </label>
                              <label>
                                <span className="field-label">Currency</span>
                                <input className="field-input" name="currency" defaultValue={item.currency} />
                              </label>
                              <label>
                                <span className="field-label">Last</span>
                                <input className="field-input" name="currentPrice" type="number" step="0.0001" defaultValue={item.currentPrice ?? ""} />
                              </label>
                              <label>
                                <span className="field-label">Prev close</span>
                                <input className="field-input" name="previousClose" type="number" step="0.0001" defaultValue={item.previousClose ?? ""} />
                              </label>
                              <label>
                                <span className="field-label">Day %</span>
                                <input className="field-input" name="dayChangePercent" type="number" step="0.01" defaultValue={item.dayChangePercent ?? ""} />
                              </label>
                            </div>
                            <input type="hidden" name="dayChange" value={item.dayChange ?? ""} />
                            <label>
                              <span className="field-label">Notes</span>
                              <textarea className="field-input min-h-20" name="notes" defaultValue={item.notes ?? ""} />
                            </label>
                            <button className="btn-primary" type="submit">
                              Save ticker
                            </button>
                          </form>
                        </details>
                        <form action={deleteWatchlistItem}>
                          <input type="hidden" name="id" value={item.id} />
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
              {!items.length ? (
                <tr>
                  <td className="table-cell text-stone-500" colSpan={8}>
                    Add SPY, QQQ, ^VIX, your holdings, or any symbol you want to monitor.
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
