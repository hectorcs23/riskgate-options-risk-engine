import type { OptionLeg, TradeIdea } from "@prisma/client";
import { prisma } from "@/lib/db";
import { alpacaConfigured, fetchAlpacaOptionSnapshot } from "@/lib/alpaca-options";
import { getRiskExposure, getRiskSettings } from "@/lib/data";
import { evaluateTradeIdea, type TradeInput } from "@/lib/risk";
import { technicalSnapshotFromBars } from "@/lib/indicators";
import {
  buildMarketContext,
  defaultWatchlistSymbols,
  fetchYahooChart,
  fetchYahooQuote,
  sameLocalDate,
  startOfLocalDay,
  summarizeSymbolTechnical,
  type YahooChart
} from "@/lib/market-data";

type ScoreResult = ReturnType<typeof evaluateTradeIdea>;

function scoreData(score: ScoreResult, reasons = score.reasons, warnings = score.warnings) {
  return {
    marketRegimeScore: score.marketRegimeScore,
    technicalScore: score.technicalScore,
    optionsQualityScore: score.optionsQualityScore,
    tradeQualityScore: score.tradeQualityScore,
    totalScore: score.totalScore,
    decision: score.decision,
    suggestedRiskMXN: score.suggestedRiskMXN,
    reasons: reasons.join("\n"),
    warnings: warnings.join("\n")
  };
}

function dailyStatus(status: string, decision: string) {
  if (["draft", "entered", "closed"].includes(status)) return status;
  if (decision === "reject") return "rejected";
  if (decision === "watchlist") return "watchlist";
  return "approved";
}

function payloadFromIdea(idea: TradeIdea & { optionLegs?: OptionLeg[] }, overlay: Partial<TradeInput> = {}): TradeInput {
  return {
    symbol: idea.symbol,
    direction: idea.direction,
    strategy: idea.strategy,
    thesis: idea.thesis,
    catalyst: idea.catalyst,
    invalidationLevel: idea.invalidationLevel,
    expirationDate: idea.expirationDate,
    optionContractSymbol: idea.optionContractSymbol,
    optionType: idea.optionType,
    strikePrice: idea.strikePrice,
    shortStrikePrice: idea.shortStrikePrice,
    contractBid: idea.contractBid,
    contractAsk: idea.contractAsk,
    contractMid: idea.contractMid,
    contractDelta: idea.contractDelta,
    contractGamma: idea.contractGamma,
    contractTheta: idea.contractTheta,
    contractVega: idea.contractVega,
    contractRho: idea.contractRho,
    contractImpliedVolatility: idea.contractImpliedVolatility,
    contractUnderlyingPrice: idea.contractUnderlyingPrice,
    contractBreakEvenPrice: idea.contractBreakEvenPrice,
    contractSnapshotAt: idea.contractSnapshotAt,
    premiumCost: idea.premiumCost,
    maxLoss: idea.maxLoss,
    expectedReward: idea.expectedReward,
    exitPlan: idea.exitPlan,
    spyTrend: idea.spyTrend,
    qqqTrend: idea.qqqTrend,
    vixCondition: idea.vixCondition,
    marketBreadth: idea.marketBreadth,
    macroRisk: idea.macroRisk,
    trend: idea.trend,
    priceVs20MA: idea.priceVs20MA,
    priceVs50MA: idea.priceVs50MA,
    rsiCondition: idea.rsiCondition,
    volumeCondition: idea.volumeCondition,
    supportResistanceQuality: idea.supportResistanceQuality,
    bidAskSpreadPercent: idea.bidAskSpreadPercent,
    optionVolume: idea.optionVolume,
    openInterest: idea.openInterest,
    daysToExpiration: idea.daysToExpiration,
    impliedVolatilityRank: idea.impliedVolatilityRank,
    premiumAsPercentOfPortfolio: idea.premiumAsPercentOfPortfolio,
    isChasing: idea.isChasing,
    optionLegs: idea.optionLegs?.map((leg) => ({
      symbol: leg.symbol,
      underlying: leg.underlying,
      optionType: leg.optionType === "put" ? "put" : "call",
      side: leg.side === "short" ? "short" : "long",
      quantity: leg.quantity,
      strike: leg.strike,
      expirationDate: leg.expirationDate,
      bid: leg.bid,
      ask: leg.ask,
      mid: leg.mid,
      spreadPercent: leg.spreadPercent,
      impliedVol: leg.impliedVol,
      ivRank: leg.ivRank,
      delta: leg.delta,
      gamma: leg.gamma,
      theta: leg.theta,
      vega: leg.vega,
      rho: leg.rho,
      openInterest: leg.openInterest,
      volume: leg.volume,
      dte: leg.dte
    })),
    ...overlay
  };
}

