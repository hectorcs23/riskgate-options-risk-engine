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

const snapshotTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'TradeScoreSnapshot'").get();
const portfolioSnapshotTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'PortfolioSnapshot'").get();

if (!snapshotTable) {
  db.exec(`
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
  `);
}

if (!portfolioSnapshotTable) {
  db.exec(`
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
  `);
}

const seedSymbols = [
  ["SPY", "SPDR S&P 500 ETF", "US", "Core market regime proxy."],
  ["QQQ", "Invesco QQQ Trust", "US", "Growth and Nasdaq regime proxy."],
  ["DIA", "SPDR Dow Jones Industrial Average ETF", "US", "Large-cap industrial proxy."],
  ["IWM", "iShares Russell 2000 ETF", "US", "Small-cap breadth proxy."],
  ["VOO", "Vanguard S&P 500 ETF", "US", "Long-term S&P 500 ETF reference."],
  ["VTI", "Vanguard Total Stock Market ETF", "US", "Whole-market reference."],
  ["^VIX", "CBOE Volatility Index", "INDEX", "Volatility and stress proxy."],
  ["AAPL", "Apple Inc.", "US", "Mega-cap technology watchlist ticker."],
  ["MSFT", "Microsoft Corporation", "US", "Mega-cap technology watchlist ticker."],
  ["NVDA", "NVIDIA Corporation", "US", "Semiconductor momentum watchlist ticker."],
  ["META", "Meta Platforms, Inc.", "US", "Mega-cap technology watchlist ticker."],
  ["AMZN", "Amazon.com, Inc.", "US", "Consumer and cloud watchlist ticker."],
  ["GOOGL", "Alphabet Inc.", "US", "Mega-cap technology watchlist ticker."],
  ["TSLA", "Tesla, Inc.", "US", "High-beta watchlist ticker."],
  ["AMD", "Advanced Micro Devices, Inc.", "US", "Semiconductor watchlist ticker."],
  ["AVGO", "Broadcom Inc.", "US", "Semiconductor watchlist ticker."],
  ["NFLX", "Netflix, Inc.", "US", "Growth watchlist ticker."],
  ["JPM", "JPMorgan Chase & Co.", "US", "Financial sector reference."],
  ["XLF", "Financial Select Sector SPDR Fund", "US", "Financial sector ETF."],
  ["XLK", "Technology Select Sector SPDR Fund", "US", "Technology sector ETF."],
  ["XLV", "Health Care Select Sector SPDR Fund", "US", "Healthcare sector ETF."],
  ["XLE", "Energy Select Sector SPDR Fund", "US", "Energy sector ETF."]
];

const portfolios = db.prepare('SELECT id FROM "Portfolio"').all();
const insertWatchlist = db.prepare(`
INSERT OR IGNORE INTO "WatchlistItem"
("id", "portfolioId", "symbol", "name", "market", "currency", "dataSource", "notes", "updatedAt")
VALUES (?, ?, ?, ?, ?, 'USD', 'yahoo', ?, CURRENT_TIMESTAMP)
`);

for (const portfolio of portfolios) {
  for (const [symbol, name, market, notes] of seedSymbols) {
    insertWatchlist.run(
      `wl_${portfolio.id}_${symbol.replace(/[^A-Za-z0-9]/g, "")}`,
      portfolio.id,
      symbol,
      name,
      market,
      notes
    );
  }
}

const today = new Date();
const snapshotDate = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
const ideas = db.prepare(`
SELECT id, marketRegimeScore, technicalScore, optionsQualityScore, tradeQualityScore, totalScore, decision, suggestedRiskMXN, reasons, warnings
FROM "TradeIdea"
WHERE totalScore IS NOT NULL
`).all();
const insertSnapshot = db.prepare(`
INSERT OR IGNORE INTO "TradeScoreSnapshot"
("id", "tradeIdeaId", "snapshotDate", "marketRegimeScore", "technicalScore", "optionsQualityScore", "tradeQualityScore", "totalScore", "decision", "suggestedRiskMXN", "reasons", "warnings")
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

for (const idea of ideas) {
  insertSnapshot.run(
    `snap_${idea.id}_${snapshotDate.slice(0, 10).replace(/-/g, "")}`,
    idea.id,
    snapshotDate,
    idea.marketRegimeScore ?? 0,
    idea.technicalScore ?? 0,
    idea.optionsQualityScore ?? 0,
    idea.tradeQualityScore ?? 0,
    idea.totalScore ?? 0,
    idea.decision ?? "watchlist",
    idea.suggestedRiskMXN ?? 0,
    idea.reasons ?? "",
    idea.warnings ?? ""
  );
}

db.close();
console.log("Robustness migration complete.");
