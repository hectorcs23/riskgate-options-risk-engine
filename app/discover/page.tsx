import Link from "next/link";
import { FilePlus2, Plus, Radar, Search, ShieldCheck } from "lucide-react";
import { createTradeIdeaFromDiscovery, createWatchlistItem } from "@/app/actions";
import { StatCard } from "@/components/stat-card";
import { prisma } from "@/lib/db";
import { discoverStocks, type DiscoveryCandidate } from "@/lib/discovery";
import { getSelectedPortfolio } from "@/lib/data";
import { formatCurrency, formatNumber } from "@/lib/format";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<Record<string, string | undefined>>;
};

function numberParam(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function compact(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1
  }).format(value);
}

function percent(value: number | null | undefined) {
  if (value === null || value === undefined) return "-";
  return `${formatNumber(value, 2)}%`;
}

function sourceTone(status: string) {
  if (status === "ok") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "partial") return "border-amber-200 bg-amber-50 text-amber-900";
  if (status === "skipped") return "border-stone-200 bg-stone-50 text-stone-700";
  return "border-red-200 bg-red-50 text-red-800";
}

function scoreTone(score: number) {
  if (score >= 80) return "text-emerald-700";
  if (score >= 65) return "text-lime-700";
  if (score >= 50) return "text-amber-700";
  return "text-stone-700";
}

function candidateIdeaHref(candidate: DiscoveryCandidate, portfolioId: string) {
  const direction = candidate.bias === "mixed" ? "neutral" : candidate.bias;
  const params = new URLSearchParams({
    portfolio: portfolioId,
    symbol: candidate.symbol,
    direction,
    strategy: direction === "bearish" ? "long_put" : "long_call",
    thesis: `Discovery candidate. Score ${candidate.discoveryScore.toFixed(1)}/100. ${candidate.reasons.join(" ")}`,
    catalyst: candidate.sources.join(", "),
    dayChange: candidate.dayChangePercent?.toString() ?? "",
    volumeRatio: candidate.volumeRatio?.toString() ?? ""
  });

  return `/trade-ideas?${params.toString()}`;
}

function hiddenDiscoveryFields(candidate: DiscoveryCandidate) {
  const fields: Record<string, string | number | boolean | null | undefined> = {
    symbol: candidate.symbol,
    name: candidate.name,
    price: candidate.price,
    dayChangePercent: candidate.dayChangePercent,
    volume: candidate.volume,
    averageVolume: candidate.averageVolume,
    volumeRatio: candidate.volumeRatio,
    marketCap: candidate.marketCap,
    currency: candidate.currency,
    market: candidate.market,
    sources: candidate.sources.join("\n"),
    redditMentions: candidate.redditMentions,
    redditUpvotes: candidate.redditUpvotes,
    redditComments: candidate.redditComments,
    redditSentiment: candidate.redditSentiment,
    relativeStrengthScore: candidate.relativeStrengthScore,
    unusualVolumeScore: candidate.unusualVolumeScore,
    socialScore: candidate.socialScore,
    technicalSetupScore: candidate.technicalSetupScore,
    volatilityScore: candidate.volatilityScore,
    realizedVolatility20: candidate.realizedVolatility20,
    extensionPenalty: candidate.extensionPenalty,
    catalystScore: candidate.catalystScore,
    optionsLiquidityScore: candidate.optionsLiquidityScore,
    riskFilterScore: candidate.riskFilterScore,
    discoveryScore: candidate.discoveryScore,
    bias: candidate.bias,
    directionConfidence: candidate.directionConfidence,
    dataCoverage: candidate.dataCoverage,
    hasHistoricalData: candidate.hasHistoricalData,
    optionsLikely: candidate.optionsLikely,
    reasons: candidate.reasons.join("\n"),
    warnings: candidate.warnings.join("\n")
  };

  return Object.entries(fields).map(([name, value]) => (
    <input key={name} type="hidden" name={name} value={value === null || value === undefined ? "" : String(value)} />
  ));
}

function dateTime(value: Date | null | undefined) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(value);
}

