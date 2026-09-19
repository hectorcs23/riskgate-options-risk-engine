import Link from "next/link";
import { RefreshCw, Trash2 } from "lucide-react";
import { deleteTradeIdea, generateDailyIdeas, refreshDailyModel, refreshYahooFinanceSentimentForIdea } from "@/app/actions";
import { MonteCarloHistogram, PayoffChart } from "@/components/charts";
import { DecisionBadge } from "@/components/decision-badge";
import { TradeIdeaForm } from "@/components/trade-idea-form";
import { prisma } from "@/lib/db";
import { getRiskSettings, getSelectedPortfolio } from "@/lib/data";
import { formatCurrency, formatMXN, formatNumber } from "@/lib/format";
import { technicalSnapshotFromBars } from "@/lib/indicators";
import {
  buildContractUpdateGroups,
  buildIdeaDisplayGroups,
  buildNewUnderlyingIdeas,
  contractQualityRank,
  contractVariantLabel,
  isEligibleContractVariant
} from "@/lib/idea-variants";
import { analyzeOptionTrade } from "@/lib/options-math";
import { simulateMonteCarlo } from "@/lib/options/monteCarlo";
import { calculateMultiLegMetrics, virtualLegsFromLegacyTrade } from "@/lib/options/multileg";
import { evaluateTradeIdea, getOptionsQualityBreakdown } from "@/lib/risk";
import { classifyYahooSentiment } from "@/lib/sentiment/yahoo";
import { tradeIdeaToInput } from "@/lib/trade-input";
import { autoIdeaMarker, isAutoIdea } from "@/lib/auto-ideas";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<Record<string, string | undefined>>;
};

function lines(value?: string | null) {
  return value?.split("\n").filter(Boolean) ?? [];
}

