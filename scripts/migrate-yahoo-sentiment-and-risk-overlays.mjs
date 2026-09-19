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

if (tableExists("RiskSettings")) {
  addColumn("RiskSettings", "enableYahooFinanceSentiment", "BOOLEAN NOT NULL DEFAULT true");
  addColumn("RiskSettings", "sentimentLookbackDays", "INTEGER NOT NULL DEFAULT 14");
  addColumn("RiskSettings", "sentimentMaxDocuments", "INTEGER NOT NULL DEFAULT 10");
  addColumn("RiskSettings", "eventRiskEnabled", "BOOLEAN NOT NULL DEFAULT true");
}

if (!tableExists("YahooFinanceDocument")) {
  db.exec(`
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
}

db.close();
console.log("Yahoo sentiment and risk overlay migration complete.");
