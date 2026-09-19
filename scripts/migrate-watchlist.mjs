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

const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'WatchlistItem'").get();

if (!table) {
  db.exec(`
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
  `);
}

const portfolios = db.prepare('SELECT id FROM "Portfolio"').all();
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
const insert = db.prepare(`
INSERT OR IGNORE INTO "WatchlistItem"
("id", "portfolioId", "symbol", "name", "market", "currency", "dataSource", "notes", "updatedAt")
VALUES (?, ?, ?, ?, ?, ?, 'yahoo', ?, CURRENT_TIMESTAMP)
`);

for (const portfolio of portfolios) {
  for (const [symbol, name, market, notes] of seedSymbols) {
    insert.run(
      `wl_${portfolio.id}_${symbol.replace(/[^A-Za-z0-9]/g, "")}`,
      portfolio.id,
      symbol,
      name,
      market,
      "USD",
      notes
    );
  }
}

db.close();
console.log("Watchlist migration complete.");
