import test from "node:test";
import assert from "node:assert/strict";
import type { RiskSettings } from "@prisma/client";
import { atr, calculateBWAP, rsi, sma, type PriceBarLike } from "../lib/indicators";
import { calculateMultiLegMetrics, strategyTemplate, type OptionLegInput } from "../lib/options/multileg";
import { simulateMonteCarlo } from "../lib/options/monteCarlo";
import { scoreOptionsQuality } from "../lib/risk/optionsQuality";
import { analyzeRedditSentiment } from "../lib/sentiment/reddit/analyzeRedditSentiment";
import { redditSentimentAdjustment } from "../lib/sentiment/reddit/sentimentScore";
import { evaluateTradeIdea, type RiskExposure, type TradeInput } from "../lib/risk";
import { computeCompositeMarketRegime } from "../lib/risk/market-regime";
import { evaluateEventRisk } from "../lib/risk/event-risk";
import { evaluateStrategyChecks } from "../lib/risk/strategy-checks";
import { estimateProbabilityOfProfit } from "../lib/options/pop";
import { applyYahooSentimentOverlay, classifyYahooSentiment } from "../lib/sentiment/yahoo";

const expirationDate = new Date("2026-07-17T00:00:00");

function leg(input: Partial<OptionLegInput> & Pick<OptionLegInput, "optionType" | "side" | "strike" | "mid">): OptionLegInput {
  return {
    underlying: "AAPL",
    quantity: 1,
    expirationDate,
    ...input
  };
}

test("bull call debit spread max loss and max profit use net debit", () => {
  const metrics = calculateMultiLegMetrics({
    legs: [
      leg({ optionType: "call", side: "long", strike: 100, mid: 5 }),
      leg({ optionType: "call", side: "short", strike: 110, mid: 2 })
    ],
    underlyingPrice: 102
  });

  assert.equal(metrics.netDebit, 300);
  assert.equal(metrics.maxLoss, 300);
  assert.equal(metrics.maxProfit, 700);
});

test("bear put debit spread max loss and max profit use net debit", () => {
  const metrics = calculateMultiLegMetrics({
    legs: [
      leg({ optionType: "put", side: "long", strike: 110, mid: 8 }),
      leg({ optionType: "put", side: "short", strike: 100, mid: 3 })
    ],
    underlyingPrice: 105
  });

  assert.equal(metrics.netDebit, 500);
  assert.equal(metrics.maxLoss, 500);
  assert.equal(metrics.maxProfit, 500);
});

test("single long option payoffs preserve unlimited call upside and put floor", () => {
  const call = calculateMultiLegMetrics({
    legs: [leg({ optionType: "call", side: "long", strike: 100, mid: 5 })],
    underlyingPrice: 100
  });
  const put = calculateMultiLegMetrics({
    legs: [leg({ optionType: "put", side: "long", strike: 100, mid: 5 })],
    underlyingPrice: 100
  });

  assert.equal(call.maxLoss, 500);
  assert.equal(call.maxProfit, null);
  assert.equal(put.maxLoss, 500);
  assert.equal(put.maxProfit, 9500);
});

test("protective put includes stock exposure in payoff", () => {
  const template = strategyTemplate("protective_put", {
    underlying: "AAPL",
    expirationDate,
    longStrike: 95,
    stockPrice: 100,
    stockQuantity: 100
  });
  const metrics = calculateMultiLegMetrics({
    legs: [{ ...template.optionLegs[0], mid: 3 }],
    stockLeg: template.stockLeg,
    underlyingPrice: 100
  });

  assert.equal(metrics.maxLoss, 800);
  assert.equal(metrics.maxProfit, null);
});

test("SMA, RSI, ATR, and BWAP indicators calculate expected values", () => {
  const bars: PriceBarLike[] = Array.from({ length: 20 }, (_, index) => ({
    open: 10 + index,
    high: 12 + index,
    low: 9 + index,
    close: 11 + index,
    volume: 100 + index
  }));

  assert.equal(sma(bars.map((bar) => bar.close), 5), 28);
  assert.equal(rsi(bars.map((bar) => bar.close), 14), 100);
  assert.ok((atr(bars, 14) ?? 0) >= 3);
  assert.equal(Number((calculateBWAP([{ high: 12, low: 8, close: 10, volume: 100 }]) ?? 0).toFixed(2)), 10);
});

test("continuous options quality emits hard stops for spread, DTE, and premium", () => {
  const result = scoreOptionsQuality({
    spreadPercent: 16,
    dte: 6,
    volume: 100,
    openInterest: 100,
    ivRank: 50,
    premium: 1200,
    portfolioValue: 100000,
    theta: -0.02,
    mid: 1
  });

  assert.equal(result.hardStops.length, 3);
  assert.ok(result.total < 60);
});

