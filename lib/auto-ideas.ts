import { prisma } from "@/lib/db";
import { discoverStocks, type DiscoveryCandidate } from "@/lib/discovery";
import { getRiskExposure, getRiskSettings } from "@/lib/data";
import {
  buildMarketContext,
  defaultWatchlistSymbols,
  fetchYahooChart,
  fetchYahooQuote,
  startOfLocalDay,
  summarizeSymbolTechnical
} from "@/lib/market-data";
import { findBestOptionContract, type OptionContractSelection } from "@/lib/option-selector";
import { evaluateTradeIdea, type TradeInput } from "@/lib/risk";
import type { OptionLegInput } from "@/lib/options/multileg";
import { saveTradeScoreSnapshot } from "@/lib/daily-refresh";
import { contractVariantFingerprint } from "@/lib/idea-variants";

export const autoIdeaMarker = "Auto-generated discovery idea.";

export type AutoIdeaScanResult = {
  created: number;
  updated: number;
  skipped: number;
  symbolsScanned: number;
  candidatesFound: number;
  sourceStatus: "ok" | "partial" | "failed";
  errors: string[];
};

const autoIdeaLocks = new Map<string, Promise<AutoIdeaScanResult>>();
let usdMxnRatePromise: Promise<number | null> | null = null;

function directionFromCandidate(candidate: Pick<DiscoveryCandidate, "bias">) {
  if (candidate.bias === "bearish") return "bearish";
  if (candidate.bias === "bullish") return "bullish";
  return null;
}

function invalidationFromPrice(price: number | null, direction: string) {
  if (!price || price <= 0) return null;
  const multiplier = direction === "bearish" ? 1.05 : 0.95;
  return Number((price * multiplier).toFixed(2));
}

function targetFromPrice(price: number | null, direction: string) {
  if (!price || price <= 0) return null;
  const multiplier = direction === "bearish" ? 0.92 : 1.08;
  return Number((price * multiplier).toFixed(2));
}

async function getUsdMxnRate() {
  usdMxnRatePromise ??= fetchYahooQuote("USDMXN=X")
    .then((quote) => (quote.currentPrice && quote.currentPrice > 0 ? quote.currentPrice : null))
    .catch(() => null);
  return usdMxnRatePromise;
}

async function getOptionCurrencyMultiplier(portfolioId: string) {
  const portfolio = await prisma.portfolio.findUnique({
    where: { id: portfolioId },
    select: { baseCurrency: true }
  });

  if (portfolio?.baseCurrency === "USD") return 1;
  return (await getUsdMxnRate()) ?? 17;
}

