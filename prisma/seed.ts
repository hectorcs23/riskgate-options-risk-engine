import { PrismaClient } from "@prisma/client";
import { defaultWatchlistSymbols } from "../lib/market-data";
import { evaluateTradeIdea } from "../lib/risk";

const prisma = new PrismaClient();

const emptyContractData = {
  optionContractSymbol: null,
  optionType: null,
  strikePrice: null,
  shortStrikePrice: null,
  contractBid: null,
  contractAsk: null,
  contractMid: null,
  contractDelta: null,
  contractGamma: null,
  contractTheta: null,
  contractVega: null,
  contractRho: null,
  contractImpliedVolatility: null,
  contractUnderlyingPrice: null,
  contractBreakEvenPrice: null,
  contractSnapshotAt: null
};

async function main() {
  await prisma.tradeJournal.deleteMany();
  await prisma.modelScore.deleteMany();
  await prisma.tradeIdea.deleteMany();
  await prisma.watchlistItem.deleteMany();
  await prisma.position.deleteMany();
  await prisma.riskSettings.deleteMany();
  await prisma.portfolio.deleteMany();

  const gbmPortfolio = await prisma.portfolio.create({
    data: {
      name: "GBM+ Main",
      institution: "GBM",
      baseCurrency: "MXN",
      notes: "Primary manual GBM+ account."
    }
  });
  const secondPortfolio = await prisma.portfolio.create({
    data: {
      name: "Options Sandbox",
      institution: "Manual",
      baseCurrency: "MXN",
      notes: "Second account for smaller options experiments."
    }
  });

  const settings = await prisma.riskSettings.create({
    data: {
      portfolioId: gbmPortfolio.id,
      totalPortfolioValue: 100000,
      optionsSleevePercent: 3,
      maxOptionsSleeveMXN: 3000,
      baseRiskPerTradePercent: 0.5,
      baseRiskPerTradeMXN: 500,
      maxMonthlyOptionsLossPercent: 1,
      maxMonthlyOptionsLossMXN: 1000,
      maxOpenOptionsRiskPercent: 2,
      maxOpenOptionsRiskMXN: 2000
    }
  });

  await prisma.riskSettings.create({
    data: {
      portfolioId: secondPortfolio.id,
      totalPortfolioValue: 18000,
      optionsSleevePercent: 3,
      maxOptionsSleeveMXN: 540,
      baseRiskPerTradePercent: 0.5,
      baseRiskPerTradeMXN: 90,
      maxMonthlyOptionsLossPercent: 1,
      maxMonthlyOptionsLossMXN: 180,
      maxOpenOptionsRiskPercent: 2,
      maxOpenOptionsRiskMXN: 360
    }
  });

  await prisma.position.createMany({
    data: [
      {
        portfolioId: gbmPortfolio.id,
        symbol: "CASH",
        assetType: "cash",
        market: "MX",
        quantity: 1,
        averageCost: 5000,
        currentPrice: 5000,
        currency: "MXN",
        account: "GBM",
        notes: "Manual cash balance."
      },
      {
        portfolioId: gbmPortfolio.id,
        symbol: "VOO",
        assetType: "etf",
        market: "US",
        quantity: 2,
        averageCost: 11300,
        currentPrice: 11850,
        currency: "MXN",
        account: "GBM",
        notes: "Sample long-term ETF position."
      },
      {
        portfolioId: gbmPortfolio.id,
        symbol: "AAPL",
        assetType: "stock",
        market: "US",
        quantity: 8,
        averageCost: 2380,
        currentPrice: 2510,
        currency: "MXN",
        account: "Manual",
        notes: "Sample stock position."
      },
      {
        portfolioId: secondPortfolio.id,
        symbol: "CASH",
        assetType: "cash",
        market: "MX",
        quantity: 1,
        averageCost: 8000,
        currentPrice: 8000,
        currency: "MXN",
        account: "Manual",
        notes: "Cash for the second account."
      },
      {
        portfolioId: secondPortfolio.id,
        symbol: "QQQ",
        assetType: "etf",
        market: "US",
        quantity: 1,
        averageCost: 10000,
        currentPrice: 10200,
        currency: "MXN",
        account: "Manual",
        notes: "Sample second-account ETF position."
      }
    ]
  });

  await prisma.watchlistItem.createMany({
    data: defaultWatchlistSymbols.flatMap((item) => [
      {
        portfolioId: gbmPortfolio.id,
        symbol: item.symbol,
        name: item.name,
        market: item.market,
        currency: item.currency,
        dataSource: "yahoo",
        notes: item.notes
      },
      {
        portfolioId: secondPortfolio.id,
        symbol: item.symbol,
        name: item.name,
        market: item.market,
        currency: item.currency,
        dataSource: "yahoo",
        notes: item.notes
      }
    ])
  });

  const exposure = {
    optionsRiskUsed: 0,
    monthlyLossUsed: 0,
    openOptionsRiskUsed: 0
  };

  const rejectedPayload = {
    symbol: "TSLA",
    direction: "bullish",
    strategy: "long_call",
    thesis: "Momentum entry after a fast move.",
    catalyst: null,
    invalidationLevel: null,
    ...emptyContractData,
    targetPrice: 240,
    expirationDate: new Date("2026-06-05T00:00:00"),
    premiumCost: 650,
    maxLoss: 650,
    expectedReward: 900,
    exitPlan: null,
    spyTrend: "neutral",
    qqqTrend: "neutral",
    vixCondition: "spiking",
    marketBreadth: "weak",
    macroRisk: "high",
    trend: "uptrend",
    priceVs20MA: "above",
    priceVs50MA: "above",
    rsiCondition: "overbought",
    volumeCondition: "weak",
    supportResistanceQuality: "poor",
    bidAskSpreadPercent: 18,
    optionVolume: 12,
    openInterest: 45,
    daysToExpiration: 5,
    impliedVolatilityRank: 84,
    premiumAsPercentOfPortfolio: 1.2,
    isChasing: true
  };
  const rejectedScore = evaluateTradeIdea(rejectedPayload, settings, exposure);

  await prisma.tradeIdea.create({
    data: {
      portfolioId: gbmPortfolio.id,
      ...rejectedPayload,
      status: "rejected",
      marketRegimeScore: rejectedScore.marketRegimeScore,
      technicalScore: rejectedScore.technicalScore,
      optionsQualityScore: rejectedScore.optionsQualityScore,
      tradeQualityScore: rejectedScore.tradeQualityScore,
      totalScore: rejectedScore.totalScore,
      decision: rejectedScore.decision,
      suggestedRiskMXN: rejectedScore.suggestedRiskMXN,
      reasons: rejectedScore.reasons.join("\n"),
      warnings: rejectedScore.warnings.join("\n"),
      scores: {
        create: {
          marketRegimeScore: rejectedScore.marketRegimeScore,
          technicalScore: rejectedScore.technicalScore,
          optionsQualityScore: rejectedScore.optionsQualityScore,
          tradeQualityScore: rejectedScore.tradeQualityScore,
          totalScore: rejectedScore.totalScore,
          decision: rejectedScore.decision,
          suggestedRiskMXN: rejectedScore.suggestedRiskMXN,
          reasons: rejectedScore.reasons.join("\n"),
          warnings: rejectedScore.warnings.join("\n")
        }
      }
    }
  });

  const approvedPayload = {
    symbol: "AAPL",
    direction: "bullish",
    strategy: "debit_spread",
    thesis:
      "Price is holding above the 20MA after a clean consolidation, and a debit spread limits premium while preserving upside into the next catalyst.",
    catalyst: "Product event and continuation from sector strength.",
    invalidationLevel: 188,
    ...emptyContractData,
    targetPrice: 205,
    expirationDate: new Date("2026-07-17T00:00:00"),
    premiumCost: 260,
    maxLoss: 300,
    expectedReward: 600,
    exitPlan: "Exit at 80% of max gain, close if price loses 188, or close two weeks before expiration if thesis stalls.",
    spyTrend: "bullish",
    qqqTrend: "neutral",
    vixCondition: "normal",
    marketBreadth: "neutral",
    macroRisk: "medium",
    trend: "uptrend",
    priceVs20MA: "above",
    priceVs50MA: "above",
    rsiCondition: "neutral",
    volumeCondition: "normal",
    supportResistanceQuality: "good",
    bidAskSpreadPercent: 7,
    optionVolume: 140,
    openInterest: 620,
    daysToExpiration: 44,
    impliedVolatilityRank: 42,
    premiumAsPercentOfPortfolio: 0.49,
    isChasing: false
  };
  const approvedScore = evaluateTradeIdea(approvedPayload, settings, exposure);

  const approvedIdea = await prisma.tradeIdea.create({
    data: {
      portfolioId: gbmPortfolio.id,
      ...approvedPayload,
      status: "approved",
      marketRegimeScore: approvedScore.marketRegimeScore,
      technicalScore: approvedScore.technicalScore,
      optionsQualityScore: approvedScore.optionsQualityScore,
      tradeQualityScore: approvedScore.tradeQualityScore,
      totalScore: approvedScore.totalScore,
      decision: approvedScore.decision,
      suggestedRiskMXN: approvedScore.suggestedRiskMXN,
      reasons: approvedScore.reasons.join("\n"),
      warnings: approvedScore.warnings.join("\n"),
      scores: {
        create: {
          marketRegimeScore: approvedScore.marketRegimeScore,
          technicalScore: approvedScore.technicalScore,
          optionsQualityScore: approvedScore.optionsQualityScore,
          tradeQualityScore: approvedScore.tradeQualityScore,
          totalScore: approvedScore.totalScore,
          decision: approvedScore.decision,
          suggestedRiskMXN: approvedScore.suggestedRiskMXN,
          reasons: approvedScore.reasons.join("\n"),
          warnings: approvedScore.warnings.join("\n")
        }
      }
    }
  });

  await prisma.tradeJournal.create({
    data: {
      tradeIdeaId: approvedIdea.id,
      entryDate: new Date("2026-05-01T00:00:00"),
      entryPrice: 260,
      notes: "Sample open journal entry for an approved_small setup."
    }
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