test("Monte Carlo scenario engine returns probability and EV", () => {
  const result = simulateMonteCarlo({
    underlyingPrice: 100,
    legs: [leg({ optionType: "call", side: "long", strike: 100, mid: 4 })],
    impliedVolatility: 0.3,
    dte: 45,
    simulations: 1000,
    seed: 42
  });

  assert.equal(result.simulations, 1000);
  assert.ok(result.probabilityOfProfit > 0);
  assert.ok(result.probabilityOfProfit < 1);
  assert.ok(Number.isFinite(result.expectedValue));
});

test("Reddit sentiment penalizes hype and leaves low signal neutral", () => {
  const hype = analyzeRedditSentiment({
    symbol: "NVDA",
    direction: "bullish",
    contexts: [
      {
        subreddit: "wallstreetbets",
        title: "NVDA moon rocket squeeze",
        body: "NVDA calls yolo moon rocket squeeze lambo diamond hands"
      }
    ]
  });
  const lowSignal = analyzeRedditSentiment({ symbol: "NVDA", contexts: [] });

  assert.equal(redditSentimentAdjustment(hype, "bullish"), -5);
  assert.equal(redditSentimentAdjustment(lowSignal, "bullish"), 0);
});

const settings = {
  id: "settings",
  portfolioId: "portfolio",
  totalPortfolioValue: 100000,
  optionsSleevePercent: 3,
  maxOptionsSleeveMXN: 3000,
  baseRiskPerTradePercent: 0.5,
  baseRiskPerTradeMXN: 500,
  maxMonthlyOptionsLossPercent: 1,
  maxMonthlyOptionsLossMXN: 1000,
  maxOpenOptionsRiskPercent: 2,
  maxOpenOptionsRiskMXN: 2000,
  redditSentimentEnabled: false,
  redditUseInFinalScore: false,
  redditSubreddits: "",
  redditMaxPostsPerSubreddit: 10,
  redditMaxCommentsPerPost: 0,
  redditRefreshIntervalHours: 12,
  enableYahooFinanceSentiment: false,
  sentimentLookbackDays: 14,
  sentimentMaxDocuments: 10,
  eventRiskEnabled: true,
  createdAt: new Date(),
  updatedAt: new Date()
} as RiskSettings;

const exposure: RiskExposure = {
  optionsRiskUsed: 0,
  monthlyLossUsed: 0,
  openOptionsRiskUsed: 0,
  concentrationMultiplier: 1
};

function baseTrade(overrides: Partial<TradeInput> = {}): TradeInput {
  return {
    symbol: "AAPL",
    direction: "bullish",
    strategy: "long_call",
    thesis: "Clean setup with defined catalyst, trend support, and option risk capped by plan.",
    catalyst: "Product event",
    invalidationLevel: 180,
    expirationDate,
    optionContractSymbol: "AAPL260717C00200000",
    optionType: "call",
    strikePrice: 200,
    shortStrikePrice: null,
    contractBid: 2.9,
    contractAsk: 3.1,
    contractMid: 3,
    contractDelta: 0.42,
    contractGamma: 0.03,
    contractTheta: -0.03,
    contractVega: 0.12,
    contractRho: 0.01,
    contractImpliedVolatility: 0.32,
    contractUnderlyingPrice: 198,
    contractBreakEvenPrice: 203,
    contractSnapshotAt: new Date(),
    premiumCost: 300,
    maxLoss: 300,
    expectedReward: 900,
    exitPlan: "Exit at 80% of target, stop at invalidation, or close before expiration if momentum fades.",
    spyTrend: "bullish",
    qqqTrend: "bullish",
    vixCondition: "normal",
    marketBreadth: "strong",
    macroRisk: "low",
    trend: "uptrend",
    priceVs20MA: "above",
    priceVs50MA: "above",
    rsiCondition: "neutral",
    volumeCondition: "strong",
    supportResistanceQuality: "good",
    bidAskSpreadPercent: 4,
    optionVolume: 600,
    openInterest: 1200,
    daysToExpiration: 50,
    impliedVolatilityRank: 35,
    premiumAsPercentOfPortfolio: 0.57,
    isChasing: false,
    ...overrides
  };
}

test("hard stops override otherwise strong score", () => {
  const result = evaluateTradeIdea(baseTrade({ thesis: "" }), settings, exposure);
  assert.equal(result.decision, "reject");
  assert.equal(result.suggestedRiskMXN, 0);
});

test("risk sizing remains capped by portfolio limits", () => {
  const result = evaluateTradeIdea(
    baseTrade(),
    settings,
    { ...exposure, optionsRiskUsed: 2830, openOptionsRiskUsed: 1890 }
  );

  assert.ok(result.suggestedRiskMXN <= 170);
});