export async function ensureDefaultWatchlistSymbols(portfolioId: string) {
  for (const item of defaultWatchlistSymbols) {
    await prisma.watchlistItem.upsert({
      where: {
        portfolioId_symbol: {
          portfolioId,
          symbol: item.symbol
        }
      },
      create: {
        portfolioId,
        symbol: item.symbol,
        name: item.name,
        market: item.market,
        currency: item.currency,
        dataSource: "yahoo",
        notes: item.notes
      },
      update: {}
    });
  }
}

export async function saveTradeScoreSnapshot(tradeIdeaId: string, score: ScoreResult, snapshotDate = startOfLocalDay()) {
  const data = scoreData(score);

  await prisma.tradeScoreSnapshot.upsert({
    where: {
      tradeIdeaId_snapshotDate: {
        tradeIdeaId,
        snapshotDate
      }
    },
    create: {
      tradeIdeaId,
      snapshotDate,
      ...data
    },
    update: data
  });
}

async function refreshStaleWatchlist(portfolioId: string, force: boolean) {
  const items = await prisma.watchlistItem.findMany({
    where: {
      portfolioId,
      dataSource: "yahoo"
    }
  });
  let refreshed = 0;
  const errors: string[] = [];

  for (const item of items) {
    if (!force && item.lastUpdated && sameLocalDate(item.lastUpdated)) continue;

    try {
      const quote = await fetchYahooQuote(item.symbol);
      await prisma.watchlistItem.update({
        where: { id: item.id },
        data: {
          name: quote.name ?? item.name,
          market: quote.market,
          currency: quote.currency,
          currentPrice: quote.currentPrice,
          previousClose: quote.previousClose,
          dayChange: quote.dayChange,
          dayChangePercent: quote.dayChangePercent,
          lastUpdated: new Date()
        }
      });
      refreshed += 1;
    } catch (error) {
      errors.push(`${item.symbol} quote: ${error instanceof Error ? error.message : String(error)}`);
      await prisma.watchlistItem.update({
        where: { id: item.id },
        data: {
          lastUpdated: new Date(),
          notes: [item.notes, "Last quote refresh failed."].filter(Boolean).join(" ")
        }
      });
    }
  }

  return { refreshed, errors };
}

async function savePriceBars(portfolioId: string, symbol: string, chart: YahooChart) {
  for (const point of chart.history.slice(-260)) {
    const timestamp = new Date(point.timestamp * 1000);
    await prisma.priceBar.upsert({
      where: {
        portfolioId_symbol_timeframe_timestamp: {
          portfolioId,
          symbol: symbol.toUpperCase(),
          timeframe: "1d",
          timestamp
        }
      },
      create: {
        portfolioId,
        symbol: symbol.toUpperCase(),
        timeframe: "1d",
        timestamp,
        open: point.open,
        high: point.high,
        low: point.low,
        close: point.close,
        volume: point.volume ?? 0
      },
      update: {
        open: point.open,
        high: point.high,
        low: point.low,
        close: point.close,
        volume: point.volume ?? 0
      }
    });
  }
}

