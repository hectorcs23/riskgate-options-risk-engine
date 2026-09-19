import { mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const dbPath = resolve("prisma", "dev.db");
mkdirSync(dirname(dbPath), { recursive: true });
rmSync(dbPath, { force: true });

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE "Portfolio" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "institution" TEXT,
  "baseCurrency" TEXT NOT NULL DEFAULT 'MXN',
  "notes" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

CREATE TABLE "Position" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "portfolioId" TEXT NOT NULL,
  "symbol" TEXT NOT NULL,
  "assetType" TEXT NOT NULL,
  "market" TEXT NOT NULL,
  "quantity" REAL NOT NULL,
  "averageCost" REAL NOT NULL,
  "currentPrice" REAL NOT NULL,
  "currency" TEXT NOT NULL,
  "account" TEXT NOT NULL,
  "notes" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "Position_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "Portfolio" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "TradeIdea" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "portfolioId" TEXT NOT NULL,
  "symbol" TEXT NOT NULL,
  "direction" TEXT NOT NULL,
  "strategy" TEXT NOT NULL,
  "thesis" TEXT NOT NULL,
  "catalyst" TEXT,
  "invalidationLevel" REAL,
  "targetPrice" REAL,
  "expirationDate" DATETIME,
  "optionContractSymbol" TEXT,
  "optionType" TEXT,
  "strikePrice" REAL,
  "shortStrikePrice" REAL,
  "contractBid" REAL,
  "contractAsk" REAL,
  "contractMid" REAL,
  "contractDelta" REAL,
  "contractGamma" REAL,
  "contractTheta" REAL,
  "contractVega" REAL,
  "contractRho" REAL,
  "contractImpliedVolatility" REAL,
  "contractUnderlyingPrice" REAL,
  "contractBreakEvenPrice" REAL,
  "contractSnapshotAt" DATETIME,
  "premiumCost" REAL,
  "maxLoss" REAL NOT NULL,
  "expectedReward" REAL,
  "exitPlan" TEXT,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "marketRegimeScore" REAL,
  "technicalScore" REAL,
  "optionsQualityScore" REAL,
  "tradeQualityScore" REAL,
  "totalScore" REAL,
  "decision" TEXT,
  "suggestedRiskMXN" REAL,
  "reasons" TEXT,
  "warnings" TEXT,
  "spyTrend" TEXT NOT NULL DEFAULT 'neutral',
  "qqqTrend" TEXT NOT NULL DEFAULT 'neutral',
  "vixCondition" TEXT NOT NULL DEFAULT 'normal',
  "marketBreadth" TEXT NOT NULL DEFAULT 'neutral',
  "macroRisk" TEXT NOT NULL DEFAULT 'medium',
  "trend" TEXT NOT NULL DEFAULT 'sideways',
  "priceVs20MA" TEXT NOT NULL DEFAULT 'above',
  "priceVs50MA" TEXT NOT NULL DEFAULT 'above',
  "rsiCondition" TEXT NOT NULL DEFAULT 'neutral',
  "volumeCondition" TEXT NOT NULL DEFAULT 'normal',
  "supportResistanceQuality" TEXT NOT NULL DEFAULT 'average',
  "bidAskSpreadPercent" REAL NOT NULL DEFAULT 8,
  "optionVolume" REAL NOT NULL DEFAULT 100,
  "openInterest" REAL NOT NULL DEFAULT 500,
  "daysToExpiration" REAL NOT NULL DEFAULT 30,
  "impliedVolatilityRank" REAL,
  "premiumAsPercentOfPortfolio" REAL NOT NULL DEFAULT 0.5,
  "isChasing" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  "lastEvaluatedAt" DATETIME,
  CONSTRAINT "TradeIdea_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "Portfolio" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ModelScore" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tradeIdeaId" TEXT NOT NULL,
  "marketRegimeScore" REAL NOT NULL,
  "technicalScore" REAL NOT NULL,
  "optionsQualityScore" REAL NOT NULL,
  "tradeQualityScore" REAL NOT NULL,
  "totalScore" REAL NOT NULL,
  "decision" TEXT NOT NULL,
  "suggestedRiskMXN" REAL NOT NULL,
  "reasons" TEXT NOT NULL,
  "warnings" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ModelScore_tradeIdeaId_fkey" FOREIGN KEY ("tradeIdeaId") REFERENCES "TradeIdea" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ModelScore_tradeIdeaId_key" ON "ModelScore"("tradeIdeaId");

CREATE TABLE "OptionLeg" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tradeIdeaId" TEXT NOT NULL,
  "symbol" TEXT,
  "underlying" TEXT NOT NULL,
  "optionType" TEXT NOT NULL,
  "side" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "expirationDate" DATETIME NOT NULL,
  "strike" REAL NOT NULL,
  "bid" REAL,
  "ask" REAL,
  "mid" REAL,
  "spreadPercent" REAL,
  "impliedVol" REAL,
  "ivRank" REAL,
  "delta" REAL,
  "gamma" REAL,
  "theta" REAL,
  "vega" REAL,
  "rho" REAL,
  "openInterest" INTEGER,
  "volume" INTEGER,
  "dte" INTEGER,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "OptionLeg_tradeIdeaId_fkey" FOREIGN KEY ("tradeIdeaId") REFERENCES "TradeIdea" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "OptionLeg_tradeIdeaId_idx" ON "OptionLeg"("tradeIdeaId");
CREATE INDEX "OptionLeg_underlying_expirationDate_idx" ON "OptionLeg"("underlying", "expirationDate");

CREATE TABLE "TradeScoreSnapshot" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tradeIdeaId" TEXT NOT NULL,
  "snapshotDate" DATETIME NOT NULL,
  "marketRegimeScore" REAL NOT NULL,
  "technicalScore" REAL NOT NULL,
  "optionsQualityScore" REAL NOT NULL,
  "tradeQualityScore" REAL NOT NULL,
  "totalScore" REAL NOT NULL,
  "decision" TEXT NOT NULL,
  "suggestedRiskMXN" REAL NOT NULL,
  "reasons" TEXT NOT NULL,
  "warnings" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TradeScoreSnapshot_tradeIdeaId_fkey" FOREIGN KEY ("tradeIdeaId") REFERENCES "TradeIdea" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "TradeScoreSnapshot_tradeIdeaId_snapshotDate_key" ON "TradeScoreSnapshot"("tradeIdeaId", "snapshotDate");

CREATE TABLE "RiskSettings" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "portfolioId" TEXT NOT NULL,
  "totalPortfolioValue" REAL NOT NULL DEFAULT 100000,
  "optionsSleevePercent" REAL NOT NULL DEFAULT 3,
  "maxOptionsSleeveMXN" REAL NOT NULL DEFAULT 3000,
  "baseRiskPerTradePercent" REAL NOT NULL DEFAULT 0.5,
  "baseRiskPerTradeMXN" REAL NOT NULL DEFAULT 500,
  "maxMonthlyOptionsLossPercent" REAL NOT NULL DEFAULT 1,
  "maxMonthlyOptionsLossMXN" REAL NOT NULL DEFAULT 1000,
  "maxOpenOptionsRiskPercent" REAL NOT NULL DEFAULT 2,
  "maxOpenOptionsRiskMXN" REAL NOT NULL DEFAULT 2000,
  "redditSentimentEnabled" BOOLEAN NOT NULL DEFAULT false,
  "redditUseInFinalScore" BOOLEAN NOT NULL DEFAULT false,
  "redditSubreddits" TEXT NOT NULL DEFAULT 'stocks,investing,options,wallstreetbets,ValueInvesting,SecurityAnalysis,StockMarket',
  "redditMaxPostsPerSubreddit" INTEGER NOT NULL DEFAULT 10,
  "redditMaxCommentsPerPost" INTEGER NOT NULL DEFAULT 0,
  "redditRefreshIntervalHours" INTEGER NOT NULL DEFAULT 12,
  "enableYahooFinanceSentiment" BOOLEAN NOT NULL DEFAULT false,
  "sentimentLookbackDays" INTEGER NOT NULL DEFAULT 14,
  "sentimentMaxDocuments" INTEGER NOT NULL DEFAULT 10,
  "eventRiskEnabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "RiskSettings_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "Portfolio" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "RiskSettings_portfolioId_key" ON "RiskSettings"("portfolioId");

CREATE TABLE "TradeJournal" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tradeIdeaId" TEXT NOT NULL,
  "entryDate" DATETIME NOT NULL,
  "exitDate" DATETIME,
  "entryPrice" REAL NOT NULL,
  "exitPrice" REAL,
  "realizedPnL" REAL,
  "result" TEXT,
  "mistakeTags" TEXT,
  "notes" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "TradeJournal_tradeIdeaId_fkey" FOREIGN KEY ("tradeIdeaId") REFERENCES "TradeIdea" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "WatchlistItem" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "portfolioId" TEXT NOT NULL,
  "symbol" TEXT NOT NULL,
  "name" TEXT,
  "market" TEXT NOT NULL DEFAULT 'US',
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "dataSource" TEXT NOT NULL DEFAULT 'yahoo',
  "currentPrice" REAL,
  "previousClose" REAL,
  "dayChange" REAL,
  "dayChangePercent" REAL,
  "lastUpdated" DATETIME,
  "notes" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "WatchlistItem_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "Portfolio" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "WatchlistItem_portfolioId_symbol_key" ON "WatchlistItem"("portfolioId", "symbol");

CREATE TABLE "PortfolioSnapshot" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "portfolioId" TEXT NOT NULL,
  "totalValue" REAL NOT NULL,
  "cashValue" REAL NOT NULL,
  "stockValue" REAL NOT NULL,
  "optionValue" REAL NOT NULL,
  "source" TEXT NOT NULL DEFAULT 'manual',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PortfolioSnapshot_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "Portfolio" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "PortfolioSnapshot_portfolioId_createdAt_idx" ON "PortfolioSnapshot"("portfolioId", "createdAt");

CREATE TABLE "StrategyScanRun" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "portfolioId" TEXT,
  "universe" TEXT NOT NULL,
  "mode" TEXT NOT NULL DEFAULT 'research',
  "symbolsScanned" INTEGER NOT NULL DEFAULT 0,
  "candidatesFound" INTEGER NOT NULL DEFAULT 0,
  "ideasInserted" INTEGER NOT NULL DEFAULT 0,
  "ideasUpdated" INTEGER NOT NULL DEFAULT 0,
  "source" TEXT NOT NULL DEFAULT 'riskgate-daily',
  "status" TEXT NOT NULL DEFAULT 'running',
  "notes" TEXT,
  "error" TEXT,
  "completedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StrategyScanRun_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "Portfolio" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "StrategyScanRun_createdAt_idx" ON "StrategyScanRun"("createdAt");
CREATE INDEX "StrategyScanRun_portfolioId_createdAt_idx" ON "StrategyScanRun"("portfolioId", "createdAt");

CREATE TABLE "DiscoverySymbolHistory" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "portfolioId" TEXT NOT NULL,
  "symbol" TEXT NOT NULL,
  "firstQualifiedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastQualifiedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSavedAt" DATETIME,
  "timesSurfaced" INTEGER NOT NULL DEFAULT 1,
  "lastDiscoveryScore" REAL,
  "lastOutcome" TEXT,
  "lastReason" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "DiscoverySymbolHistory_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "Portfolio" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "DiscoverySymbolHistory_portfolioId_symbol_key" ON "DiscoverySymbolHistory"("portfolioId", "symbol");
CREATE INDEX "DiscoverySymbolHistory_portfolioId_lastQualifiedAt_idx" ON "DiscoverySymbolHistory"("portfolioId", "lastQualifiedAt");
CREATE INDEX "DiscoverySymbolHistory_portfolioId_lastSavedAt_idx" ON "DiscoverySymbolHistory"("portfolioId", "lastSavedAt");

CREATE TABLE "PriceBar" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "portfolioId" TEXT NOT NULL,
  "symbol" TEXT NOT NULL,
  "timeframe" TEXT NOT NULL,
  "timestamp" DATETIME NOT NULL,
  "open" REAL NOT NULL,
  "high" REAL NOT NULL,
  "low" REAL NOT NULL,
  "close" REAL NOT NULL,
  "volume" REAL NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PriceBar_portfolioId_fkey" FOREIGN KEY ("portfolioId") REFERENCES "Portfolio" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "PriceBar_portfolioId_symbol_timeframe_timestamp_key" ON "PriceBar"("portfolioId", "symbol", "timeframe", "timestamp");
CREATE INDEX "PriceBar_portfolioId_symbol_timeframe_timestamp_idx" ON "PriceBar"("portfolioId", "symbol", "timeframe", "timestamp");

CREATE TABLE "RedditDocument" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "symbol" TEXT NOT NULL,
  "subreddit" TEXT NOT NULL,
  "postId" TEXT,
  "commentId" TEXT,
  "url" TEXT,
  "title" TEXT,
  "body" TEXT NOT NULL,
  "score" INTEGER,
  "numComments" INTEGER,
  "createdUtc" DATETIME,
  "cleanedText" TEXT NOT NULL,
  "sentiment" TEXT,
  "sentimentScore" REAL,
  "embeddingId" TEXT,
  "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "RedditDocument_symbol_subreddit_postId_commentId_key" ON "RedditDocument"("symbol", "subreddit", "postId", "commentId");
CREATE INDEX "RedditDocument_symbol_subreddit_fetchedAt_idx" ON "RedditDocument"("symbol", "subreddit", "fetchedAt");

CREATE TABLE "YahooFinanceDocument" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "portfolioId" TEXT,
  "ticker" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "publisher" TEXT,
  "summary" TEXT,
  "url" TEXT,
  "publishedAt" DATETIME,
  "collectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentimentLabel" TEXT,
  "sentimentScore" REAL,
  "relevanceScore" REAL,
  "hypeScore" REAL,
  "fearScore" REAL,
  "catalysts" TEXT,
  "concerns" TEXT
);

CREATE INDEX "YahooFinanceDocument_ticker_idx" ON "YahooFinanceDocument"("ticker");
CREATE INDEX "YahooFinanceDocument_publishedAt_idx" ON "YahooFinanceDocument"("publishedAt");
CREATE INDEX "YahooFinanceDocument_collectedAt_idx" ON "YahooFinanceDocument"("collectedAt");
`);

db.close();
console.log(`Created SQLite schema at ${dbPath}`);