function numberParam(value?: string) {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function dateParam(value?: string) {
  if (!value) return undefined;
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function dateTime(value: Date | null | undefined) {
  if (!value) return "Not evaluated";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(value);
}

function freshness(value: Date | null | undefined, now = new Date()) {
  if (!value) return { label: "Never evaluated", tone: "text-red-700" };
  const ageHours = Math.max((now.getTime() - value.getTime()) / 3_600_000, 0);
  if (ageHours <= 36) return { label: "Fresh", tone: "text-emerald-700" };
  if (ageHours <= 96) return { label: "Aging", tone: "text-amber-700" };
  return { label: "Stale", tone: "text-red-700" };
}

export default async function TradeIdeasPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const { selectedPortfolio } = await getSelectedPortfolio(params?.portfolio);
  const settings = await getRiskSettings(selectedPortfolio.id);
  const showAllIdeas = params?.limit === "all";
  const tickerLimit = Math.max(1, Math.min(numberParam(params?.limit) ?? 5, 100));
  const prefillContract = params?.contract;
  const prefillSymbol = params?.symbol?.toUpperCase();
  const prefillDayChange = numberParam(params?.dayChange) ?? 0;
  const prefillIsExtended = Math.abs(prefillDayChange) >= 7;
  const defaults = prefillContract
    ? {
        symbol: params?.symbol ?? "",
        direction: params?.type === "put" ? "bearish" : "bullish",
        strategy: params?.type === "put" ? "long_put" : "long_call",
        thesis: `Alpaca contract selected: ${prefillContract}.`,
        optionContractSymbol: prefillContract,
        optionType: params?.type ?? null,
        strikePrice: numberParam(params?.strike) ?? null,
        expirationDate: dateParam(params?.expiration) ?? null,
        premiumCost: numberParam(params?.mid) ?? null,
        maxLoss: numberParam(params?.mid) ? Number((numberParam(params?.mid)! * 100).toFixed(0)) : 0,
        expectedReward: numberParam(params?.mid) ? Number((numberParam(params?.mid)! * 200).toFixed(0)) : null,
        bidAskSpreadPercent: numberParam(params?.spread) ?? 8,
        optionVolume: numberParam(params?.volume) ?? 100,
        openInterest: numberParam(params?.openInterest) ?? 500,
        daysToExpiration: numberParam(params?.dte) ?? 30,
        contractBid: numberParam(params?.bid) ?? null,
        contractAsk: numberParam(params?.ask) ?? null,
        contractMid: numberParam(params?.mid) ?? null,
        contractDelta: numberParam(params?.delta) ?? null,
        contractGamma: numberParam(params?.gamma) ?? null,
        contractTheta: numberParam(params?.theta) ?? null,
        contractVega: numberParam(params?.vega) ?? null,
        contractRho: numberParam(params?.rho) ?? null,
        contractImpliedVolatility: numberParam(params?.iv) ?? null,
        contractUnderlyingPrice: numberParam(params?.underlyingPrice) ?? null,
        contractBreakEvenPrice: numberParam(params?.breakEven) ?? null,
        impliedVolatilityRank: numberParam(params?.iv) ? Math.min(Number((numberParam(params?.iv)! * 100).toFixed(0)), 100) : null,
        premiumAsPercentOfPortfolio: 0.5,
        exitPlan: ""
      }
    : prefillSymbol
      ? {
          symbol: prefillSymbol,
          direction: params?.direction ?? "bullish",
          strategy: params?.strategy ?? "long_call",
          thesis: params?.thesis ?? `Discovery candidate: ${prefillSymbol}.`,
          catalyst: params?.catalyst ?? "RiskGate Discover",
          status: "watchlist",
          trend: prefillDayChange >= 0 ? "uptrend" : "downtrend",
          volumeCondition: (numberParam(params?.volumeRatio) ?? 1) >= 1.25 ? "strong" : "normal",
          bidAskSpreadPercent: 8,
          optionVolume: 100,
          openInterest: 500,
          daysToExpiration: 30,
          premiumAsPercentOfPortfolio: 0.5,
          isChasing: prefillIsExtended,
          maxLoss: 0,
          exitPlan: ""
        }
    : undefined;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [totalIdeas, autoIdeasToday, ideaRows, latestScan] = await Promise.all([
    prisma.tradeIdea.count({
      where: { portfolioId: selectedPortfolio.id }
    }),
    prisma.tradeIdea.count({
      where: {
        portfolioId: selectedPortfolio.id,
        createdAt: {
          gte: today
        },
        thesis: {
          contains: autoIdeaMarker
        }
      }
    }),
    prisma.tradeIdea.findMany({
      where: { portfolioId: selectedPortfolio.id },
      orderBy: [{ totalScore: "desc" }, { createdAt: "desc" }],
      include: {
        optionLegs: true,
        journalEntries: true,
        scoreSnapshots: {
          orderBy: { snapshotDate: "desc" },
          take: 5
        }
      }
    }),
    prisma.strategyScanRun.findFirst({
      where: { portfolioId: selectedPortfolio.id },
      orderBy: { createdAt: "desc" }
    })
  ]);
  const autoIdeaHistory = ideaRows.filter((idea) => isAutoIdea(idea.thesis));
  const allIdeaGroups = buildIdeaDisplayGroups(ideaRows);
  const displayedIdeaGroups = showAllIdeas ? allIdeaGroups : allIdeaGroups.slice(0, tickerLimit);
  const ideas = displayedIdeaGroups.map((group) => group.representative);
  const newUnderlyingIdeas = buildNewUnderlyingIdeas(autoIdeaHistory, today, 5);
  const contractUpdates = buildContractUpdateGroups(autoIdeaHistory, 3);
  const latestScanAt = latestScan?.completedAt ?? latestScan?.createdAt;
  const latestScanFreshness = freshness(latestScanAt);
  const symbols = Array.from(new Set(ideas.map((idea) => idea.symbol.toUpperCase())));
  const portfolioQuery = `portfolio=${encodeURIComponent(selectedPortfolio.id)}`;
  const defaultTradeIdeasHref = `/trade-ideas?${portfolioQuery}`;
  const showAllTradeIdeasHref = `/trade-ideas?${portfolioQuery}&limit=all`;
  const [priceBars, yahooDocuments] = await Promise.all([
    symbols.length
      ? prisma.priceBar.findMany({
          where: {
            portfolioId: selectedPortfolio.id,
            symbol: { in: symbols },
            timeframe: "1d"
          },
          orderBy: { timestamp: "asc" }
        })
      : [],
    symbols.length
      ? prisma.yahooFinanceDocument.findMany({
          where: {
            ticker: { in: symbols }
          },
          orderBy: [{ publishedAt: "desc" }, { collectedAt: "desc" }],
          take: 200
        })
      : []
  ]);
  const barsBySymbol = new Map<string, typeof priceBars>();
  for (const bar of priceBars) {
    const key = bar.symbol.toUpperCase();
    barsBySymbol.set(key, [...(barsBySymbol.get(key) ?? []), bar]);
  }
  const yahooBySymbol = new Map<string, typeof yahooDocuments>();
  for (const document of yahooDocuments) {
    const key = document.ticker.toUpperCase();
    yahooBySymbol.set(key, [...(yahooBySymbol.get(key) ?? []), document]);
  }

  return (
    <div className="grid gap-6">
      <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="field-label">Pre-trade approval gate</p>
          <h1 className="mt-2 text-3xl font-bold text-ink">Trade Ideas</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-600">
            Viewing {selectedPortfolio.name}. Build the trade plan before the order; use the refresh buttons when you want latest Yahoo/Alpaca context applied.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <form action={generateDailyIdeas}>
            <input type="hidden" name="portfolioId" value={selectedPortfolio.id} />
            <button className="btn-secondary" type="submit">
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Generate daily ideas
            </button>
          </form>
          <form action={refreshDailyModel}>
            <input type="hidden" name="portfolioId" value={selectedPortfolio.id} />
            <button className="btn-primary" type="submit">
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              Refresh scores now
            </button>
          </form>
        </div>
      </header>

      <section className="rounded-lg border border-sky-200 bg-sky-50 p-5 text-sm leading-6 text-sky-950">
        <p className="font-bold">Daily auto-discovery</p>
        <div className="mt-1 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <p>
            This page loads from local saved ideas first. You have {autoIdeasToday} auto-generated research idea{autoIdeasToday === 1 ? "" : "s"} saved today; Generate daily ideas runs and records a fresh discovery scan on demand.
          </p>
          <div className="shrink-0 text-sm font-semibold">
            Showing {ideas.length} of {allIdeaGroups.length} ticker{allIdeaGroups.length === 1 ? "" : "s"} ({totalIdeas} saved contract variant{totalIdeas === 1 ? "" : "s"}).
            {allIdeaGroups.length > ideas.length ? (
              <Link className="ml-2 text-sky-800 underline" href={showAllTradeIdeasHref}>
                Show all
              </Link>
            ) : showAllIdeas && allIdeaGroups.length > 5 ? (
              <Link className="ml-2 text-sky-800 underline" href={defaultTradeIdeasHref}>
                Show top 5
              </Link>
            ) : null}
          </div>
        </div>
        {latestScanFreshness.label !== "Fresh" ? (
          <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">
            {latestScan ? `Scan history is ${latestScanFreshness.label.toLowerCase()}.` : "No discovery scan has been recorded yet."} Generate daily ideas to run a new scan and refresh this metadata.
          </p>
        ) : null}
        <div className="mt-4 grid gap-3 rounded-lg border border-sky-200 bg-white/70 p-4 text-xs text-stone-600 sm:grid-cols-2 lg:grid-cols-6">
          <div>
            <p className="field-label">Last scan</p>
            <p className="mt-1 font-semibold text-ink">{latestScan ? dateTime(latestScan.completedAt ?? latestScan.createdAt) : "No recorded scan"}</p>
            <p className={`mt-1 font-bold ${latestScanFreshness.tone}`}>{latestScanFreshness.label}</p>
          </div>
          <div>
            <p className="field-label">Status</p>
            <p className="mt-1 font-semibold capitalize text-ink">{latestScan?.status ?? "unavailable"}</p>
          </div>
          <div>
            <p className="field-label">Symbols scanned</p>
            <p className="mt-1 font-semibold text-ink">{latestScan?.symbolsScanned ?? "-"}</p>
          </div>
          <div>
            <p className="field-label">Qualified</p>
            <p className="mt-1 font-semibold text-ink">{latestScan?.candidatesFound ?? "-"}</p>
          </div>
          <div>
            <p className="field-label">Inserted</p>
            <p className="mt-1 font-semibold text-ink">{latestScan?.ideasInserted ?? "-"}</p>
          </div>
          <div>
            <p className="field-label">Updated</p>
            <p className="mt-1 font-semibold text-ink">{latestScan?.ideasUpdated ?? "-"}</p>
          </div>
        </div>
      </section>

      <section className="panel-pad">
        <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="field-label">Strict symbol history</p>
            <h2 className="mt-1 text-lg font-bold text-ink">New Underlying Ideas</h2>
            <p className="mt-1 text-sm leading-6 text-stone-600">
              A ticker appears here only on its first saved day. A different option on an old ticker belongs in Contract Updates.
            </p>
          </div>
          <p className="text-sm font-semibold text-stone-600">{newUnderlyingIdeas.length}/5 today</p>
        </div>
        {newUnderlyingIdeas.length ? (
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            {newUnderlyingIdeas.map((idea) => (
              <article className="rounded-lg border border-stone-200 bg-stone-50 p-4" key={idea.id}>
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-bold text-ink">{idea.symbol}</h3>
                  <span className="rounded-full border border-stone-200 bg-white px-2 py-0.5 text-xs font-semibold capitalize text-stone-700">
                    {idea.direction}
                  </span>
                </div>
                <p className="mt-2 text-xs leading-5 text-stone-600">{contractVariantLabel(idea)}</p>
                <p className="mt-2 text-sm font-bold text-ink">{formatNumber(idea.totalScore, 1)}/100</p>
                <p className={idea.decision === "reject" ? "mt-1 text-xs font-bold text-red-700" : "mt-1 text-xs font-bold text-emerald-700"}>
                  Gate: {idea.decision ?? idea.status}
                </p>
                <div className="mt-3 border-t border-stone-200 pt-3 text-xs leading-5 text-stone-500">
                  <p>Created: {dateTime(idea.createdAt)}</p>
                  <p>Evaluated: {dateTime(idea.lastEvaluatedAt)}</p>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="mt-4 rounded-lg border border-stone-200 bg-stone-50 p-4 text-sm text-stone-600">
            No first-time ticker was saved today. The strict no-repeat rule allows a zero-result day.
          </p>
        )}
      </section>

      <section className="panel-pad" id="contract-updates">
        <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="field-label">Preserved option history</p>
            <h2 className="mt-1 text-lg font-bold text-ink">Contract Updates</h2>
            <p className="mt-1 max-w-4xl text-sm leading-6 text-stone-600">
              One ticker per group. Trend and market evidence choose the direction; option quality ranks the contract within that direction. Prior contracts remain saved.
            </p>
          </div>
          <p className="text-sm font-semibold text-stone-600">{contractUpdates.length}/3 latest tickers</p>
        </div>

        {contractUpdates.length ? (
          <div className="mt-4 grid gap-4">
            {contractUpdates.map((group) => {
              const evidence = group.directionEvidence;
              const directionArguments =
                evidence.preferredDirection === "bullish"
                  ? evidence.bullishArguments
                  : evidence.preferredDirection === "bearish"
                    ? evidence.bearishArguments
                    : [...evidence.bullishArguments.slice(0, 2), ...evidence.bearishArguments.slice(0, 2)];

              return (
                <article className="rounded-lg border border-stone-200 bg-stone-50 p-4" key={group.symbol}>
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-lg font-bold text-ink">{group.symbol}</h3>
                        <span
                          className={
                            evidence.preferredDirection === "bullish"
                              ? "rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold capitalize text-emerald-800"
                              : evidence.preferredDirection === "bearish"
                                ? "rounded-full border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-semibold capitalize text-red-800"
                                : "rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-semibold capitalize text-amber-900"
                          }
                        >
                          {evidence.preferredDirection === "mixed"
                            ? "Mixed — skip"
                            : `${evidence.preferredDirection} preferred`}
                        </span>
                      </div>
                      <p className="mt-2 text-sm font-semibold text-stone-700">
                        Bullish evidence {formatNumber(evidence.bullishPoints, 1)} vs bearish evidence {formatNumber(evidence.bearishPoints, 1)}
                      </p>
                      <p className="mt-1 max-w-4xl text-sm leading-6 text-stone-600">
                        {directionArguments.length ? directionArguments.slice(0, 4).join("; ") : "Directional evidence is not strong enough yet."}
                      </p>
                    </div>
                    <div className="rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm">
                      <p className="field-label">Selected direction</p>
                      <p className="mt-1 font-bold capitalize text-ink">
                        {group.preferredVariant
                          ? `${group.preferredVariant.direction} · ${group.preferredVariant.strategy.replaceAll("_", " ")}`
                          : "No contract selected"}
                      </p>
                    </div>
                  </div>

                  <div className="mt-4 overflow-x-auto">
                    <table className="data-table min-w-[920px]">
                      <thead>
                        <tr>
                          <th className="table-head">Contract variant</th>
                          <th className="table-head">Direction</th>
                          <th className="table-head">Strategy</th>
                          <th className="table-head text-right">Idea score</th>
                          <th className="table-head text-right">Option quality</th>
                          <th className="table-head text-right">Vehicle rank</th>
                          <th className="table-head">Risk gate</th>
                          <th className="table-head">Saved</th>
                          <th className="table-head">Last evaluated</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.variants.slice(0, 6).map((variant) => (
                          <tr className={variant.id === group.preferredVariant?.id ? "bg-emerald-50" : ""} key={variant.id}>
                            <td className="table-cell font-semibold text-ink">
                              {contractVariantLabel(variant)}
                              {variant.id === group.preferredVariant?.id ? (
                                <span className="ml-2 rounded-full border border-emerald-200 bg-white px-2 py-0.5 text-[11px] font-bold text-emerald-800">
                                  Preferred
                                </span>
                              ) : null}
                            </td>
                            <td className="table-cell capitalize">{variant.direction}</td>
                            <td className="table-cell">{variant.strategy.replaceAll("_", " ")}</td>
                            <td className="table-cell text-right">{formatNumber(variant.totalScore, 1)}</td>
                            <td className="table-cell text-right">{formatNumber(variant.optionsQualityScore, 1)}</td>
                            <td className="table-cell text-right">{formatNumber(contractQualityRank(variant), 1)}</td>
                            <td className={isEligibleContractVariant(variant) ? "table-cell font-semibold text-emerald-700" : "table-cell font-semibold text-red-700"}>
                              {isEligibleContractVariant(variant) ? variant.decision ?? variant.status : `${variant.decision ?? variant.status} · skip`}
                            </td>
                            <td className="table-cell">{variant.createdAt.toLocaleDateString("es-MX")}</td>
                            <td className="table-cell">{dateTime(variant.lastEvaluatedAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {group.variants.length > 6 ? (
                      <p className="mt-2 text-xs text-stone-500">Plus {group.variants.length - 6} older preserved contract variants.</p>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <p className="mt-4 rounded-lg border border-stone-200 bg-stone-50 p-4 text-sm text-stone-600">
            No ticker has a materially different saved contract variant yet.
          </p>
        )}
      </section>

      <section className="panel-pad">
        <h2 className="text-lg font-bold text-ink">New Option Trade Idea</h2>
        {prefillContract ? (
          <div className="mt-3 rounded-lg border border-sky-200 bg-sky-50 p-4 text-sm leading-6 text-sky-950">
            Prefilled from Alpaca contract {prefillContract}. Add thesis, invalidation, max loss, and exit plan before approval.
          </div>
        ) : null}
        {!prefillContract && prefillSymbol ? (
          <div className="mt-3 rounded-lg border border-sky-200 bg-sky-50 p-4 text-sm leading-6 text-sky-950">
            Prefilled from Discover for {prefillSymbol}. Treat this as a research lead; add invalidation, max loss, expiration, and an exit plan before approval.
            {prefillIsExtended ? " This candidate had a large one-day move, so it is pre-marked as chasing and capped at watchlist until the setup cools down." : ""}
          </div>
        ) : null}
        <div className="mt-4">
          <TradeIdeaForm portfolioId={selectedPortfolio.id} defaults={defaults} />
        </div>
      </section>

      <section className="grid gap-4">
        {displayedIdeaGroups.map((ideaGroup) => {
          const idea = ideaGroup.representative;
          const groupedVariants = ideaGroup.variants;
          const groupedEvidence = ideaGroup.directionEvidence;
          const [latestSnapshot, previousSnapshot] = idea.scoreSnapshots;
          const ideaFreshness = freshness(idea.lastEvaluatedAt);
          const scoreChange =
            latestSnapshot && previousSnapshot
              ? latestSnapshot.totalScore - previousSnapshot.totalScore
              : null;
          const technicalSnapshot = technicalSnapshotFromBars(barsBySymbol.get(idea.symbol.toUpperCase()) ?? []);
          const yahooSentiment = classifyYahooSentiment({
            ticker: idea.symbol,
            tradeDirection: idea.direction,
            catalyst: idea.catalyst,
            documents: (yahooBySymbol.get(idea.symbol.toUpperCase()) ?? []).map((document) => ({
              id: document.id,
              ticker: document.ticker,
              title: document.title,
              publisher: document.publisher,
              summary: document.summary,
              url: document.url,
              publishedAt: document.publishedAt,
              collectedAt: document.collectedAt
            }))
          });
          const input = {
            ...tradeIdeaToInput(idea),
            technicalSnapshot: technicalSnapshot.lastClose === null ? null : technicalSnapshot,
            yahooSentiment
          };
          const evaluation = evaluateTradeIdea(input, settings, {
            optionsRiskUsed: 0,
            monthlyLossUsed: 0,
            openOptionsRiskUsed: 0,
            concentrationMultiplier: 1
          });
          const analytics = analyzeOptionTrade(input, settings);
          const optionLegs = input.optionLegs?.length ? input.optionLegs : virtualLegsFromLegacyTrade(input);
          const multiLegMetrics = optionLegs.length
            ? calculateMultiLegMetrics({ legs: optionLegs, underlyingPrice: idea.contractUnderlyingPrice })
            : null;
          const optionsQualityBreakdown = getOptionsQualityBreakdown(input, settings);
          const monteCarlo =
            optionLegs.length && idea.contractUnderlyingPrice && idea.contractImpliedVolatility && idea.daysToExpiration
              ? simulateMonteCarlo({
                  underlyingPrice: idea.contractUnderlyingPrice,
                  legs: optionLegs,
                  impliedVolatility: idea.contractImpliedVolatility,
                  dte: idea.daysToExpiration,
                  simulations: 500,
                  seed: idea.symbol.charCodeAt(0) + Math.round((idea.totalScore ?? 0) * 100)
                })
              : null;

          return (
          <article className="panel-pad" key={idea.id}>
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="text-xl font-bold text-ink">{idea.symbol}</h2>
                  <DecisionBadge decision={idea.decision} />
                  {isAutoIdea(idea.thesis) ? (
                    <span className="rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 text-xs font-semibold text-sky-800">
                      Auto discovery
                    </span>
                  ) : null}
                  <span className="rounded-full border border-stone-200 bg-stone-50 px-2.5 py-1 text-xs font-semibold capitalize text-stone-700">
                    {idea.direction}
                  </span>
                  <span className="rounded-full border border-stone-200 bg-stone-50 px-2.5 py-1 text-xs font-semibold text-stone-700">
                    {idea.strategy.replaceAll("_", " ")}
                  </span>
                </div>
                <p className="mt-3 max-w-4xl text-sm leading-6 text-stone-600">{idea.thesis || "No thesis written yet."}</p>
              </div>
              <div className="grid min-w-56 grid-cols-2 gap-3 rounded-lg border border-stone-200 bg-stone-50 p-3 text-sm">
                <div>
                  <p className="field-label">Score</p>
                  <p className="mt-1 text-lg font-bold text-ink">{formatNumber(idea.totalScore, 1)}/100</p>
                </div>
                <div>
                  <p className="field-label">Risk</p>
                  <p className="mt-1 text-lg font-bold text-ink">{formatMXN(idea.suggestedRiskMXN)}</p>
                </div>
                <div>
                  <p className="field-label">Previous</p>
                  <p className="mt-1 text-sm font-bold text-ink">
                    {previousSnapshot ? `${formatNumber(previousSnapshot.totalScore, 1)}/100` : "No prior day"}
                  </p>
                </div>
                <div>
                  <p className="field-label">Daily move</p>
                  <p
                    className={
                      scoreChange === null || scoreChange >= 0
                        ? "mt-1 text-sm font-bold text-emerald-700"
                        : "mt-1 text-sm font-bold text-red-700"
                    }
                  >
                    {scoreChange === null ? "-" : `${scoreChange >= 0 ? "+" : ""}${formatNumber(scoreChange, 1)}`}
                  </p>
                </div>
              </div>
            </div>

            <div className="mt-4 grid gap-3 rounded-lg border border-stone-200 bg-white px-4 py-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
              <div>
                <p className="field-label">Created</p>
                <p className="mt-1 font-semibold text-ink">{dateTime(idea.createdAt)}</p>
              </div>
              <div>
                <p className="field-label">Last evaluated</p>
                <p className="mt-1 font-semibold text-ink">{dateTime(idea.lastEvaluatedAt)}</p>
              </div>
              <div>
                <p className="field-label">Evaluation freshness</p>
                <p className={`mt-1 font-bold ${ideaFreshness.tone}`}>{ideaFreshness.label}</p>
              </div>
              <div>
                <p className="field-label">Contract data as of</p>
                <p className="mt-1 font-semibold text-ink">{idea.contractSnapshotAt ? dateTime(idea.contractSnapshotAt) : "No verified snapshot"}</p>
              </div>
            </div>

            {groupedVariants.length > 1 ? (
              <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <p className="field-label">Grouped ticker — no duplicate cards</p>
                    <p className="mt-1 font-bold text-ink">
                      {groupedVariants.length} distinct {idea.symbol} contract variants
                    </p>
                    <p className="mt-1 text-sm leading-6 text-amber-950">
                      Bullish evidence {formatNumber(groupedEvidence.bullishPoints, 1)} vs bearish evidence {formatNumber(groupedEvidence.bearishPoints, 1)}.{" "}
                      {groupedEvidence.preferredDirection === "mixed"
                        ? "Evidence is close, so the direction is Mixed / Skip."
                        : `${groupedEvidence.preferredDirection[0].toUpperCase()}${groupedEvidence.preferredDirection.slice(1)} has more trend/regime support.`}
                      {!isEligibleContractVariant(idea)
                        ? " No saved variant passed RiskGate; the selected row below is only the direction-matched representative for comparison."
                        : " The selected row below is the best eligible vehicle inside that direction."}
                    </p>
                  </div>
                  <span
                    className={
                      groupedEvidence.preferredDirection === "bullish"
                        ? "rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-800"
                        : groupedEvidence.preferredDirection === "bearish"
                          ? "rounded-full border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-800"
                          : "rounded-full border border-amber-300 bg-white px-2.5 py-1 text-xs font-semibold text-amber-900"
                    }
                  >
                    {groupedEvidence.preferredDirection === "mixed"
                      ? "Mixed · Skip"
                      : `${groupedEvidence.preferredDirection} direction`}
                  </span>
                </div>

                <div className="mt-4 overflow-x-auto">
                  <table className="data-table min-w-[720px]">
                    <thead>
                      <tr>
                        <th className="table-head">Contract variant</th>
                        <th className="table-head">Direction</th>
                        <th className="table-head">Strategy</th>
                        <th className="table-head text-right">Score</th>
                        <th className="table-head">Risk gate</th>
                        <th className="table-head">Detail shown</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groupedVariants.slice(0, 8).map((variant) => (
                        <tr className={variant.id === idea.id ? "bg-white" : ""} key={variant.id}>
                          <td className="table-cell font-semibold text-ink">{contractVariantLabel(variant)}</td>
                          <td className="table-cell capitalize">{variant.direction}</td>
                          <td className="table-cell">{variant.strategy.replaceAll("_", " ")}</td>
                          <td className="table-cell text-right">{formatNumber(variant.totalScore, 1)}</td>
                          <td className={isEligibleContractVariant(variant) ? "table-cell font-semibold text-emerald-700" : "table-cell font-semibold text-red-700"}>
                            {isEligibleContractVariant(variant) ? variant.decision ?? variant.status : `${variant.decision ?? variant.status} · skip`}
                          </td>
                          <td className="table-cell font-semibold">
                            {variant.id === idea.id ? "Yes — representative" : "Alternative"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {groupedVariants.length > 8 ? (
                    <p className="mt-2 text-xs text-amber-900">Plus {groupedVariants.length - 8} older preserved variants.</p>
                  ) : null}
                </div>
              </div>
            ) : null}

            {idea.optionContractSymbol ? (
              <div className="mt-5 rounded-lg border border-sky-200 bg-sky-50 p-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <p className="field-label">Attached option structure</p>
                    <p className="mt-1 font-bold text-ink">{idea.optionContractSymbol}</p>
                    <p className="mt-1 text-sm text-sky-950">
                      {idea.optionType ?? "option"} {idea.strikePrice ? `strike ${formatNumber(idea.strikePrice, 2)}` : ""}
                      {idea.shortStrikePrice ? ` / short ${formatNumber(idea.shortStrikePrice, 2)}` : ""}
                      {idea.expirationDate ? `, expires ${idea.expirationDate.toLocaleDateString("es-MX")}` : ""}
                    </p>
                  </div>
                  <Link className="btn-secondary" href={`/options-chain?portfolio=${encodeURIComponent(selectedPortfolio.id)}&symbol=${idea.symbol}&type=${idea.optionType ?? "call"}&minDte=21`}>
                    Review chain
                  </Link>
                </div>
                <div className="mt-4 grid gap-3 md:grid-cols-4 lg:grid-cols-8">
                  <div>
                    <p className="field-label">Mid</p>
                    <p className="mt-1 font-bold text-ink">{idea.contractMid === null ? "-" : formatCurrency(idea.contractMid, "USD")}</p>
                  </div>
                  <div>
                    <p className="field-label">Spread</p>
                    <p className="mt-1 font-bold text-ink">{formatNumber(idea.bidAskSpreadPercent, 2)}%</p>
                  </div>
                  <div>
                    <p className="field-label">DTE</p>
                    <p className="mt-1 font-bold text-ink">{formatNumber(idea.daysToExpiration, 0)}</p>
                  </div>
                  <div>
                    <p className="field-label">IV</p>
                    <p className="mt-1 font-bold text-ink">{idea.contractImpliedVolatility === null ? "-" : `${formatNumber(idea.contractImpliedVolatility * 100, 1)}%`}</p>
                  </div>
                  <div>
                    <p className="field-label">Delta</p>
                    <p className="mt-1 font-bold text-ink">{idea.contractDelta === null ? "-" : formatNumber(idea.contractDelta, 3)}</p>
                  </div>
                  <div>
                    <p className="field-label">Gamma</p>
                    <p className="mt-1 font-bold text-ink">{idea.contractGamma === null ? "-" : formatNumber(idea.contractGamma, 3)}</p>
                  </div>
                  <div>
                    <p className="field-label">Theta</p>
                    <p className="mt-1 font-bold text-ink">{idea.contractTheta === null ? "-" : formatNumber(idea.contractTheta, 3)}</p>
                  </div>
                  <div>
                    <p className="field-label">Vega</p>
                    <p className="mt-1 font-bold text-ink">{idea.contractVega === null ? "-" : formatNumber(idea.contractVega, 3)}</p>
                  </div>
                </div>
              </div>
            ) : null}

            {multiLegMetrics ? (
              <div className="mt-5 grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
                <div className="rounded-lg border border-stone-200 bg-white p-4">
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div>
                      <p className="field-label">Strategy-level option legs</p>
                      <p className="mt-1 text-sm text-stone-600">
                        {optionLegs.length} leg(s), evaluated as one payoff structure.
                      </p>
                    </div>
                    <Link className="btn-secondary" href={`/options-chain?portfolio=${encodeURIComponent(selectedPortfolio.id)}&symbol=${idea.symbol}&minDte=21`}>
                      Add from chain
                    </Link>
                  </div>
                  <div className="mt-4 overflow-x-auto">
                    <table className="w-full min-w-[780px]">
                      <thead className="table-head">
                        <tr>
                          <th className="px-3 py-2">Side</th>
                          <th className="px-3 py-2">Type</th>
                          <th className="px-3 py-2 text-right">Qty</th>
                          <th className="px-3 py-2 text-right">Strike</th>
                          <th className="px-3 py-2">Exp</th>
                          <th className="px-3 py-2 text-right">Mid</th>
                          <th className="px-3 py-2 text-right">Delta</th>
                          <th className="px-3 py-2 text-right">Theta</th>
                        </tr>
                      </thead>
                      <tbody>
                        {optionLegs.map((leg, index) => (
                          <tr key={`${leg.symbol ?? leg.strike}-${index}`}>
                            <td className="table-cell capitalize">{leg.side}</td>
                            <td className="table-cell capitalize">{leg.optionType}</td>
                            <td className="table-cell text-right">{leg.quantity}</td>
                            <td className="table-cell text-right">{formatNumber(leg.strike, 2)}</td>
                            <td className="table-cell">{leg.expirationDate.toLocaleDateString("es-MX")}</td>
                            <td className="table-cell text-right">{leg.mid === null || leg.mid === undefined ? "-" : formatCurrency(leg.mid, "USD")}</td>
                            <td className="table-cell text-right">{leg.delta === null || leg.delta === undefined ? "-" : formatNumber(leg.delta, 3)}</td>
                            <td className="table-cell text-right">{leg.theta === null || leg.theta === undefined ? "-" : formatNumber(leg.theta, 3)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="mt-4 grid gap-3 md:grid-cols-4">
                    <div>
                      <p className="field-label">Net debit</p>
                      <p className="mt-1 font-bold text-ink">{formatMXN(multiLegMetrics.netDebit)}</p>
                    </div>
                    <div>
                      <p className="field-label">Net credit</p>
                      <p className="mt-1 font-bold text-ink">{formatMXN(multiLegMetrics.netCredit)}</p>
                    </div>
                    <div>
                      <p className="field-label">Max loss</p>
                      <p className="mt-1 font-bold text-ink">{multiLegMetrics.maxLoss === null ? "Undefined" : formatMXN(multiLegMetrics.maxLoss)}</p>
                    </div>
                    <div>
                      <p className="field-label">Max profit</p>
                      <p className="mt-1 font-bold text-ink">{multiLegMetrics.maxProfit === null ? "Unlimited/undefined" : formatMXN(multiLegMetrics.maxProfit)}</p>
                    </div>
                    <div>
                      <p className="field-label">Breakevens</p>
                      <p className="mt-1 font-bold text-ink">{multiLegMetrics.breakevens.length ? multiLegMetrics.breakevens.join(", ") : "-"}</p>
                    </div>
                    <div>
                      <p className="field-label">Total delta</p>
                      <p className="mt-1 font-bold text-ink">{formatNumber(multiLegMetrics.totalDelta, 2)}</p>
                    </div>
                    <div>
                      <p className="field-label">Total theta</p>
                      <p className="mt-1 font-bold text-ink">{formatNumber(multiLegMetrics.totalTheta, 2)}</p>
                    </div>
                    <div>
                      <p className="field-label">Total vega</p>
                      <p className="mt-1 font-bold text-ink">{formatNumber(multiLegMetrics.totalVega, 2)}</p>
                    </div>
                  </div>
                </div>
                <div className="rounded-lg border border-stone-200 bg-white p-4">
                  <p className="field-label">Expiration payoff curve</p>
                  <PayoffChart data={multiLegMetrics.payoffPoints} />
                </div>
              </div>
            ) : null}

            <div className="mt-5 grid gap-4 lg:grid-cols-4">
              <div className="rounded-lg border border-stone-200 bg-white p-4">
                <p className="field-label">Market</p>
                <p className="mt-2 text-2xl font-bold text-ink">{formatNumber(idea.marketRegimeScore, 1)}</p>
              </div>
              <div className="rounded-lg border border-stone-200 bg-white p-4">
                <p className="field-label">Technical</p>
                <p className="mt-2 text-2xl font-bold text-ink">{formatNumber(idea.technicalScore, 1)}</p>
              </div>
              <div className="rounded-lg border border-stone-200 bg-white p-4">
                <p className="field-label">Options</p>
                <p className="mt-2 text-2xl font-bold text-ink">{formatNumber(idea.optionsQualityScore, 1)}</p>
              </div>
              <div className="rounded-lg border border-stone-200 bg-white p-4">
                <p className="field-label">Trade quality</p>
                <p className="mt-2 text-2xl font-bold text-ink">{formatNumber(idea.tradeQualityScore, 1)}</p>
              </div>
            </div>

            <div className="mt-5 grid gap-4 xl:grid-cols-2">
              <div className="rounded-lg border border-stone-200 bg-white p-4">
                <p className="field-label">Technical Snapshot</p>
                <div className="mt-3 grid gap-3 md:grid-cols-3">
                  <div>
                    <p className="field-label">Last close</p>
                    <p className="mt-1 font-bold text-ink">{technicalSnapshot.lastClose === null ? "-" : formatCurrency(technicalSnapshot.lastClose, "USD")}</p>
                  </div>
                  <div>
                    <p className="field-label">SMA20 / SMA50</p>
                    <p className="mt-1 font-bold text-ink">
                      {technicalSnapshot.sma20 === null ? "-" : formatNumber(technicalSnapshot.sma20, 2)} / {technicalSnapshot.sma50 === null ? "-" : formatNumber(technicalSnapshot.sma50, 2)}
                    </p>
                  </div>
                  <div>
                    <p className="field-label">SMA200</p>
                    <p className="mt-1 font-bold text-ink">{technicalSnapshot.sma200 === null ? "-" : formatNumber(technicalSnapshot.sma200, 2)}</p>
                  </div>
                  <div>
                    <p className="field-label">RSI14</p>
                    <p className="mt-1 font-bold text-ink">{technicalSnapshot.rsi14 === null ? "-" : formatNumber(technicalSnapshot.rsi14, 1)}</p>
                  </div>
                  <div>
                    <p className="field-label">ATR14</p>
                    <p className="mt-1 font-bold text-ink">{technicalSnapshot.atr14 === null ? "-" : formatNumber(technicalSnapshot.atr14, 2)}</p>
                  </div>
                  <div>
                    <p className="field-label">Relative volume</p>
                    <p className="mt-1 font-bold text-ink">{technicalSnapshot.relativeVolume === null ? "-" : `${formatNumber(technicalSnapshot.relativeVolume, 2)}x`}</p>
                  </div>
                  <div>
                    <p className="field-label">BWAP</p>
                    <p className="mt-1 font-bold text-ink">{technicalSnapshot.bwap === null ? "-" : formatNumber(technicalSnapshot.bwap, 2)}</p>
                  </div>
                  <div>
                    <p className="field-label">Distance from BWAP</p>
                    <p className="mt-1 font-bold text-ink">{technicalSnapshot.distanceFromBwap === null ? "-" : `${formatNumber(technicalSnapshot.distanceFromBwap, 2)}%`}</p>
                  </div>
                  <div>
                    <p className="field-label">Trend</p>
                    <p className="mt-1 font-bold capitalize text-ink">{technicalSnapshot.trendLabel}</p>
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-stone-200 bg-white p-4">
                <p className="field-label">Options Quality Breakdown</p>
                <div className="mt-3 grid gap-3 md:grid-cols-4">
                  {[
                    ["Spread", optionsQualityBreakdown.spreadQuality],
                    ["DTE", optionsQualityBreakdown.dteQuality],
                    ["Volume", optionsQualityBreakdown.volumeQuality],
                    ["Open interest", optionsQualityBreakdown.openInterestQuality],
                    ["IV rank", optionsQualityBreakdown.ivRankQuality],
                    ["Premium", optionsQualityBreakdown.premiumSizeQuality],
                    ["Theta", optionsQualityBreakdown.thetaDecayQuality]
                  ].map(([label, value]) => (
                    <div key={label as string}>
                      <p className="field-label">{label as string}</p>
                      <p className="mt-1 font-bold text-ink">{formatNumber(Number(value) * 100, 0)}%</p>
                    </div>
                  ))}
                  <div>
                    <p className="field-label">Total</p>
                    <p className="mt-1 font-bold text-ink">{formatNumber(optionsQualityBreakdown.total, 1)}/100</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-5 grid gap-4 lg:grid-cols-6">
              <div className="rounded-lg border border-stone-200 bg-white p-4">
                <p className="field-label">PoP</p>
                <p className="mt-2 text-xl font-bold text-ink">
                  {evaluation.popEstimate.pop === null ? "-" : `${formatNumber(evaluation.popEstimate.pop * 100, 1)}%`}
                </p>
              </div>
              <div className="rounded-lg border border-stone-200 bg-white p-4">
                <p className="field-label">PoP source</p>
                <p className="mt-2 text-sm font-bold capitalize text-ink">{evaluation.popEstimate.source.replaceAll("_", " ")}</p>
                <p className="mt-1 text-xs font-semibold capitalize text-stone-500">{evaluation.popEstimate.confidence} confidence</p>
              </div>
              <div className="rounded-lg border border-stone-200 bg-white p-4">
                <p className="field-label">EV</p>
                <p className="mt-2 text-xl font-bold text-ink">{analytics.expectedValueMXN === null ? "-" : formatMXN(analytics.expectedValueMXN)}</p>
              </div>
              <div className="rounded-lg border border-stone-200 bg-white p-4">
                <p className="field-label">Kelly</p>
                <p className="mt-2 text-xl font-bold text-ink">
                  {evaluation.kelly.isDisabled ? "Disabled" : formatMXN(evaluation.kelly.fractionalKellyRiskCap)}
                </p>
              </div>
              <div className="rounded-lg border border-stone-200 bg-white p-4">
                <p className="field-label">VaR95</p>
                <p className="mt-2 text-xl font-bold text-ink">{analytics.var95MXN === null ? "-" : formatMXN(analytics.var95MXN)}</p>
              </div>
              <div className="rounded-lg border border-stone-200 bg-white p-4">
                <p className="field-label">Daily theta</p>
                <p className="mt-2 text-xl font-bold text-ink">{formatMXN(analytics.thetaDailyMXN)}</p>
              </div>
            </div>

            <div className="mt-5 grid gap-4 xl:grid-cols-3">
              <div className="rounded-lg border border-stone-200 bg-white p-4">
                <p className="field-label">Probability of Profit</p>
                <p className="mt-2 text-sm leading-6 text-stone-600">
                  Source: <span className="font-bold capitalize text-ink">{evaluation.popEstimate.source.replaceAll("_", " ")}</span>, confidence{" "}
                  <span className="font-bold capitalize text-ink">{evaluation.popEstimate.confidence}</span>.
                </p>
                {evaluation.popEstimate.warnings.length || evaluation.kelly.warnings.length ? (
                  <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-950">
                    {[...evaluation.popEstimate.warnings, ...evaluation.kelly.warnings].map((item) => (
                      <p key={item}>- {item}</p>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="rounded-lg border border-stone-200 bg-white p-4">
                <p className="field-label">Event Risk</p>
                <div className="mt-3 grid gap-2 text-sm text-stone-600">
                  <p>
                    Level: <span className="font-bold capitalize text-ink">{evaluation.eventRisk.eventRiskLevel}</span>
                  </p>
                  <p>Earnings crossing: {evaluation.eventRisk.crossesEarnings ? "yes" : "no"}</p>
                  <p>Macro crossing: {evaluation.eventRisk.crossesMacroEvent ? "yes" : "no"}</p>
                  <p>Risk multiplier: {formatNumber(evaluation.eventRisk.riskMultiplier, 2)}</p>
                </div>
                {evaluation.eventRisk.events.length ? (
                  <div className="mt-3 text-sm leading-6 text-stone-600">
                    {evaluation.eventRisk.events.slice(0, 4).map((event) => (
                      <p key={`${event.type}-${event.title}`}>- {event.title}: {event.date.toLocaleDateString("es-MX")}</p>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="rounded-lg border border-stone-200 bg-white p-4">
                <p className="field-label">Strategy Checks</p>
                <div className="mt-3 grid gap-2 text-sm text-stone-600">
                  <p>Score adjustment: {evaluation.strategyChecks.scoreAdjustments >= 0 ? "+" : ""}{formatNumber(evaluation.strategyChecks.scoreAdjustments, 1)}</p>
                  <p>Hard stops: {evaluation.strategyChecks.hardStops.length}</p>
                  <p>Decision caps: {evaluation.strategyChecks.caps.length ? evaluation.strategyChecks.caps.join(", ").replaceAll("_", " ") : "none"}</p>
                </div>
                {evaluation.strategyChecks.warnings.length ? (
                  <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-950">
                    {evaluation.strategyChecks.warnings.slice(0, 4).map((item) => (
                      <p key={item}>- {item}</p>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>

            <div className="mt-5 grid gap-4 xl:grid-cols-2">
              <div className="rounded-lg border border-stone-200 bg-white p-4">
                <p className="field-label">Monte Carlo Payoff Simulation</p>
                {monteCarlo ? (
                  <div className="mt-3 grid gap-3 md:grid-cols-3">
                    <div>
                      <p className="field-label">PoP</p>
                      <p className="mt-1 font-bold text-ink">{formatNumber(monteCarlo.probabilityOfProfit * 100, 1)}%</p>
                    </div>
                    <div>
                      <p className="field-label">EV</p>
                      <p className="mt-1 font-bold text-ink">{formatMXN(monteCarlo.expectedValue)}</p>
                    </div>
                    <div>
                      <p className="field-label">Median P&L</p>
                      <p className="mt-1 font-bold text-ink">{formatMXN(monteCarlo.medianPnL)}</p>
                    </div>
                    <div>
                      <p className="field-label">P5 / P95</p>
                      <p className="mt-1 font-bold text-ink">{formatMXN(monteCarlo.p5)} / {formatMXN(monteCarlo.p95)}</p>
                    </div>
                    <div>
                      <p className="field-label">CVaR95</p>
                      <p className="mt-1 font-bold text-ink">{formatMXN(monteCarlo.cvar95)}</p>
                    </div>
                    <div>
                      <p className="field-label">Sim range</p>
                      <p className="mt-1 font-bold text-ink">{formatMXN(monteCarlo.maxSimulatedLoss)} / {formatMXN(monteCarlo.maxSimulatedGain)}</p>
                    </div>
                  </div>
                ) : (
                  <p className="mt-3 text-sm text-stone-500">Needs option legs, underlying price, IV, and DTE.</p>
                )}
              </div>
              <div className="rounded-lg border border-stone-200 bg-white p-4">
                <p className="field-label">Monte Carlo histogram</p>
                <MonteCarloHistogram data={monteCarlo?.histogram ?? []} />
              </div>
            </div>

            <div className="mt-5 rounded-lg border border-stone-200 bg-white p-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                  <p className="field-label">Yahoo Finance Sentiment</p>
                  <p className="mt-1 text-sm text-stone-600">
                    Optional public-news overlay. It is best-effort, secondary, and cannot approve a trade by itself.
                  </p>
                </div>
                <form action={refreshYahooFinanceSentimentForIdea}>
                  <input type="hidden" name="tradeIdeaId" value={idea.id} />
                  <button className="btn-secondary" disabled={!settings.enableYahooFinanceSentiment} type="submit">
                    <RefreshCw className="h-4 w-4" aria-hidden="true" />
                    Refresh Yahoo
                  </button>
                </form>
              </div>
              <div className="mt-4 grid gap-3 md:grid-cols-6">
                <div>
                  <p className="field-label">Label</p>
                  <p className="mt-1 font-bold capitalize text-ink">{yahooSentiment.label.replaceAll("_", " ")}</p>
                </div>
                <div>
                  <p className="field-label">Score</p>
                  <p className="mt-1 font-bold text-ink">{formatNumber(yahooSentiment.sentimentScore, 2)}</p>
                </div>
                <div>
                  <p className="field-label">Confidence</p>
                  <p className="mt-1 font-bold text-ink">{formatNumber(yahooSentiment.confidence * 100, 0)}%</p>
                </div>
                <div>
                  <p className="field-label">Relevance</p>
                  <p className="mt-1 font-bold text-ink">{formatNumber(yahooSentiment.relevance * 100, 0)}%</p>
                </div>
                <div>
                  <p className="field-label">Hype</p>
                  <p className="mt-1 font-bold text-ink">{formatNumber(yahooSentiment.hypeScore * 100, 0)}%</p>
                </div>
                <div>
                  <p className="field-label">Fear</p>
                  <p className="mt-1 font-bold text-ink">{formatNumber(yahooSentiment.fearScore * 100, 0)}%</p>
                </div>
              </div>
              <p className="mt-3 text-sm leading-6 text-stone-600">{yahooSentiment.summary}</p>
              {yahooSentiment.catalystMentions.length || yahooSentiment.concernMentions.length || yahooSentiment.warnings.length ? (
                <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-950">
                  {[...yahooSentiment.catalystMentions, ...yahooSentiment.concernMentions, ...yahooSentiment.warnings.slice(0, 3)].map((item) => (
                    <p key={item}>- {item}</p>
                  ))}
                </div>
              ) : null}
              <p className="mt-3 text-xs font-semibold text-stone-500">
                Documents used: {yahooSentiment.documentsUsed.length}. Score adjustment: {evaluation.yahooSentimentOverlay?.scoreAdjustment ?? 0}; risk multiplier: {evaluation.yahooSentimentOverlay?.riskMultiplier ?? 1}.
              </p>
            </div>

            <div className="mt-5 grid gap-4 lg:grid-cols-2">
              <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
                <p className="text-sm font-bold text-ink">Reasons</p>
                <ul className="mt-2 grid gap-2 text-sm leading-5 text-stone-600">
                  {lines(idea.reasons).map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </div>
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                <p className="text-sm font-bold text-amber-950">Warnings</p>
                {lines(idea.warnings).length ? (
                  <ul className="mt-2 grid gap-2 text-sm leading-5 text-amber-950">
                    {lines(idea.warnings).map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-amber-950">No hard-stop warnings.</p>
                )}
              </div>
            </div>

            <div className="mt-5 flex flex-col gap-3 lg:flex-row">
              <details className="flex-1 rounded-lg border border-stone-200 bg-stone-50 p-4">
                <summary className="cursor-pointer text-sm font-bold text-ink">Edit and re-score</summary>
                <div className="mt-4">
                  <TradeIdeaForm portfolioId={selectedPortfolio.id} idea={idea} />
                </div>
              </details>
              <form action={deleteTradeIdea}>
                <input type="hidden" name="id" value={idea.id} />
                <button className="btn-danger" type="submit">
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                  Delete
                </button>
              </form>
            </div>
          </article>
          );
        })}

        {!ideas.length ? (
          <div className="panel-pad text-sm text-stone-500">
            No trade ideas yet. Add the first one above, then use the score to decide whether it is rejected, watchlisted, approved small, or approved normal.
          </div>
        ) : null}
      </section>
    </div>
  );
}