export default async function DiscoverPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const { selectedPortfolio } = await getSelectedPortfolio(params?.portfolio);
  const portfolioQuery = `portfolio=${encodeURIComponent(selectedPortfolio.id)}`;
  const includeReddit = params?.reddit !== "off";
  const profile = params?.profile === "movers" ? "movers" : "quality";
  const limit = numberParam(params?.limit, 35);
  const minScore = numberParam(params?.minScore, 50);
  const minVolume = numberParam(params?.minVolume, 0);
  const [watchlistItems, historyRows, result] = await Promise.all([
    prisma.watchlistItem.findMany({
      where: { portfolioId: selectedPortfolio.id },
      select: { symbol: true }
    }),
    prisma.discoverySymbolHistory.findMany({
      where: { portfolioId: selectedPortfolio.id },
      select: {
        symbol: true,
        firstQualifiedAt: true,
        lastQualifiedAt: true,
        lastSavedAt: true,
        timesSurfaced: true,
        lastOutcome: true
      }
    }),
    discoverStocks({
      includeReddit,
      limit,
      minScore,
      minVolume,
      profile
    })
  ]);
  const watched = new Set(watchlistItems.map((item) => item.symbol.toUpperCase()));
  const historyBySymbol = new Map(historyRows.map((row) => [row.symbol.toUpperCase(), row]));
  const averageScore = result.candidates.length
    ? result.candidates.reduce((sum, candidate) => sum + candidate.discoveryScore, 0) / result.candidates.length
    : 0;
  const redditCount = result.candidates.filter((candidate) => candidate.redditMentions > 0).length;
  const liquidCount = result.candidates.filter((candidate) => candidate.optionsLikely).length;
  const unseenCount = result.candidates.filter((candidate) => !historyBySymbol.get(candidate.symbol)?.lastSavedAt).length;
  const averageCoverage = result.candidates.length
    ? result.candidates.reduce((sum, candidate) => sum + candidate.dataCoverage, 0) / result.candidates.length
    : 0;
  const mediumVolCount = result.candidates.filter(
    (candidate) =>
      candidate.realizedVolatility20 !== null &&
      candidate.realizedVolatility20 >= 18 &&
      candidate.realizedVolatility20 <= 65
  ).length;

  return (
    <div className="grid gap-6">
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="field-label">Market-wide candidate search</p>
          <h1 className="mt-2 text-3xl font-bold text-ink">Discover</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-600">
            Viewing {selectedPortfolio.name}. This scans beyond your watchlist using a core liquid universe, live market movers, and optional social attention, then ranks candidates for further review. It does not approve trades.
          </p>
        </div>
        <Link className="btn-secondary" href={`/watchlist?${portfolioQuery}`}>
          Open watchlist
        </Link>
      </header>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <StatCard label="Candidates" value={result.candidates.length} detail={`Min score ${formatNumber(minScore, 0)}`} />
        <StatCard label="Average score" value={formatNumber(averageScore, 1)} detail="Discovery score, not trade score." />
        <StatCard label="New to portfolio" value={unseenCount} detail="No prior saved auto idea." />
        <StatCard label="Data coverage" value={`${formatNumber(averageCoverage, 0)}%`} detail={`${mediumVolCount} with medium 20D volatility.`} />
        <StatCard label="Liquidity pass" value={liquidCount} detail={`${redditCount} with Reddit signal.`} />
      </section>

      <section className="panel-pad">
        <div className="flex items-start gap-3">
          <Radar className="mt-1 h-5 w-5 text-moss" aria-hidden="true" />
          <div>
            <h2 className="text-lg font-bold text-ink">Discovery Score</h2>
            <p className="mt-1 text-sm leading-6 text-stone-600">
              Quality score starts with 25% technical setup, 20% medium realized volatility, 15% relative strength, 15% sentiment, 10% unusual-but-not-manic volume, 10% options liquidity, and 5% catalyst/source signal. Missing sources are removed and the available weights are renormalized; coverage remains visible. Large one-day moves still apply a direct extension penalty.
            </p>
          </div>
        </div>
      </section>

      <section className="panel-pad">
        <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="field-label">Discovery funnel</p>
            <h2 className="mt-1 text-lg font-bold text-ink">Where candidates were filtered</h2>
          </div>
          <p className="text-sm text-stone-600">Newness is portfolio-specific and does not refill a quota with repeat tickers.</p>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-7">
          {[
            ["Fetched rows", result.funnel.rawCandidates],
            ["Unique symbols", result.funnel.uniqueSymbols],
            ["History ready", result.funnel.historyReady],
            ["Liquidity pass", result.funnel.liquidityPassed],
            ["Score pass", result.funnel.scorePassed],
            ["Shown", result.funnel.returned],
            ["Unseen", unseenCount]
          ].map(([label, value]) => (
            <div className="rounded-lg border border-stone-200 bg-stone-50 px-3 py-3" key={label}>
              <p className="field-label">{label}</p>
              <p className="mt-1 text-xl font-bold text-ink">{value}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="panel-pad">
        <h2 className="text-lg font-bold text-ink">Scanner Controls</h2>
        <form className="mt-4 grid gap-4 md:grid-cols-7" action="/discover">
          <input type="hidden" name="portfolio" value={selectedPortfolio.id} />
          <label>
            <span className="field-label">Profile</span>
            <select className="field-input" name="profile" defaultValue={profile}>
              <option value="quality">Quality setup</option>
              <option value="movers">Mover scan</option>
            </select>
          </label>
          <label>
            <span className="field-label">Limit</span>
            <input className="field-input" name="limit" type="number" min="5" max="100" step="1" defaultValue={String(limit)} />
          </label>
          <label>
            <span className="field-label">Min score</span>
            <input className="field-input" name="minScore" type="number" min="0" max="100" step="1" defaultValue={String(minScore)} />
          </label>
          <label>
            <span className="field-label">Min volume</span>
            <input className="field-input" name="minVolume" type="number" min="0" step="100000" defaultValue={String(minVolume)} />
          </label>
          <label>
            <span className="field-label">Reddit</span>
            <select className="field-input" name="reddit" defaultValue={includeReddit ? "on" : "off"}>
              <option value="on">Include</option>
              <option value="off">Off</option>
            </select>
          </label>
          <div className="flex items-end">
            <button className="btn-primary w-full" type="submit">
              <Search className="h-4 w-4" aria-hidden="true" />
              Run scanner
            </button>
          </div>
        </form>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <div className={`rounded-lg border px-4 py-3 text-sm font-bold capitalize ${sourceTone(result.sourceStatus.yahoo)}`}>
          Yahoo: {result.sourceStatus.yahoo}
        </div>
        <div className={`rounded-lg border px-4 py-3 text-sm font-bold capitalize ${sourceTone(result.sourceStatus.reddit)}`}>
          Reddit: {result.sourceStatus.reddit}
        </div>
        <div className="rounded-lg border border-stone-200 bg-white px-4 py-3 text-sm font-bold text-stone-700">
          SPY day: {percent(result.spyDayChangePercent)}
        </div>
      </section>

      {result.sourceErrors.length ? (
        <section className="rounded-lg border border-amber-200 bg-amber-50 p-5 text-sm leading-6 text-amber-950">
          <p className="font-bold">Scanner notes</p>
          <ul className="mt-2 grid gap-1">
            {result.sourceErrors.map((error) => (
              <li key={error}>- {error}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="panel overflow-hidden">
        <div className="p-5">
          <h2 className="text-lg font-bold text-ink">Discovered Candidates</h2>
          <p className="mt-1 text-sm leading-6 text-stone-600">
            Use Create idea to save a risk-scored watchlist idea automatically, or Idea draft to review the prefilled form before saving.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1920px]">
            <thead className="table-head">
              <tr>
                <th className="px-4 py-3">Ticker</th>
                <th className="px-4 py-3">Novelty</th>
                <th className="px-4 py-3">Actions</th>
                <th className="px-4 py-3 text-right">Score</th>
                <th className="px-4 py-3 text-right">Coverage</th>
                <th className="px-4 py-3 text-right">Setup</th>
                <th className="px-4 py-3 text-right">20D vol</th>
                <th className="px-4 py-3">Bias</th>
                <th className="px-4 py-3 text-right">Direction confidence</th>
                <th className="px-4 py-3 text-right">Last</th>
                <th className="px-4 py-3 text-right">Day</th>
                <th className="px-4 py-3 text-right">Volume</th>
                <th className="px-4 py-3 text-right">Vol ratio</th>
                <th className="px-4 py-3 text-right">Mkt cap</th>
                <th className="px-4 py-3 text-right">Reddit</th>
                <th className="px-4 py-3 text-right">Social</th>
                <th className="px-4 py-3 text-right">Ext</th>
                <th className="px-4 py-3">Sources</th>
                <th className="px-4 py-3">Why surfaced</th>
              </tr>
            </thead>
            <tbody>
              {result.candidates.map((candidate) => {
                const alreadyWatched = watched.has(candidate.symbol);
                const history = historyBySymbol.get(candidate.symbol);
                const isUnseen = !history?.lastSavedAt;

                return (
                  <tr key={candidate.symbol} className="align-top">
                    <td className="table-cell">
                      <p className="font-bold text-ink">{candidate.symbol}</p>
                      <p className="max-w-52 truncate text-xs text-stone-500">{candidate.name ?? "-"}</p>
                      {candidate.optionsLikely ? (
                        <span className="mt-2 inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-bold text-emerald-800">
                          <ShieldCheck className="h-3 w-3" aria-hidden="true" />
                          Liquidity pass
                        </span>
                      ) : null}
                    </td>
                    <td className="table-cell">
                      <span className={isUnseen ? "rounded-full border border-sky-200 bg-sky-50 px-2 py-1 text-xs font-bold text-sky-800" : "rounded-full border border-stone-200 bg-stone-50 px-2 py-1 text-xs font-bold text-stone-700"}>
                        {isUnseen ? "New" : "Seen before"}
                      </span>
                      <p className="mt-2 text-xs leading-5 text-stone-500">
                        {history ? `${history.timesSurfaced} qualification${history.timesSurfaced === 1 ? "" : "s"}; last saved ${dateTime(history.lastSavedAt)}` : "No saved auto-idea history."}
                      </p>
                    </td>
                    <td className="table-cell">
                      <div className="flex flex-col gap-2">
                        <form action={createTradeIdeaFromDiscovery}>
                          <input type="hidden" name="portfolioId" value={selectedPortfolio.id} />
                          {hiddenDiscoveryFields(candidate)}
                          <button className="btn-primary w-full disabled:cursor-not-allowed disabled:opacity-50" type="submit" disabled={candidate.bias === "mixed"}>
                            <FilePlus2 className="h-4 w-4" aria-hidden="true" />
                            {candidate.bias === "mixed" ? "Mixed — wait" : "Create idea"}
                          </button>
                        </form>
                        <form action={createWatchlistItem}>
                          <input type="hidden" name="portfolioId" value={selectedPortfolio.id} />
                          <input type="hidden" name="symbol" value={candidate.symbol} />
                          <input type="hidden" name="name" value={candidate.name ?? ""} />
                          <input type="hidden" name="market" value={candidate.market} />
                          <input type="hidden" name="currency" value={candidate.currency} />
                          <input type="hidden" name="dataSource" value="yahoo" />
                          <input
                            type="hidden"
                            name="notes"
                            value={`Discovered by RiskGate. Score ${candidate.discoveryScore.toFixed(1)}. Sources: ${candidate.sources.join(", ")}.`}
                          />
                          <button className={alreadyWatched ? "btn-secondary w-full" : "btn-primary w-full"} type="submit">
                            <Plus className="h-4 w-4" aria-hidden="true" />
                            {alreadyWatched ? "Update watchlist" : "Add watchlist"}
                          </button>
                        </form>
                        <Link className="btn-secondary" href={`/options-chain?${portfolioQuery}&symbol=${candidate.symbol}&type=${candidate.bias === "bearish" ? "put" : "call"}&minDte=21`}>
                          Chain
                        </Link>
                        <Link className="btn-secondary" href={candidateIdeaHref(candidate, selectedPortfolio.id)}>
                          Idea draft
                        </Link>
                      </div>
                    </td>
                    <td className={`table-cell text-right text-lg font-bold ${scoreTone(candidate.discoveryScore)}`}>
                      {formatNumber(candidate.discoveryScore, 1)}
                    </td>
                    <td className="table-cell text-right">{formatNumber(candidate.dataCoverage, 0)}%</td>
                    <td className="table-cell text-right">{formatNumber(candidate.technicalSetupScore, 0)}</td>
                    <td className="table-cell text-right">
                      {candidate.realizedVolatility20 === null ? "-" : `${formatNumber(candidate.realizedVolatility20, 1)}%`}
                    </td>
                    <td className="table-cell capitalize">{candidate.bias}</td>
                    <td className="table-cell text-right">{formatNumber(candidate.directionConfidence, 0)}%</td>
                    <td className="table-cell text-right">{candidate.price === null ? "-" : formatCurrency(candidate.price, candidate.currency)}</td>
                    <td className={(candidate.dayChangePercent ?? 0) >= 0 ? "table-cell text-right text-emerald-700" : "table-cell text-right text-red-700"}>
                      {percent(candidate.dayChangePercent)}
                    </td>
                    <td className="table-cell text-right">{compact(candidate.volume)}</td>
                    <td className="table-cell text-right">{candidate.volumeRatio === null ? "-" : `${formatNumber(candidate.volumeRatio, 2)}x`}</td>
                    <td className="table-cell text-right">{compact(candidate.marketCap)}</td>
                    <td className="table-cell text-right">{candidate.redditMentions}</td>
                    <td className="table-cell text-right">{formatNumber(candidate.socialScore, 1)}</td>
                    <td className="table-cell text-right">{formatNumber(candidate.extensionPenalty, 2)}</td>
                    <td className="table-cell max-w-52 text-stone-600">{candidate.sources.join(", ")}</td>
                    <td className="table-cell">
                      <ul className="grid max-w-xl gap-1 text-stone-600">
                        {candidate.reasons.slice(0, 3).map((reason) => (
                          <li key={reason}>- {reason}</li>
                        ))}
                        {candidate.warnings.slice(0, 2).map((warning) => (
                          <li className="text-amber-800" key={warning}>- {warning}</li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                );
              })}
              {!result.candidates.length ? (
                <tr>
                  <td className="table-cell text-stone-500" colSpan={19}>
                    No candidates passed the current filters. Lower Min score, turn Reddit on, or remove Min volume.
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