test("composite market regime labels bullish and handles missing components", () => {
  const bullish = computeCompositeMarketRegime({
    spy: { price: 110, sma20: 105, sma50: 100, change20d: 4 },
    qqq: { price: 210, sma20: 205, sma50: 200, change20d: 3 },
    breadth: { ratio: 0.75 },
    vix: { value: 14, dailyChangePercent: 0 }
  });
  const missing = computeCompositeMarketRegime({
    spy: { trend: "bullish" },
    qqq: null,
    breadth: null,
    vix: null
  });

  assert.equal(bullish.label, "strong_bullish");
  assert.equal(missing.confidence, 0.3);
  assert.ok(missing.warnings.length > 0);
});

test("PoP hierarchy prefers Monte Carlo, then delta, then unavailable", () => {
  const legs = [
    leg({ optionType: "call", side: "long", strike: 100, mid: 5 }),
    leg({ optionType: "call", side: "short", strike: 110, mid: 2 })
  ];
  const monteCarlo = simulateMonteCarlo({
    underlyingPrice: 102,
    legs,
    impliedVolatility: 0.25,
    dte: 45,
    simulations: 1000,
    seed: 7
  });
  const mcPop = estimateProbabilityOfProfit({
    strategy: "bull_call_debit_spread",
    direction: "bullish",
    legs,
    spot: 102,
    dte: 45,
    iv: 0.25,
    monteCarloResult: monteCarlo
  });
  const deltaPop = estimateProbabilityOfProfit({
    strategy: "long_call",
    direction: "bullish",
    legs: [leg({ optionType: "call", side: "long", strike: 100, mid: 5, delta: 0.42 })],
    delta: 0.42
  });
  const unavailable = estimateProbabilityOfProfit({
    strategy: "long_call",
    direction: "bullish",
    legs: []
  });

  assert.equal(mcPop.source, "monte_carlo");
  assert.equal(deltaPop.source, "delta_proxy");
  assert.equal(unavailable.pop, null);
});

test("event risk detects earnings crossing and naked short hard stop", () => {
  const before = evaluateEventRisk({
    symbol: "AAPL",
    strategy: "long_call",
    direction: "bullish",
    expiration: new Date("2026-06-01"),
    createdAt: new Date("2026-05-31"),
    earningsEvents: [
      { type: "earnings", title: "AAPL earnings", date: new Date("2026-06-05"), source: "manual", confidence: "high" }
    ],
    macroEvents: []
  });
  const after = evaluateEventRisk({
    symbol: "AAPL",
    strategy: "short_call",
    direction: "bearish",
    expiration: new Date("2026-06-10"),
    createdAt: new Date("2026-05-31"),
    earningsEvents: [
      { type: "earnings", title: "AAPL earnings", date: new Date("2026-06-05"), source: "manual", confidence: "high" }
    ],
    macroEvents: [],
    hasNakedShortLeg: true
  });

  assert.equal(before.crossesEarnings, false);
  assert.equal(after.crossesEarnings, true);
  assert.ok(after.hardStops.length > 0);
});

test("strategy checks reject invalid bull call spread and accept valid structure", () => {
  const invalid = evaluateStrategyChecks({
    strategy: "bull_call_debit_spread",
    direction: "bullish",
    legs: [
      leg({ optionType: "call", side: "long", strike: 110, mid: 5 }),
      leg({ optionType: "call", side: "short", strike: 100, mid: 2 })
    ],
    spot: 105,
    dte: 45,
    maxLoss: 300,
    maxProfit: 700
  });
  const valid = evaluateStrategyChecks({
    strategy: "bull_call_debit_spread",
    direction: "bullish",
    legs: [
      leg({ optionType: "call", side: "long", strike: 100, mid: 5 }),
      leg({ optionType: "call", side: "short", strike: 110, mid: 2 })
    ],
    spot: 105,
    dte: 45,
    maxLoss: 300,
    maxProfit: 700
  });

  assert.ok(invalid.hardStops.some((item) => item.includes("short strike")));
  assert.equal(valid.hardStops.length, 0);
});

test("Yahoo sentiment adjusts directional score and flags legal concerns", () => {
  const sentiment = classifyYahooSentiment({
    ticker: "AAPL",
    tradeDirection: "bullish",
    documents: [
      {
        ticker: "AAPL",
        title: "AAPL faces SEC investigation and fraud lawsuit after earnings miss",
        publisher: "Yahoo Finance",
        summary: "Analysts downgrade AAPL as weak demand and regulatory risk pressure margins.",
        publishedAt: new Date()
      }
    ]
  });
  const overlay = applyYahooSentimentOverlay({
    baseScore: 80,
    direction: "bullish",
    sentiment
  });

  assert.ok(sentiment.sentimentScore < 0);
  assert.ok(overlay.scoreAdjustment <= 0);
  assert.equal(overlay.decisionCap, "watchlist");
});
