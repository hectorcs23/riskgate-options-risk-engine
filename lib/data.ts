import { prisma } from "@/lib/db";
import { monthlyOptionsLoss, optionsRiskUsed } from "@/lib/calculations";
import { concentrationAnalytics } from "@/lib/concentration";
import { defaultWatchlistSymbols } from "@/lib/market-data";

const defaultSettings = {
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
  redditSubreddits: "stocks,investing,options,wallstreetbets,ValueInvesting,SecurityAnalysis,StockMarket",
  redditMaxPostsPerSubreddit: 10,
  redditMaxCommentsPerPost: 0,
  redditRefreshIntervalHours: 12,
  enableYahooFinanceSentiment: true,
  sentimentLookbackDays: 14,
  sentimentMaxDocuments: 10,
  eventRiskEnabled: true
};

export async function getPortfolios() {
  const existing = await prisma.portfolio.findMany({
    orderBy: { createdAt: "asc" }
  });

  if (existing.length) return existing;

  const created = await prisma.portfolio.create({
    data: {
      name: "GBM+ Main",
      institution: "GBM",
      baseCurrency: "MXN"
    }
  });

  await prisma.riskSettings.create({
    data: {
      portfolioId: created.id,
      ...defaultSettings
    }
  });
  await prisma.watchlistItem.createMany({
    data: defaultWatchlistSymbols.map((item) => ({
      portfolioId: created.id,
      symbol: item.symbol,
      name: item.name,
      market: item.market,
      currency: item.currency,
      dataSource: "yahoo",
      notes: item.notes
    }))
  });

  return [created];
}

export async function getSelectedPortfolio(portfolioId?: string) {
  const portfolios = await getPortfolios();
  const selected = portfolios.find((portfolio) => portfolio.id === portfolioId) ?? portfolios[0];

  return {
    portfolios,
    selectedPortfolio: selected
  };
}

export async function getRiskSettings(portfolioId: string) {
  const existing = await prisma.riskSettings.findFirst({
    where: { portfolioId },
    orderBy: { createdAt: "asc" }
  });

  if (existing) return existing;

  return prisma.riskSettings.create({
    data: {
      portfolioId,
      ...defaultSettings
    }
  });
}

export async function getRiskExposure(portfolioId: string, excludeTradeIdeaId?: string) {
  const [tradeIdeas, journal] = await Promise.all([
    prisma.tradeIdea.findMany({
      where: { portfolioId }
    }),
    prisma.tradeJournal.findMany({
      where: {
        tradeIdea: {
          portfolioId
        }
      }
    })
  ]);
  const includedTradeIdeas = excludeTradeIdeaId
    ? tradeIdeas.filter((idea) => idea.id !== excludeTradeIdeaId)
    : tradeIdeas;
  const usedRisk = optionsRiskUsed(includedTradeIdeas);
  const concentration = concentrationAnalytics(includedTradeIdeas);

  return {
    optionsRiskUsed: usedRisk,
    monthlyLossUsed: monthlyOptionsLoss(journal),
    openOptionsRiskUsed: usedRisk,
    concentrationMultiplier: concentration.concentrationPenalty
  };
}