export async function refreshPortfolioDaily(portfolioId: string, options: { force?: boolean } = {}) {
  const force = options.force ?? false;
  await ensureDefaultWatchlistSymbols(portfolioId);

  const ideas = await prisma.tradeIdea.findMany({
    where: {
      portfolioId,
      status: {
        notIn: ["closed", "replaced"]
      }
    },
    orderBy: { createdAt: "asc" },
    include: {
      optionLegs: true
    }
  });
  const snapshotDate = startOfLocalDay();
  const todaySnapshotCount = await prisma.tradeScoreSnapshot.count({
    where: {
      snapshotDate,
      tradeIdea: {
        portfolioId
      }
    }
  });
  const watchlist = await prisma.watchlistItem.findMany({ where: { portfolioId } });
  const watchlistIsFresh = watchlist.length > 0 && watchlist.every((item) => item.lastUpdated && sameLocalDate(item.lastUpdated));

  if (!force && watchlistIsFresh && todaySnapshotCount >= ideas.length) {
    return {
      refreshedQuotes: 0,
      rescoredIdeas: 0,
      skipped: true,
      errors: [] as string[]
    };
  }

  const watchlistRefresh = await refreshStaleWatchlist(portfolioId, force);
  const errors = [...watchlistRefresh.errors];
  const historyCache = new Map<string, YahooChart | null>();
  const getChart = async (symbol: string) => {
    const key = symbol.toUpperCase();
    if (historyCache.has(key)) return historyCache.get(key);

    try {
      const chart = await fetchYahooChart(key, "6mo", "1d");
      await savePriceBars(portfolioId, key, chart);
      historyCache.set(key, chart);
      return chart;
    } catch (error) {
      errors.push(`${key} chart: ${error instanceof Error ? error.message : String(error)}`);
      historyCache.set(key, null);
      return null;
    }
  };

  const [spy, qqq, vix] = await Promise.all([getChart("SPY"), getChart("QQQ"), getChart("^VIX")]);
  const breadthSymbols = defaultWatchlistSymbols
    .map((item) => item.symbol)
    .filter((symbol) => !symbol.startsWith("^"))
    .slice(0, 14);
  const breadthCharts = await Promise.all(breadthSymbols.map(getChart));
  const marketContext = buildMarketContext({
    spy: spy?.history,
    qqq: qqq?.history,
    vix: vix?.history,
    breadthHistories: breadthCharts.flatMap((chart) => (chart ? [chart.history] : []))
  });
  const settings = await getRiskSettings(portfolioId);
  let rescoredIdeas = 0;

  for (const idea of ideas) {
    const chart = await getChart(idea.symbol);
    const technical = chart ? summarizeSymbolTechnical(chart.history) : null;
    const optionSnapshot = idea.optionContractSymbol && alpacaConfigured()
      ? await fetchAlpacaOptionSnapshot(idea.optionContractSymbol).catch(() => null)
      : null;
    const optionOverlay = optionSnapshot
      ? {
          optionContractSymbol: optionSnapshot.symbol,
          optionType: optionSnapshot.optionType,
          strikePrice: optionSnapshot.strikePrice,
          contractBid: optionSnapshot.bid,
          contractAsk: optionSnapshot.ask,
          contractMid: optionSnapshot.mid,
          contractDelta: optionSnapshot.delta,
          contractGamma: optionSnapshot.gamma,
          contractTheta: optionSnapshot.theta,
          contractVega: optionSnapshot.vega,
          contractRho: optionSnapshot.rho,
          contractImpliedVolatility: optionSnapshot.impliedVolatility,
          contractUnderlyingPrice: optionSnapshot.underlyingPrice,
          contractBreakEvenPrice: optionSnapshot.breakEvenPrice,
          contractSnapshotAt: new Date(),
          bidAskSpreadPercent: optionSnapshot.bidAskSpreadPercent ?? idea.bidAskSpreadPercent,
          optionVolume: optionSnapshot.volume ?? idea.optionVolume,
          openInterest: optionSnapshot.openInterest ?? idea.openInterest,
          impliedVolatilityRank:
            optionSnapshot.impliedVolatility !== null
              ? Math.min(Number((optionSnapshot.impliedVolatility * 100).toFixed(0)), 100)
              : idea.impliedVolatilityRank
        }
      : {};
    const payload = payloadFromIdea(idea, {
      spyTrend: marketContext.spyTrend,
      qqqTrend: marketContext.qqqTrend,
      vixCondition: marketContext.vixCondition,
      marketBreadth: marketContext.marketBreadth,
      macroRisk: marketContext.macroRisk,
      ...(technical
        ? {
            trend: technical.trend,
            priceVs20MA: technical.priceVs20MA,
            priceVs50MA: technical.priceVs50MA,
            rsiCondition: technical.rsiCondition,
            volumeCondition: technical.volumeCondition,
            supportResistanceQuality: technical.supportResistanceQuality
          }
        : {}),
      technicalSnapshot: chart ? technicalSnapshotFromBars(chart.history) : null,
      ...optionOverlay
    });
    const exposure = await getRiskExposure(portfolioId, idea.id);
    const score = evaluateTradeIdea(payload, settings, exposure);
    const reasons = [
      ...score.reasons,
      `Daily market refresh: ${marketContext.notes.join(", ")}.`,
      ...(technical
        ? [
            `${idea.symbol} technicals: ${technical.trend}, price ${technical.priceVs20MA} 20MA and ${technical.priceVs50MA} 50MA, RSI ${technical.rsi14 ?? "n/a"}.`
          ]
        : [`${idea.symbol} technicals could not be refreshed from Yahoo today.`]),
      ...(optionSnapshot
        ? [`${idea.optionContractSymbol} Alpaca option snapshot refreshed for bid/ask, IV, and Greeks.`]
        : [])
    ];
    const warnings = [
      ...score.warnings,
      ...(chart ? [] : ["Daily refresh could not fetch this symbol; manual technical inputs were kept."]),
      ...(idea.optionContractSymbol && !optionSnapshot
        ? ["Daily refresh could not fetch the Alpaca option snapshot; last contract data was kept."]
        : [])
    ];
    const data = scoreData(score, reasons, warnings);
    const evaluatedAt = new Date();

    await prisma.tradeIdea.update({
      where: { id: idea.id },
      data: {
        spyTrend: payload.spyTrend,
        qqqTrend: payload.qqqTrend,
        vixCondition: payload.vixCondition,
        marketBreadth: payload.marketBreadth,
        macroRisk: payload.macroRisk,
        trend: payload.trend,
        priceVs20MA: payload.priceVs20MA,
        priceVs50MA: payload.priceVs50MA,
        rsiCondition: payload.rsiCondition,
        volumeCondition: payload.volumeCondition,
        supportResistanceQuality: payload.supportResistanceQuality,
        optionContractSymbol: payload.optionContractSymbol,
        optionType: payload.optionType,
        strikePrice: payload.strikePrice,
        contractBid: payload.contractBid,
        contractAsk: payload.contractAsk,
        contractMid: payload.contractMid,
        contractDelta: payload.contractDelta,
        contractGamma: payload.contractGamma,
        contractTheta: payload.contractTheta,
        contractVega: payload.contractVega,
        contractRho: payload.contractRho,
        contractImpliedVolatility: payload.contractImpliedVolatility,
        contractUnderlyingPrice: payload.contractUnderlyingPrice,
        contractBreakEvenPrice: payload.contractBreakEvenPrice,
        contractSnapshotAt: payload.contractSnapshotAt,
        bidAskSpreadPercent: payload.bidAskSpreadPercent,
        optionVolume: payload.optionVolume,
        openInterest: payload.openInterest,
        impliedVolatilityRank: payload.impliedVolatilityRank,
        status: dailyStatus(idea.status, score.decision),
        lastEvaluatedAt: evaluatedAt,
        ...data,
        scores: {
          upsert: {
            create: data,
            update: data
          }
        },
        scoreSnapshots: {
          upsert: {
            where: {
              tradeIdeaId_snapshotDate: {
                tradeIdeaId: idea.id,
                snapshotDate
              }
            },
            create: {
              snapshotDate,
              ...data
            },
            update: data
          }
        }
      }
    });
    rescoredIdeas += 1;
  }

  return {
    refreshedQuotes: watchlistRefresh.refreshed,
    rescoredIdeas,
    skipped: false,
    errors: Array.from(new Set(errors))
  };
}
