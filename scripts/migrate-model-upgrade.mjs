import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const dbPath = resolve("prisma", "dev.db");

if (!existsSync(dbPath)) {
  console.log("No SQLite database found; run npm run db:init first.");
  process.exit(0);
}

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON;");

function tableExists(name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function columns(table) {
  return new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((column) => column.name));
}

function addColumn(table, name, definition) {
  const existing = columns(table);
  if (!existing.has(name)) {
    db.exec(`ALTER TABLE "${table}" ADD COLUMN "${name}" ${definition};`);
  }
}

if (!tableExists("OptionLeg")) {
  db.exec(`
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
  `);
}

if (!tableExists("PriceBar")) {
  db.exec(`
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
  `);
}

if (!tableExists("RedditDocument")) {
  db.exec(`
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
  `);
}

if (tableExists("RiskSettings")) {
  addColumn("RiskSettings", "redditSentimentEnabled", "BOOLEAN NOT NULL DEFAULT false");
  addColumn("RiskSettings", "redditUseInFinalScore", "BOOLEAN NOT NULL DEFAULT false");
  addColumn(
    "RiskSettings",
    "redditSubreddits",
    "TEXT NOT NULL DEFAULT 'stocks,investing,options,wallstreetbets,ValueInvesting,SecurityAnalysis,StockMarket'"
  );
  addColumn("RiskSettings", "redditMaxPostsPerSubreddit", "INTEGER NOT NULL DEFAULT 10");
  addColumn("RiskSettings", "redditMaxCommentsPerPost", "INTEGER NOT NULL DEFAULT 0");
  addColumn("RiskSettings", "redditRefreshIntervalHours", "INTEGER NOT NULL DEFAULT 12");
}

db.close();
console.log("Model upgrade migration complete.");