function expirationDateFromSelection(selection: OptionContractSelection | null) {
  if (!selection?.contract.expirationDate) return null;
  const date = new Date(`${selection.contract.expirationDate}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function snapshotDateFromSelection(selection: OptionContractSelection | null) {
  if (!selection?.contract.updatedAt) return null;
  const date = new Date(selection.contract.updatedAt);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function contractSummary(selection: OptionContractSelection | null) {
  if (!selection) return null;
  const { contract } = selection;
  return [
    selection.strategy === "debit_spread"
      ? `Selected debit spread ${contract.symbol} / ${selection.shortContract?.symbol ?? "short leg"}`
      : `Selected contract ${contract.symbol}`,
    selection.dte !== null ? `${selection.dte} DTE` : null,
    contract.strikePrice !== null ? `strike ${contract.strikePrice}` : null,
    selection.shortContract?.strikePrice !== null && selection.shortContract?.strikePrice !== undefined
      ? `short strike ${selection.shortContract.strikePrice}`
      : null,
    selection.netMid !== null ? `net mid ${selection.netMid.toFixed(2)}` : null,
    selection.netDelta !== null ? `net delta ${selection.netDelta.toFixed(2)}` : null,
    selection.netSpreadPercent !== null ? `spread ${selection.netSpreadPercent.toFixed(1)}%` : null,
    contract.impliedVolatility !== null ? `IV ${(contract.impliedVolatility * 100).toFixed(1)}%` : null,
    selection.thetaRatio !== null ? `theta/mid ${(selection.thetaRatio * 100).toFixed(1)}%` : null
  ]
    .filter(Boolean)
    .join(", ");
}

function legFromSelectionContract(
  selection: OptionContractSelection,
  side: "long" | "short",
  contract = selection.contract
): OptionLegInput | null {
  if (!contract.strikePrice || !contract.expirationDate) return null;
  const expirationDate = new Date(`${contract.expirationDate}T00:00:00`);
  if (Number.isNaN(expirationDate.getTime())) return null;

  return {
    symbol: contract.symbol,
    underlying: contract.underlyingSymbol,
    optionType: contract.optionType,
    side,
    quantity: 1,
    expirationDate,
    strike: contract.strikePrice,
    bid: contract.bid,
    ask: contract.ask,
    mid: contract.mid,
    spreadPercent: contract.bidAskSpreadPercent,
    impliedVol: contract.impliedVolatility,
    ivRank: contract.impliedVolatility === null ? null : Math.min(Number((contract.impliedVolatility * 100).toFixed(0)), 100),
    delta: contract.delta,
    gamma: contract.gamma,
    theta: contract.theta,
    vega: contract.vega,
    rho: contract.rho,
    openInterest: contract.openInterest,
    volume: contract.volume,
    dte: selection.dte
  };
}

function optionLegsFromSelection(selection: OptionContractSelection | null) {
  if (!selection) return [];
  const longLeg = legFromSelectionContract(selection, "long");
  const shortLeg = selection.shortContract ? legFromSelectionContract(selection, "short", selection.shortContract) : null;
  return [longLeg, shortLeg].filter((leg): leg is OptionLegInput => leg !== null);
}

function optionLegCreateData(optionLegs: OptionLegInput[]) {
  return optionLegs.map((leg) => ({
    symbol: leg.symbol ?? null,
    underlying: leg.underlying ?? "",
    optionType: leg.optionType,
    side: leg.side,
    quantity: leg.quantity,
    expirationDate: leg.expirationDate,
    strike: leg.strike,
    bid: leg.bid ?? null,
    ask: leg.ask ?? null,
    mid: leg.mid ?? null,
    spreadPercent: leg.spreadPercent ?? null,
    impliedVol: leg.impliedVol ?? null,
    ivRank: leg.ivRank ?? null,
    delta: leg.delta ?? null,
    gamma: leg.gamma ?? null,
    theta: leg.theta ?? null,
    vega: leg.vega ?? null,
    rho: leg.rho ?? null,
    openInterest: leg.openInterest === null || leg.openInterest === undefined ? null : Math.trunc(leg.openInterest),
    volume: leg.volume === null || leg.volume === undefined ? null : Math.trunc(leg.volume),
    dte: leg.dte === null || leg.dte === undefined ? null : Math.trunc(leg.dte)
  }));
}

async function marketContext() {
  try {
    const [spy, qqq, vix, ...breadth] = await Promise.all([
      fetchYahooChart("SPY", "6mo", "1d"),
      fetchYahooChart("QQQ", "6mo", "1d"),
      fetchYahooChart("^VIX", "6mo", "1d"),
      ...defaultWatchlistSymbols
        .filter((item) => ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AMD"].includes(item.symbol))
        .map((item) => fetchYahooChart(item.symbol, "6mo", "1d"))
    ]);

    return buildMarketContext({
      spy: spy.history,
      qqq: qqq.history,
      vix: vix.history,
      breadthHistories: breadth.map((item) => item.history)
    });
  } catch {
    return {
      spyTrend: "neutral" as const,
      qqqTrend: "neutral" as const,
      vixCondition: "normal" as const,
      marketBreadth: "neutral" as const,
      macroRisk: "medium" as const,
      notes: ["Market context fallback used."]
    };
  }
}

async function technicalForSymbol(symbol: string, candidate: DiscoveryCandidate) {
  try {
    const chart = await fetchYahooChart(symbol, "6mo", "1d");
    return summarizeSymbolTechnical(chart.history);
  } catch {
    const bullish = (candidate.dayChangePercent ?? 0) >= 0;

    return {
      trend: bullish ? ("uptrend" as const) : ("downtrend" as const),
      priceVs20MA: bullish ? ("above" as const) : ("below" as const),
      priceVs50MA: bullish ? ("above" as const) : ("below" as const),
      rsiCondition: "neutral" as const,
      volumeCondition:
        candidate.volumeRatio !== null && candidate.volumeRatio >= 1.25 ? ("strong" as const) : ("normal" as const),
      supportResistanceQuality: "average" as const,
      lastPrice: candidate.price,
      sma20: null,
      sma50: null,
      rsi14: null,
      lastVolume: candidate.volume,
      averageVolume20: candidate.averageVolume
    };
  }
}

async function bestOptionContractFor(candidate: DiscoveryCandidate, direction: string, maxDebit: number | null) {
  try {
    return await findBestOptionContract({
      symbol: candidate.symbol,
      direction,
      underlyingPrice: candidate.price,
      maxDebit
    });
  } catch {
    return null;
  }
}

function qualifiesForAutomaticResearch(candidate: DiscoveryCandidate) {
  const mediumVolatility =
    candidate.realizedVolatility20 !== null &&
    candidate.realizedVolatility20 >= 15 &&
    candidate.realizedVolatility20 <= 80;

  return (
    candidate.optionsLikely &&
    candidate.bias !== "mixed" &&
    candidate.hasHistoricalData &&
    candidate.dataCoverage >= 70 &&
    candidate.discoveryScore >= 50 &&
    candidate.extensionPenalty >= 0.65 &&
    candidate.technicalSetupScore >= 50 &&
    mediumVolatility
  );
}

function noveltyRank(candidate: DiscoveryCandidate) {
  const dynamicSourceBonus = candidate.sources.some((source) => source.includes("Core liquid universe")) ? 0 : 8;
  const sourceBreadthBonus = Math.max(candidate.sources.length - 1, 0) * 2;
  return candidate.discoveryScore + dynamicSourceBonus + sourceBreadthBonus + candidate.dataCoverage * 0.03;
}

async function candidatePool(portfolioId: string, targetCount: number) {
  const result = await discoverStocks({
    includeReddit: false,
    limit: Math.max(targetCount * 10, 200),
    minScore: 0,
    profile: "quality"
  });
  const qualityCandidates = result.candidates.filter(qualifiesForAutomaticResearch);
  const [historyRows, savedIdeas] = await Promise.all([
    prisma.discoverySymbolHistory.findMany({
      where: { portfolioId },
      select: { symbol: true, lastSavedAt: true }
    }),
    prisma.tradeIdea.findMany({
      where: { portfolioId, thesis: { contains: autoIdeaMarker } },
      distinct: ["symbol"],
      select: { symbol: true }
    })
  ]);
  const historyBySymbol = new Map(historyRows.map((row) => [row.symbol.toUpperCase(), row]));
  const savedSymbols = new Set([
    ...historyRows.filter((row) => row.lastSavedAt).map((row) => row.symbol.toUpperCase()),
    ...savedIdeas.map((idea) => idea.symbol.toUpperCase())
  ]);
  const now = new Date();

  if (qualityCandidates.length) {
    await prisma.$transaction(
      qualityCandidates.map((candidate) =>
        prisma.discoverySymbolHistory.upsert({
          where: { portfolioId_symbol: { portfolioId, symbol: candidate.symbol } },
          create: {
            portfolioId,
            symbol: candidate.symbol,
            firstQualifiedAt: now,
            lastQualifiedAt: now,
            timesSurfaced: 1,
            lastDiscoveryScore: candidate.discoveryScore,
            lastOutcome: "qualified",
            lastReason: candidate.reasons.slice(0, 2).join(" ")
          },
          update: {
            lastQualifiedAt: now,
            timesSurfaced: { increment: 1 },
            lastDiscoveryScore: candidate.discoveryScore,
            lastOutcome: "qualified",
            lastReason: candidate.reasons.slice(0, 2).join(" ")
          }
        })
      )
    );
  }

  const newCandidates = qualityCandidates
    .filter((candidate) => !savedSymbols.has(candidate.symbol.toUpperCase()))
    .sort((left, right) => noveltyRank(right) - noveltyRank(left))
    .slice(0, targetCount);
  const updateCooldown = new Date(now);
  updateCooldown.setDate(updateCooldown.getDate() - 2);
  const contractUpdateCandidates = qualityCandidates
    .filter((candidate) => savedSymbols.has(candidate.symbol.toUpperCase()))
    .filter((candidate) => {
      const lastSavedAt = historyBySymbol.get(candidate.symbol.toUpperCase())?.lastSavedAt;
      return !lastSavedAt || lastSavedAt < updateCooldown;
    })
    .sort((left, right) => right.discoveryScore - left.discoveryScore)
    .slice(0, 3);
  const candidates = [...newCandidates, ...contractUpdateCandidates];

  if (!qualityCandidates.length && result.candidates.length) {
    result.sourceErrors.push("No candidate passed the automatic history, coverage, direction, volatility, and liquidity gates.");
  }

  return {
    candidates,
    symbolsScanned: result.funnel.uniqueSymbols,
    qualifiedCandidates: qualityCandidates.length,
    sourceStatus: result.sourceStatus.yahoo,
    errors: result.sourceErrors
  };
}

async function buildTradeInput(candidate: DiscoveryCandidate, portfolioId: string): Promise<TradeInput & { expirationDate: Date | null }> {
  const settings = await getRiskSettings(portfolioId);
  const context = await marketContext();
  const technical = await technicalForSymbol(candidate.symbol, candidate);
  const direction = directionFromCandidate(candidate);
  if (!direction) {
    throw new Error(`${candidate.symbol} has mixed directional evidence; no option idea was forced.`);
  }
  const optionCurrencyMultiplier = await getOptionCurrencyMultiplier(portfolioId);
  const maxAutoDebit =
    Math.min(settings.totalPortfolioValue * 0.01, settings.maxOptionsSleeveMXN * 0.5, settings.baseRiskPerTradeMXN * 2) /
    optionCurrencyMultiplier /
    100;
  const optionSelection = await bestOptionContractFor(candidate, direction, maxAutoDebit);
  const contractPremiumBase =
    optionSelection?.netMid !== null && optionSelection?.netMid !== undefined
      ? optionSelection.netMid * 100 * optionCurrencyMultiplier
      : null;
  const spreadRewardBase =
    optionSelection?.strategy === "debit_spread" && optionSelection.width !== null && optionSelection.netMid !== null
      ? Math.max((optionSelection.width - optionSelection.netMid) * 100 * optionCurrencyMultiplier, 0)
      : null;
  const maxLoss = contractPremiumBase
    ? Math.max(50, Number(contractPremiumBase.toFixed(0)))
    : Math.max(50, Number(settings.baseRiskPerTradeMXN.toFixed(0)));
  const discoveryNotes = candidate.reasons.join(" ");
  const contractNotes = optionSelection
    ? ` ${contractSummary(optionSelection)}. ${optionSelection.reasons.join(" ")}`
    : " No suitable Alpaca contract was attached automatically.";
  const warnings = [...candidate.warnings, ...(optionSelection?.warnings ?? [])];
  const warningNotes = warnings.length ? ` Warnings: ${warnings.join(" ")}` : "";
  const hasCleanContract = Boolean(optionSelection && optionSelection.score >= 60 && !optionSelection.warnings.length);

  return {
    symbol: candidate.symbol,
    direction,
    strategy: optionSelection?.strategy === "debit_spread" ? "debit_spread" : direction === "bearish" ? "long_put" : "long_call",
    thesis: `${autoIdeaMarker} Discovery score ${candidate.discoveryScore.toFixed(1)}/100. ${discoveryNotes}${contractNotes}${warningNotes}`,
    catalyst: candidate.sources.join(", "),
    invalidationLevel: invalidationFromPrice(candidate.price, direction),
    optionLegs: optionLegsFromSelection(optionSelection),
    optionContractSymbol: optionSelection?.contract.symbol ?? null,
    optionType: optionSelection?.contract.optionType ?? (direction === "bearish" ? "put" : "call"),
    strikePrice: optionSelection?.contract.strikePrice ?? null,
    shortStrikePrice: optionSelection?.shortContract?.strikePrice ?? null,
    contractBid: optionSelection?.strategy === "debit_spread" ? null : optionSelection?.contract.bid ?? null,
    contractAsk: optionSelection?.strategy === "debit_spread" ? null : optionSelection?.contract.ask ?? null,
    contractMid: optionSelection?.netMid ?? null,
    contractDelta: optionSelection?.netDelta ?? null,
    contractGamma: optionSelection?.netGamma ?? null,
    contractTheta: optionSelection?.netTheta ?? null,
    contractVega: optionSelection?.netVega ?? null,
    contractRho: optionSelection?.netRho ?? null,
    contractImpliedVolatility: optionSelection?.contract.impliedVolatility ?? null,
    contractUnderlyingPrice: optionSelection?.contract.underlyingPrice ?? candidate.price,
    contractBreakEvenPrice:
      optionSelection?.contract.strikePrice !== null &&
      optionSelection?.contract.strikePrice !== undefined &&
      optionSelection.netMid !== null &&
      optionSelection.netMid !== undefined
        ? direction === "bearish"
          ? optionSelection.contract.strikePrice - optionSelection.netMid
          : optionSelection.contract.strikePrice + optionSelection.netMid
        : optionSelection?.contract.breakEvenPrice ?? null,
    contractSnapshotAt: snapshotDateFromSelection(optionSelection),
    premiumCost: optionSelection?.netMid ?? null,
    maxLoss,
    expectedReward: spreadRewardBase ? Number(spreadRewardBase.toFixed(0)) : maxLoss * 2,
    expirationDate: expirationDateFromSelection(optionSelection),
    exitPlan: "Research lead only. Before entry, confirm the selected contract, define invalidation, confirm liquidity, and replace this auto exit plan with a manual one.",
    spyTrend: context.spyTrend,
    qqqTrend: context.qqqTrend,
    vixCondition: context.vixCondition,
    marketBreadth: context.marketBreadth,
    macroRisk: context.macroRisk,
    trend: technical.trend,
    priceVs20MA: technical.priceVs20MA,
    priceVs50MA: technical.priceVs50MA,
    rsiCondition: technical.rsiCondition,
    volumeCondition: technical.volumeCondition,
    supportResistanceQuality: technical.supportResistanceQuality,
    bidAskSpreadPercent: optionSelection?.netSpreadPercent ?? 16,
    optionVolume:
      optionSelection?.shortContract && optionSelection.contract.volume !== null && optionSelection.shortContract.volume !== null
        ? Math.min(optionSelection.contract.volume, optionSelection.shortContract.volume)
        : optionSelection?.contract.volume ?? 10,
    openInterest:
      optionSelection?.shortContract && optionSelection.contract.openInterest !== null && optionSelection.shortContract.openInterest !== null
        ? Math.min(optionSelection.contract.openInterest, optionSelection.shortContract.openInterest)
        : optionSelection?.contract.openInterest ?? 50,
    daysToExpiration: optionSelection?.dte ?? 30,
    impliedVolatilityRank:
      optionSelection?.contract.impliedVolatility !== null && optionSelection?.contract.impliedVolatility !== undefined
        ? Math.min(Number((optionSelection.contract.impliedVolatility * 100).toFixed(0)), 100)
        : null,
    premiumAsPercentOfPortfolio: Number(((maxLoss / settings.totalPortfolioValue) * 100).toFixed(2)),
    isChasing:
      candidate.socialScore >= 75 ||
      candidate.extensionPenalty < 0.8 ||
      Math.abs(candidate.dayChangePercent ?? 0) >= 7 ||
      !hasCleanContract
  };
}

async function createAutoIdea(portfolioId: string, candidate: DiscoveryCandidate, today = startOfLocalDay()) {
  const symbol = candidate.symbol.toUpperCase();
  const previousHistory = await prisma.discoverySymbolHistory.findUnique({
    where: { portfolioId_symbol: { portfolioId, symbol } },
    select: { lastSavedAt: true }
  });
  const payload = await buildTradeInput(candidate, portfolioId);
  const { optionLegs, ...tradeData } = payload;
  const possibleEquivalents = await prisma.tradeIdea.findMany({
    where: {
      portfolioId,
      symbol,
      direction: payload.direction,
      strategy: payload.strategy,
      status: { notIn: ["closed", "replaced"] },
      OR: [{ expirationDate: null }, { expirationDate: { gte: today } }],
      thesis: {
        contains: autoIdeaMarker
      }
    },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      symbol: true,
      direction: true,
      strategy: true,
      optionContractSymbol: true,
      expirationDate: true,
      strikePrice: true,
      shortStrikePrice: true
    }
  });
  const payloadFingerprint = contractVariantFingerprint(payload);
  const equivalent = possibleEquivalents.find(
    (idea) => contractVariantFingerprint(idea) === payloadFingerprint
  );
  const settings = await getRiskSettings(portfolioId);
  const exposure = await getRiskExposure(portfolioId, equivalent?.id);
  const score = evaluateTradeIdea(payload, settings, exposure);
  const autoDecision = score.decision === "reject" ? "reject" : "watchlist";
  const autoSuggestedRiskMXN = 0;
  const status = autoDecision === "reject" ? "rejected" : "watchlist";
  const autoWarnings = [
    "Auto-discovery ideas are capped at watchlist until you manually review the contract and complete the trade plan.",
    ...score.warnings
  ];
  const evaluatedAt = new Date();
  const scoreData = {
    marketRegimeScore: score.marketRegimeScore,
    technicalScore: score.technicalScore,
    optionsQualityScore: score.optionsQualityScore,
    tradeQualityScore: score.tradeQualityScore,
    totalScore: score.totalScore,
    decision: autoDecision,
    suggestedRiskMXN: autoSuggestedRiskMXN,
    reasons: score.reasons.join("\n"),
    warnings: autoWarnings.join("\n")
  };
  const ideaData = {
    ...tradeData,
    targetPrice: targetFromPrice(candidate.price, payload.direction),
    status,
    lastEvaluatedAt: evaluatedAt,
    ...scoreData
  };
  const idea = equivalent
    ? await prisma.tradeIdea.update({
        where: { id: equivalent.id },
        data: {
          ...ideaData,
          optionLegs: {
            deleteMany: {},
            ...(optionLegs?.length ? { create: optionLegCreateData(optionLegs) } : {})
          },
          scores: {
            upsert: {
              create: scoreData,
              update: scoreData
            }
          }
        }
      })
    : await prisma.tradeIdea.create({
        data: {
          portfolioId,
          ...ideaData,
          optionLegs: optionLegs?.length
            ? {
                create: optionLegCreateData(optionLegs)
              }
            : undefined,
          scores: {
            create: scoreData
          }
        }
      });

  await saveTradeScoreSnapshot(
    idea.id,
    {
      ...score,
      decision: autoDecision,
      suggestedRiskMXN: autoSuggestedRiskMXN,
      warnings: autoWarnings
    },
    today
  );

  const historyOutcome = equivalent
    ? "reevaluated"
    : previousHistory?.lastSavedAt
      ? "contract_update"
      : "new_underlying";
  await prisma.discoverySymbolHistory.upsert({
    where: { portfolioId_symbol: { portfolioId, symbol } },
    create: {
      portfolioId,
      symbol,
      firstQualifiedAt: evaluatedAt,
      lastQualifiedAt: evaluatedAt,
      lastSavedAt: evaluatedAt,
      timesSurfaced: 1,
      lastDiscoveryScore: candidate.discoveryScore,
      lastOutcome: historyOutcome,
      lastReason: candidate.reasons.slice(0, 2).join(" ")
    },
    update: {
      lastQualifiedAt: evaluatedAt,
      lastSavedAt: evaluatedAt,
      lastDiscoveryScore: candidate.discoveryScore,
      lastOutcome: historyOutcome,
      lastReason: candidate.reasons.slice(0, 2).join(" ")
    }
  });

  return {
    id: idea.id,
    created: !equivalent,
    updated: Boolean(equivalent)
  };
}

export async function createAutoIdeaFromDiscoveryCandidate(portfolioId: string, candidate: DiscoveryCandidate) {
  return createAutoIdea(portfolioId, candidate);
}

async function ensureDailyAutoIdeasInner(portfolioId: string, targetCount = 5, _force = false): Promise<AutoIdeaScanResult> {
  const today = startOfLocalDay();
  const pool = await candidatePool(portfolioId, targetCount);
  const candidates = pool.candidates;
  let created = 0;
  let updated = 0;
  const errors = [...pool.errors];

  for (const candidate of candidates) {
    try {
      const result = await createAutoIdea(portfolioId, candidate, today);
      if (result.created) created += 1;
      if (result.updated) updated += 1;
    } catch (error) {
      errors.push(`${candidate.symbol}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (candidates.length > 0 && created + updated === 0) {
    throw new Error(`All ${candidates.length} candidate writes failed. ${errors.join(" | ")}`);
  }

  return {
    created,
    updated,
    skipped: candidates.length - created - updated,
    symbolsScanned: pool.symbolsScanned,
    candidatesFound: pool.qualifiedCandidates,
    sourceStatus: pool.sourceStatus,
    errors: Array.from(new Set(errors))
  };
}

export async function ensureDailyAutoIdeas(portfolioId: string, targetCount = 5, force = false) {
  const today = startOfLocalDay().toISOString().slice(0, 10);
  const lockKey = `${portfolioId}:${today}:${targetCount}:${force ? "force" : "daily"}`;
  const active = autoIdeaLocks.get(lockKey);
  if (active) return active;

  const pending = ensureDailyAutoIdeasInner(portfolioId, targetCount, force).finally(() => {
    autoIdeaLocks.delete(lockKey);
  });
  autoIdeaLocks.set(lockKey, pending);
  return pending;
}

export function isAutoIdea(thesis: string | null | undefined) {
  return Boolean(thesis?.includes(autoIdeaMarker));
}
