"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { readSheet } from "read-excel-file/node";
import { prisma } from "@/lib/db";
import { getRiskExposure, getRiskSettings } from "@/lib/data";
import { ensureDefaultWatchlistSymbols, refreshPortfolioDaily, saveTradeScoreSnapshot } from "@/lib/daily-refresh";
import { fetchYahooChart, fetchYahooQuote } from "@/lib/market-data";
import { technicalSnapshotFromBars } from "@/lib/indicators";
import { createPortfolioSnapshot } from "@/lib/performance";
import { refreshPortfolioMarketPrices } from "@/lib/portfolio-prices";
import { evaluateTradeIdea } from "@/lib/risk";
import type { OptionLegInput } from "@/lib/options/multileg";
import { summarizePositions } from "@/lib/calculations";
import { createAutoIdeaFromDiscoveryCandidate, ensureDailyAutoIdeas } from "@/lib/auto-ideas";
import type { DiscoveryCandidate } from "@/lib/discovery";
import {
  classifyYahooSentiment,
  collectYahooFinanceNews,
  scoreYahooNewsRelevance,
  type YahooFinanceNewsDocument
} from "@/lib/sentiment/yahoo";

function text(formData: FormData, key: string, fallback = "") {
  const value = formData.get(key);
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function number(formData: FormData, key: string, fallback = 0) {
  const value = formData.get(key);
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableNumber(formData: FormData, key: string) {
  const value = formData.get(key);
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateOrNull(formData: FormData, key: string) {
  const value = formData.get(key);
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function dateTimeOrNull(formData: FormData, key: string) {
  const value = formData.get(key);
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function checked(formData: FormData, key: string) {
  return formData.get(key) === "on";
}

function parseNumericCell(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "-") return null;
  const isNegative = trimmed.startsWith("-") || /^\(.+\)$/.test(trimmed);
  const cleaned = trimmed.replace(/[,$%\s()]/g, "").replace("-", "");
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return null;
  return isNegative ? -parsed : parsed;
}

function cleanSymbol(value: unknown) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function importedAssetType(symbol: string) {
  const etfs = new Set(["DIA", "IWM", "IVV", "QQQ", "SPY", "VTI", "VOO", "VT", "VEA", "VWO"]);
  if (symbol === "CASH") return "cash";
  return etfs.has(symbol) ? "etf" : "stock";
}

async function parseGbmRows(buffer: Buffer, sourceCurrency: string, usdMxnRate: number) {
  const rows = await readSheet(buffer);
  const multiplier = sourceCurrency === "USD" ? usdMxnRate : 1;

  return rows.flatMap((row) => {
    const originalSymbol = cleanSymbol(row[0]);
    if (!originalSymbol || originalSymbol === "EMISORA/FONDO") return [];
    if (originalSymbol.includes("MERCADO") || originalSymbol === "LIQUIDEZ") return [];

    const isCash = originalSymbol === "EFECTIVO" || originalSymbol === "CASH";
    const symbol = isCash ? "CASH" : originalSymbol;
    const quantity = isCash ? 1 : parseNumericCell(row[1]);
    const averageCost = isCash ? parseNumericCell(row[5]) : parseNumericCell(row[2]);
    const currentPrice = isCash ? parseNumericCell(row[5]) : parseNumericCell(row[3]);
    const marketValue = parseNumericCell(row[5]);
    const portfolioWeight = typeof row[10] === "string" ? row[10] : "";

    if (!quantity || averageCost === null || currentPrice === null) return [];

    return [
      {
        symbol,
        assetType: importedAssetType(symbol),
        market: isCash ? "MX" : "US",
        quantity,
        averageCost: Number((averageCost * multiplier).toFixed(4)),
        currentPrice: Number((currentPrice * multiplier).toFixed(4)),
        currency: "MXN",
        account: "GBM Import",
        notes: [
          `Imported from GBM Excel.`,
          `Source currency: ${sourceCurrency}.`,
          sourceCurrency === "USD" ? `USD/MXN used: ${usdMxnRate}.` : "",
          marketValue !== null ? `Source market value: ${marketValue}.` : "",
          portfolioWeight ? `GBM portfolio weight: ${portfolioWeight}.` : ""
        ]
          .filter(Boolean)
          .join(" ")
      }
    ];
  });
}

function defaultRiskSettings(totalPortfolioValue: number) {
  return {
    totalPortfolioValue,
    optionsSleevePercent: 3,
    maxOptionsSleeveMXN: totalPortfolioValue * 0.03,
    baseRiskPerTradePercent: 0.5,
    baseRiskPerTradeMXN: totalPortfolioValue * 0.005,
    maxMonthlyOptionsLossPercent: 1,
    maxMonthlyOptionsLossMXN: totalPortfolioValue * 0.01,
    maxOpenOptionsRiskPercent: 2,
    maxOpenOptionsRiskMXN: totalPortfolioValue * 0.02,
    redditSentimentEnabled: false,
    redditUseInFinalScore: false,
    redditSubreddits: "stocks,investing,options,wallstreetbets,ValueInvesting,SecurityAnalysis,StockMarket",
    redditMaxPostsPerSubreddit: 10,
    redditMaxCommentsPerPost: 0,
    redditRefreshIntervalHours: 12,
    enableYahooFinanceSentiment: true,
    sentimentLookbackDays: 14,
    sentimentMaxDocuments: 10,
    eventRiskEnabled: true
  };
}

function revalidateAll() {
  [
    "/",
    "/discover",
    "/portfolio",
    "/watchlist",
    "/options-chain",
    "/trade-ideas",
    "/risk-model",
    "/model-guide",
    "/journal",
    "/settings"
  ].forEach((path) => revalidatePath(path));
}

async function saveCurrentPortfolioSnapshot(portfolioId: string, source: string) {
  const [settings, positions] = await Promise.all([
    getRiskSettings(portfolioId),
    prisma.position.findMany({
      where: { portfolioId }
    })
  ]);
  const summary = summarizePositions(positions, settings);

  await createPortfolioSnapshot({
    portfolioId,
    totalValue: summary.totalValue,
    cashValue: summary.cash,
    stockValue: summary.stocks,
    optionValue: summary.options,
    source
  });
}

export async function recordPortfolioSnapshot(formData: FormData) {
  const portfolioId = text(formData, "portfolioId");
  await saveCurrentPortfolioSnapshot(portfolioId, text(formData, "source", "manual"));
  revalidateAll();
}

export async function refreshPortfolioPricesAndSnapshot(formData: FormData) {
  const portfolioId = text(formData, "portfolioId");
  await refreshPortfolioMarketPrices(portfolioId, { force: true });
  revalidateAll();
}

export async function createPortfolio(formData: FormData) {
  const totalPortfolioValue = number(formData, "totalPortfolioValue", 100000);

  const portfolio = await prisma.portfolio.create({
    data: {
      name: text(formData, "name", "New Portfolio"),
      institution: text(formData, "institution") || null,
      baseCurrency: text(formData, "baseCurrency", "MXN"),
      notes: text(formData, "notes") || null,
      riskSettings: {
        create: defaultRiskSettings(totalPortfolioValue)
      }
    }
  });
  await ensureDefaultWatchlistSymbols(portfolio.id);
  revalidateAll();
}

export async function importGbmPortfolioExcel(formData: FormData) {
  const portfolioId = text(formData, "portfolioId");
  const file = formData.get("gbmFile");
  const sourceCurrency = text(formData, "sourceCurrency", "USD");
  const usdMxnRate = number(formData, "usdMxnRate", 17.25);
  const replaceExisting = checked(formData, "replaceExisting");

  if (!(file instanceof File) || file.size === 0) return;

  const buffer = Buffer.from(await file.arrayBuffer());
  const positions = await parseGbmRows(buffer, sourceCurrency, usdMxnRate);

  if (!positions.length) {
    redirect(`/portfolio?portfolio=${encodeURIComponent(portfolioId)}&imported=0`);
  }

  if (replaceExisting) {
    await prisma.position.deleteMany({
      where: { portfolioId }
    });
    await prisma.position.createMany({
      data: positions.map((position) => ({
        portfolioId,
        ...position
      }))
    });
  } else {
    const existing = await prisma.position.findMany({
      where: { portfolioId }
    });
    const existingBySymbol = new Map(existing.map((position) => [position.symbol.toUpperCase(), position]));

    for (const position of positions) {
      const match = existingBySymbol.get(position.symbol.toUpperCase());
      if (match) {
        await prisma.position.update({
          where: { id: match.id },
          data: position
        });
      } else {
        await prisma.position.create({
          data: {
            portfolioId,
            ...position
          }
        });
      }
    }
  }

  await saveCurrentPortfolioSnapshot(portfolioId, "gbm_import");
  revalidateAll();
  redirect(`/portfolio?portfolio=${encodeURIComponent(portfolioId)}&imported=${positions.length}`);
}

export async function updatePortfolio(formData: FormData) {
  await prisma.portfolio.update({
    where: { id: text(formData, "id") },
    data: {
      name: text(formData, "name", "Portfolio"),
      institution: text(formData, "institution") || null,
      baseCurrency: text(formData, "baseCurrency", "MXN"),
      notes: text(formData, "notes") || null
    }
  });
  revalidateAll();
}

export async function deletePortfolio(formData: FormData) {
  const count = await prisma.portfolio.count();
  if (count <= 1) return;

  await prisma.portfolio.delete({
    where: { id: text(formData, "id") }
  });
  revalidateAll();
}

export async function createWatchlistItem(formData: FormData) {
  const portfolioId = text(formData, "portfolioId");
  const symbol = text(formData, "symbol").toUpperCase();

  await prisma.watchlistItem.upsert({
    where: {
      portfolioId_symbol: {
        portfolioId,
        symbol
      }
    },
    create: {
      portfolioId,
      symbol,
      name: text(formData, "name") || null,
      market: text(formData, "market", "US"),
      currency: text(formData, "currency", "USD"),
      dataSource: text(formData, "dataSource", "yahoo"),
      notes: text(formData, "notes") || null
    },
    update: {
      name: text(formData, "name") || null,
      market: text(formData, "market", "US"),
      currency: text(formData, "currency", "USD"),
      dataSource: text(formData, "dataSource", "yahoo"),
      notes: text(formData, "notes") || null
    }
  });
  revalidateAll();
}

export async function updateWatchlistItem(formData: FormData) {
  await prisma.watchlistItem.update({
    where: { id: text(formData, "id") },
    data: {
      symbol: text(formData, "symbol").toUpperCase(),
      name: text(formData, "name") || null,
      market: text(formData, "market", "US"),
      currency: text(formData, "currency", "USD"),
      dataSource: text(formData, "dataSource", "yahoo"),
      currentPrice: nullableNumber(formData, "currentPrice"),
      previousClose: nullableNumber(formData, "previousClose"),
      dayChange: nullableNumber(formData, "dayChange"),
      dayChangePercent: nullableNumber(formData, "dayChangePercent"),
      notes: text(formData, "notes") || null,
      lastUpdated: new Date()
    }
  });
  revalidateAll();
}

export async function deleteWatchlistItem(formData: FormData) {
  await prisma.watchlistItem.delete({
    where: { id: text(formData, "id") }
  });
  revalidateAll();
}

export async function refreshWatchlistItem(formData: FormData) {
  const id = text(formData, "id");
  const symbol = text(formData, "symbol").toUpperCase();
  const quote = await fetchYahooQuote(symbol);

  await prisma.watchlistItem.update({
    where: { id },
    data: {
      name: quote.name,
      market: quote.market,
      currency: quote.currency,
      currentPrice: quote.currentPrice,
      previousClose: quote.previousClose,
      dayChange: quote.dayChange,
      dayChangePercent: quote.dayChangePercent,
      lastUpdated: new Date(),
      dataSource: "yahoo"
    }
  });
  revalidateAll();
}

export async function refreshPortfolioWatchlist(formData: FormData) {
  const portfolioId = text(formData, "portfolioId");
  await ensureDefaultWatchlistSymbols(portfolioId);
  const items = await prisma.watchlistItem.findMany({
    where: {
      portfolioId,
      dataSource: "yahoo"
    }
  });

  for (const item of items) {
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
    } catch {
      await prisma.watchlistItem.update({
        where: { id: item.id },
        data: {
          lastUpdated: new Date(),
          notes: [item.notes, "Last quote refresh failed."].filter(Boolean).join(" ")
        }
      });
    }
  }

  revalidateAll();
}

export async function refreshDailyModel(formData: FormData) {
  const portfolioId = text(formData, "portfolioId");
  await refreshPortfolioDaily(portfolioId, { force: true });
  revalidateAll();
}

export async function generateDailyIdeas(formData: FormData) {
  const portfolioId = text(formData, "portfolioId");
  const run = await prisma.strategyScanRun.create({
    data: {
      portfolioId,
      universe: "core-liquid-universe",
      mode: "daily",
      source: "riskgate-ui",
      status: "running"
    }
  });

  try {
    const ideas = await ensureDailyAutoIdeas(portfolioId, 5, true);
    const errors = Array.from(new Set(ideas.errors));

    await prisma.strategyScanRun.update({
      where: { id: run.id },
      data: {
        status: errors.length ? "partial" : "success",
        symbolsScanned: ideas.symbolsScanned,
        candidatesFound: ideas.candidatesFound,
        ideasInserted: ideas.created,
        ideasUpdated: ideas.updated,
        notes: JSON.stringify({
          trigger: "trade-ideas-ui",
          sourceStatus: ideas.sourceStatus,
          errors
        }),
        error: errors.length ? errors.join(" | ").slice(0, 4000) : null,
        completedAt: new Date()
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);

    await prisma.strategyScanRun
      .update({
        where: { id: run.id },
        data: {
          status: "failed",
          error: message.slice(0, 4000),
          completedAt: new Date()
        }
      })
      .catch(() => undefined);

    throw error;
  }

  revalidateAll();
}

function discoveryList(formData: FormData, key: string, fallback: string[] = []) {
  const value = text(formData, key);
  return value
    ? value
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean)
    : fallback;
}

function discoveryBias(formData: FormData) {
  const value = text(formData, "bias", "mixed");
  return value === "bullish" || value === "bearish" ? value : "mixed";
}

function discoveryCandidateFromForm(formData: FormData): DiscoveryCandidate {
  const symbol = text(formData, "symbol").toUpperCase();

  return {
    symbol,
    name: text(formData, "name") || null,
    price: nullableNumber(formData, "price"),
    dayChangePercent: nullableNumber(formData, "dayChangePercent"),
    volume: nullableNumber(formData, "volume"),
    averageVolume: nullableNumber(formData, "averageVolume"),
    volumeRatio: nullableNumber(formData, "volumeRatio"),
    marketCap: nullableNumber(formData, "marketCap"),
    currency: text(formData, "currency", "USD"),
    market: text(formData, "market", "US"),
    sources: discoveryList(formData, "sources", ["Discover"]),
    redditMentions: Math.max(0, Math.trunc(number(formData, "redditMentions"))),
    redditUpvotes: Math.max(0, Math.trunc(number(formData, "redditUpvotes"))),
    redditComments: Math.max(0, Math.trunc(number(formData, "redditComments"))),
    redditSentiment: number(formData, "redditSentiment"),
    relativeStrengthScore: number(formData, "relativeStrengthScore", 50),
    unusualVolumeScore: number(formData, "unusualVolumeScore", 50),
    socialScore: number(formData, "socialScore", 0),
    technicalSetupScore: number(formData, "technicalSetupScore", 50),
    volatilityScore: number(formData, "volatilityScore", 50),
    realizedVolatility20: nullableNumber(formData, "realizedVolatility20"),
    extensionPenalty: number(formData, "extensionPenalty", 1),
    catalystScore: number(formData, "catalystScore", 50),
    optionsLiquidityScore: number(formData, "optionsLiquidityScore", 50),
    riskFilterScore: number(formData, "riskFilterScore", 50),
    discoveryScore: number(formData, "discoveryScore", 0),
    bias: discoveryBias(formData),
    directionConfidence: number(formData, "directionConfidence", 0),
    dataCoverage: number(formData, "dataCoverage", 0),
    hasHistoricalData: text(formData, "hasHistoricalData") === "true",
    optionsLikely: text(formData, "optionsLikely") === "true",
    reasons: discoveryList(formData, "reasons", [`Selected from Discover for ${symbol}.`]),
    warnings: discoveryList(formData, "warnings")
  };
}

export async function createTradeIdeaFromDiscovery(formData: FormData) {
  const portfolioId = text(formData, "portfolioId");
  const candidate = discoveryCandidateFromForm(formData);
  await createAutoIdeaFromDiscoveryCandidate(portfolioId, candidate);
  revalidateAll();
  redirect(`/trade-ideas?portfolio=${encodeURIComponent(portfolioId)}`);
}

function normalizeTradeStatus(decision: string, requestedStatus: string) {
  if (requestedStatus === "draft") return "draft";
  if (requestedStatus === "entered" && decision.startsWith("approved")) return "entered";
  if (decision === "reject") return "rejected";
  if (decision === "watchlist") return "watchlist";
  return "approved";
}

function tradePayload(formData: FormData) {
  return {
    symbol: text(formData, "symbol").toUpperCase(),
    direction: text(formData, "direction", "bullish"),
    strategy: text(formData, "strategy", "long_call"),
    thesis: text(formData, "thesis"),
    catalyst: text(formData, "catalyst") || null,
    invalidationLevel: nullableNumber(formData, "invalidationLevel"),
    targetPrice: nullableNumber(formData, "targetPrice"),
    expirationDate: dateOrNull(formData, "expirationDate"),
    optionContractSymbol: text(formData, "optionContractSymbol") || null,
    optionType: text(formData, "optionType") || null,
    strikePrice: nullableNumber(formData, "strikePrice"),
    shortStrikePrice: nullableNumber(formData, "shortStrikePrice"),
    contractBid: nullableNumber(formData, "contractBid"),
    contractAsk: nullableNumber(formData, "contractAsk"),
    contractMid: nullableNumber(formData, "contractMid"),
    contractDelta: nullableNumber(formData, "contractDelta"),
    contractGamma: nullableNumber(formData, "contractGamma"),
    contractTheta: nullableNumber(formData, "contractTheta"),
    contractVega: nullableNumber(formData, "contractVega"),
    contractRho: nullableNumber(formData, "contractRho"),
    contractImpliedVolatility: nullableNumber(formData, "contractImpliedVolatility"),
    contractUnderlyingPrice: nullableNumber(formData, "contractUnderlyingPrice"),
    contractBreakEvenPrice: nullableNumber(formData, "contractBreakEvenPrice"),
    contractSnapshotAt: dateTimeOrNull(formData, "contractSnapshotAt"),
    premiumCost: nullableNumber(formData, "premiumCost"),
    maxLoss: number(formData, "maxLoss"),
    expectedReward: nullableNumber(formData, "expectedReward"),
    exitPlan: text(formData, "exitPlan") || null,
    spyTrend: text(formData, "spyTrend", "neutral"),
    qqqTrend: text(formData, "qqqTrend", "neutral"),
    vixCondition: text(formData, "vixCondition", "normal"),
    marketBreadth: text(formData, "marketBreadth", "neutral"),
    macroRisk: text(formData, "macroRisk", "medium"),
    trend: text(formData, "trend", "sideways"),
    priceVs20MA: text(formData, "priceVs20MA", "above"),
    priceVs50MA: text(formData, "priceVs50MA", "above"),
    rsiCondition: text(formData, "rsiCondition", "neutral"),
    volumeCondition: text(formData, "volumeCondition", "normal"),
    supportResistanceQuality: text(formData, "supportResistanceQuality", "average"),
    bidAskSpreadPercent: number(formData, "bidAskSpreadPercent", 8),
    optionVolume: number(formData, "optionVolume", 100),
    openInterest: number(formData, "openInterest", 500),
    daysToExpiration: number(formData, "daysToExpiration", 30),
    impliedVolatilityRank: nullableNumber(formData, "impliedVolatilityRank"),
    premiumAsPercentOfPortfolio: number(formData, "premiumAsPercentOfPortfolio", 0.5),
    isChasing: checked(formData, "isChasing")
  };
}

function parseOptionLegs(formData: FormData, fallback: { symbol: string; expirationDate: Date | null }): OptionLegInput[] {
  return Array.from({ length: 4 }, (_, index) => {
    const prefix = `leg${index}`;
    const enabled = checked(formData, `${prefix}Enabled`);
    const strike = nullableNumber(formData, `${prefix}Strike`);
    const expirationDate = dateOrNull(formData, `${prefix}ExpirationDate`) ?? fallback.expirationDate;
    const symbol = text(formData, `${prefix}Symbol`) || null;

    if (!enabled && !symbol && !strike) return null;
    if (!strike || !expirationDate) return null;

    const bid = nullableNumber(formData, `${prefix}Bid`);
    const ask = nullableNumber(formData, `${prefix}Ask`);
    const mid = nullableNumber(formData, `${prefix}Mid`);
    const optionType: OptionLegInput["optionType"] =
      text(formData, `${prefix}OptionType`, "call") === "put" ? "put" : "call";
    const side: OptionLegInput["side"] = text(formData, `${prefix}Side`, "long") === "short" ? "short" : "long";
    const spreadPercent =
      nullableNumber(formData, `${prefix}SpreadPercent`) ??
      (bid !== null && ask !== null && mid !== null && mid > 0 ? ((ask - bid) / mid) * 100 : null);

    return {
      symbol,
      underlying: text(formData, `${prefix}Underlying`, fallback.symbol).toUpperCase(),
      optionType,
      side,
      quantity: Math.max(Math.trunc(number(formData, `${prefix}Quantity`, 1)), 1),
      expirationDate,
      strike,
      bid,
      ask,
      mid,
      spreadPercent,
      impliedVol: nullableNumber(formData, `${prefix}ImpliedVol`),
      ivRank: nullableNumber(formData, `${prefix}IvRank`),
      delta: nullableNumber(formData, `${prefix}Delta`),
      gamma: nullableNumber(formData, `${prefix}Gamma`),
      theta: nullableNumber(formData, `${prefix}Theta`),
      vega: nullableNumber(formData, `${prefix}Vega`),
      rho: nullableNumber(formData, `${prefix}Rho`),
      openInterest:
        nullableNumber(formData, `${prefix}OpenInterest`) === null
          ? null
          : Math.trunc(nullableNumber(formData, `${prefix}OpenInterest`)!),
      volume:
        nullableNumber(formData, `${prefix}Volume`) === null
          ? null
          : Math.trunc(nullableNumber(formData, `${prefix}Volume`)!),
      dte: nullableNumber(formData, `${prefix}Dte`) === null ? null : Math.trunc(nullableNumber(formData, `${prefix}Dte`)!),
    };
  }).filter((leg): leg is NonNullable<typeof leg> => leg !== null);
}

async function calculatedTechnicalSnapshot(symbol: string) {
  try {
    const chart = await fetchYahooChart(symbol, "1y", "1d");
    return technicalSnapshotFromBars(chart.history);
  } catch {
    return null;
  }
}

async function portfolioHasUnderlying(portfolioId: string, symbol: string) {
  const position = await prisma.position.findFirst({
    where: {
      portfolioId,
      symbol: symbol.toUpperCase(),
      assetType: {
        in: ["stock", "etf"]
      },
      quantity: {
        gt: 0
      }
    }
  });

  return Boolean(position);
}

function yahooDocumentFromDb(document: {
  id: string;
  ticker: string;
  title: string;
  publisher: string | null;
  summary: string | null;
  url: string | null;
  publishedAt: Date | null;
  collectedAt: Date;
}): YahooFinanceNewsDocument {
  return {
    id: document.id,
    ticker: document.ticker,
    title: document.title,
    publisher: document.publisher,
    summary: document.summary,
    url: document.url,
    publishedAt: document.publishedAt,
    collectedAt: document.collectedAt
  };
}

async function storeYahooDocuments(
  portfolioId: string,
  ticker: string,
  documents: YahooFinanceNewsDocument[],
  catalyst?: string | null
) {
  for (const document of documents) {
    const existing = await prisma.yahooFinanceDocument.findFirst({
      where: {
        portfolioId,
        ticker,
        title: document.title,
        url: document.url ?? null
      }
    });
    const relevanceScore = scoreYahooNewsRelevance({
      ticker,
      title: document.title,
      summary: document.summary,
      catalyst,
      publisher: document.publisher,
      publishedAt: document.publishedAt
    });
    const data = {
      portfolioId,
      ticker,
      title: document.title,
      publisher: document.publisher ?? null,
      summary: document.summary ?? null,
      url: document.url ?? null,
      publishedAt: document.publishedAt ?? null,
      collectedAt: document.collectedAt ?? new Date(),
      relevanceScore
    };

    if (existing) {
      await prisma.yahooFinanceDocument.update({
        where: { id: existing.id },
        data
      });
    } else {
      await prisma.yahooFinanceDocument.create({ data });
    }
  }
}

async function cachedYahooSentiment(
  portfolioId: string,
  settings: Awaited<ReturnType<typeof getRiskSettings>>,
  input: {
  symbol: string;
  direction: string;
  thesis: string;
  catalyst?: string | null;
}
) {
  if (!settings.enableYahooFinanceSentiment) return null;

  const ticker = input.symbol.toUpperCase();
  const since = new Date(Date.now() - settings.sentimentLookbackDays * 24 * 60 * 60 * 1000);
  let documents = await prisma.yahooFinanceDocument.findMany({
    where: {
      portfolioId,
      ticker,
      OR: [{ publishedAt: null }, { publishedAt: { gte: since } }]
    },
    orderBy: [{ publishedAt: "desc" }, { collectedAt: "desc" }],
    take: settings.sentimentMaxDocuments
  });

  if (!documents.length) {
    const collected = await collectYahooFinanceNews({
      ticker,
      maxDocuments: settings.sentimentMaxDocuments,
      lookbackDays: settings.sentimentLookbackDays
    });
    await storeYahooDocuments(portfolioId, ticker, collected, input.catalyst);
    documents = await prisma.yahooFinanceDocument.findMany({
      where: {
        portfolioId,
        ticker,
        OR: [{ publishedAt: null }, { publishedAt: { gte: since } }]
      },
      orderBy: [{ publishedAt: "desc" }, { collectedAt: "desc" }],
      take: settings.sentimentMaxDocuments
    });
  }

  return classifyYahooSentiment({
    ticker,
    tradeDirection: input.direction,
    catalyst: input.catalyst,
    documents: documents.map(yahooDocumentFromDb)
  });
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

export async function createPosition(formData: FormData) {
  const portfolioId = text(formData, "portfolioId");

  await prisma.position.create({
    data: {
      portfolioId,
      symbol: text(formData, "symbol").toUpperCase(),
      assetType: text(formData, "assetType", "stock"),
      market: text(formData, "market", "US"),
      quantity: number(formData, "quantity"),
      averageCost: number(formData, "averageCost"),
      currentPrice: number(formData, "currentPrice"),
      currency: text(formData, "currency", "MXN"),
      account: text(formData, "account", "Manual"),
      notes: text(formData, "notes") || null
    }
  });
  await saveCurrentPortfolioSnapshot(portfolioId, "position_create");
  revalidateAll();
}

export async function updatePosition(formData: FormData) {
  const id = text(formData, "id");
  const portfolioId = text(formData, "portfolioId");
  await prisma.position.update({
    where: { id },
    data: {
      portfolioId,
      symbol: text(formData, "symbol").toUpperCase(),
      assetType: text(formData, "assetType", "stock"),
      market: text(formData, "market", "US"),
      quantity: number(formData, "quantity"),
      averageCost: number(formData, "averageCost"),
      currentPrice: number(formData, "currentPrice"),
      currency: text(formData, "currency", "MXN"),
      account: text(formData, "account", "Manual"),
      notes: text(formData, "notes") || null
    }
  });
  await saveCurrentPortfolioSnapshot(portfolioId, "position_update");
  revalidateAll();
}

export async function deletePosition(formData: FormData) {
  const id = text(formData, "id");
  const position = await prisma.position.findUnique({ where: { id } });
  await prisma.position.delete({ where: { id } });
  if (position) await saveCurrentPortfolioSnapshot(position.portfolioId, "position_delete");
  revalidateAll();
}

export async function createTradeIdea(formData: FormData) {
  const portfolioId = text(formData, "portfolioId");
  const settings = await getRiskSettings(portfolioId);
  const exposure = await getRiskExposure(portfolioId);
  const payload = tradePayload(formData);
  const optionLegs = parseOptionLegs(formData, {
    symbol: payload.symbol,
    expirationDate: payload.expirationDate
  });
  const [technicalSnapshot, yahooSentiment, hasUnderlying] = await Promise.all([
    calculatedTechnicalSnapshot(payload.symbol),
    cachedYahooSentiment(portfolioId, settings, payload),
    portfolioHasUnderlying(portfolioId, payload.symbol)
  ]);
  const scoreInput = {
    ...payload,
    optionLegs,
    technicalSnapshot,
    yahooSentiment,
    portfolioHasUnderlying: hasUnderlying
  };
  const score = evaluateTradeIdea(scoreInput, settings, exposure);
  const status = normalizeTradeStatus(score.decision, text(formData, "status", "watchlist"));
  const evaluatedAt = new Date();

  const created = await prisma.tradeIdea.create({
    data: {
      portfolioId,
      ...payload,
      optionLegs: optionLegs.length
        ? {
            create: optionLegCreateData(optionLegs)
          }
        : undefined,
      status,
      lastEvaluatedAt: evaluatedAt,
      marketRegimeScore: score.marketRegimeScore,
      technicalScore: score.technicalScore,
      optionsQualityScore: score.optionsQualityScore,
      tradeQualityScore: score.tradeQualityScore,
      totalScore: score.totalScore,
      decision: score.decision,
      suggestedRiskMXN: score.suggestedRiskMXN,
      reasons: score.reasons.join("\n"),
      warnings: score.warnings.join("\n"),
      scores: {
        create: {
          marketRegimeScore: score.marketRegimeScore,
          technicalScore: score.technicalScore,
          optionsQualityScore: score.optionsQualityScore,
          tradeQualityScore: score.tradeQualityScore,
          totalScore: score.totalScore,
          decision: score.decision,
          suggestedRiskMXN: score.suggestedRiskMXN,
          reasons: score.reasons.join("\n"),
          warnings: score.warnings.join("\n")
        }
      }
    }
  });
  await saveTradeScoreSnapshot(created.id, score);
  revalidateAll();
}

export async function updateTradeIdea(formData: FormData) {
  const id = text(formData, "id");
  const portfolioId = text(formData, "portfolioId");
  const settings = await getRiskSettings(portfolioId);
  const exposure = await getRiskExposure(portfolioId, id);
  const payload = tradePayload(formData);
  const optionLegs = parseOptionLegs(formData, {
    symbol: payload.symbol,
    expirationDate: payload.expirationDate
  });
  const [technicalSnapshot, yahooSentiment, hasUnderlying] = await Promise.all([
    calculatedTechnicalSnapshot(payload.symbol),
    cachedYahooSentiment(portfolioId, settings, payload),
    portfolioHasUnderlying(portfolioId, payload.symbol)
  ]);
  const scoreInput = {
    ...payload,
    optionLegs,
    technicalSnapshot,
    yahooSentiment,
    portfolioHasUnderlying: hasUnderlying
  };
  const score = evaluateTradeIdea(scoreInput, settings, exposure);
  const status = normalizeTradeStatus(score.decision, text(formData, "status", "watchlist"));
  const evaluatedAt = new Date();
  const scoreData = {
    marketRegimeScore: score.marketRegimeScore,
    technicalScore: score.technicalScore,
    optionsQualityScore: score.optionsQualityScore,
    tradeQualityScore: score.tradeQualityScore,
    totalScore: score.totalScore,
    decision: score.decision,
    suggestedRiskMXN: score.suggestedRiskMXN,
    reasons: score.reasons.join("\n"),
    warnings: score.warnings.join("\n")
  };

  await prisma.tradeIdea.update({
    where: { id },
    data: {
      portfolioId,
      ...payload,
      status,
      lastEvaluatedAt: evaluatedAt,
      optionLegs: {
        deleteMany: {},
        ...(optionLegs.length
          ? {
              create: optionLegCreateData(optionLegs)
            }
          : {})
      },
      ...scoreData,
      scores: {
        upsert: {
          create: scoreData,
          update: scoreData
        }
      }
    }
  });
  await saveTradeScoreSnapshot(id, score);
  revalidateAll();
}

export async function deleteTradeIdea(formData: FormData) {
  await prisma.tradeIdea.delete({ where: { id: text(formData, "id") } });
  revalidateAll();
}

export async function refreshYahooFinanceSentimentForIdea(formData: FormData) {
  const tradeIdeaId = text(formData, "tradeIdeaId");
  const idea = await prisma.tradeIdea.findUnique({
    where: { id: tradeIdeaId },
    include: {
      portfolio: {
        include: {
          riskSettings: true
        }
      }
    }
  });

  if (!idea) return;
  const settings = idea.portfolio.riskSettings ?? (await getRiskSettings(idea.portfolioId));
  if (!settings.enableYahooFinanceSentiment) {
    revalidateAll();
    return;
  }

  const ticker = idea.symbol.toUpperCase();
  const documents = await collectYahooFinanceNews({
    ticker,
    maxDocuments: settings.sentimentMaxDocuments,
    lookbackDays: settings.sentimentLookbackDays
  }).catch(() => []);
  await storeYahooDocuments(idea.portfolioId, ticker, documents, idea.catalyst);

  revalidateAll();
}

export async function createJournalEntry(formData: FormData) {
  await prisma.tradeJournal.create({
    data: {
      tradeIdeaId: text(formData, "tradeIdeaId"),
      entryDate: dateOrNull(formData, "entryDate") ?? new Date(),
      exitDate: dateOrNull(formData, "exitDate"),
      entryPrice: number(formData, "entryPrice"),
      exitPrice: nullableNumber(formData, "exitPrice"),
      realizedPnL: nullableNumber(formData, "realizedPnL"),
      result: text(formData, "result") || null,
      mistakeTags: text(formData, "mistakeTags") || null,
      notes: text(formData, "notes") || null
    }
  });
  revalidateAll();
}

export async function updateJournalEntry(formData: FormData) {
  await prisma.tradeJournal.update({
    where: { id: text(formData, "id") },
    data: {
      tradeIdeaId: text(formData, "tradeIdeaId"),
      entryDate: dateOrNull(formData, "entryDate") ?? new Date(),
      exitDate: dateOrNull(formData, "exitDate"),
      entryPrice: number(formData, "entryPrice"),
      exitPrice: nullableNumber(formData, "exitPrice"),
      realizedPnL: nullableNumber(formData, "realizedPnL"),
      result: text(formData, "result") || null,
      mistakeTags: text(formData, "mistakeTags") || null,
      notes: text(formData, "notes") || null
    }
  });
  revalidateAll();
}

export async function deleteJournalEntry(formData: FormData) {
  await prisma.tradeJournal.delete({ where: { id: text(formData, "id") } });
  revalidateAll();
}

export async function updateRiskSettings(formData: FormData) {
  const portfolioId = text(formData, "portfolioId");
  const settings = await getRiskSettings(portfolioId);
  const totalPortfolioValue = number(formData, "totalPortfolioValue", 100000);
  const optionsSleevePercent = number(formData, "optionsSleevePercent", 3);
  const baseRiskPerTradePercent = number(formData, "baseRiskPerTradePercent", 0.5);
  const maxMonthlyOptionsLossPercent = number(formData, "maxMonthlyOptionsLossPercent", 1);
  const maxOpenOptionsRiskPercent = number(formData, "maxOpenOptionsRiskPercent", 2);

  await prisma.riskSettings.update({
    where: { id: settings.id },
    data: {
      totalPortfolioValue,
      optionsSleevePercent,
      maxOptionsSleeveMXN: number(
        formData,
        "maxOptionsSleeveMXN",
        totalPortfolioValue * (optionsSleevePercent / 100)
      ),
      baseRiskPerTradePercent,
      baseRiskPerTradeMXN: number(
        formData,
        "baseRiskPerTradeMXN",
        totalPortfolioValue * (baseRiskPerTradePercent / 100)
      ),
      maxMonthlyOptionsLossPercent,
      maxMonthlyOptionsLossMXN: number(
        formData,
        "maxMonthlyOptionsLossMXN",
        totalPortfolioValue * (maxMonthlyOptionsLossPercent / 100)
      ),
      maxOpenOptionsRiskPercent,
      maxOpenOptionsRiskMXN: number(
        formData,
        "maxOpenOptionsRiskMXN",
        totalPortfolioValue * (maxOpenOptionsRiskPercent / 100)
      ),
      redditSentimentEnabled: checked(formData, "redditSentimentEnabled"),
      redditUseInFinalScore: checked(formData, "redditUseInFinalScore"),
      redditSubreddits: text(
        formData,
        "redditSubreddits",
        "stocks,investing,options,wallstreetbets,ValueInvesting,SecurityAnalysis,StockMarket"
      ),
      redditMaxPostsPerSubreddit: Math.max(Math.trunc(number(formData, "redditMaxPostsPerSubreddit", 10)), 1),
      redditMaxCommentsPerPost: Math.max(Math.trunc(number(formData, "redditMaxCommentsPerPost", 0)), 0),
      redditRefreshIntervalHours: Math.max(Math.trunc(number(formData, "redditRefreshIntervalHours", 12)), 1),
      enableYahooFinanceSentiment: checked(formData, "enableYahooFinanceSentiment"),
      sentimentLookbackDays: Math.max(Math.trunc(number(formData, "sentimentLookbackDays", 14)), 1),
      sentimentMaxDocuments: Math.max(Math.trunc(number(formData, "sentimentMaxDocuments", 10)), 1),
      eventRiskEnabled: checked(formData, "eventRiskEnabled")
    }
  });
  revalidateAll();
}
