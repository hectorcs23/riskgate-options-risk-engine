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
  if (!columns(table).has(name)) {
    db.exec(`ALTER TABLE "${table}" ADD COLUMN "${name}" ${definition};`);
  }
}

if (!tableExists("StrategyScanRun")) {
  db.exec(`
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
      CONSTRAINT "StrategyScanRun_portfolioId_fkey"
        FOREIGN KEY ("portfolioId") REFERENCES "Portfolio" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );
  `);
} else {
  addColumn("StrategyScanRun", "ideasInserted", "INTEGER NOT NULL DEFAULT 0");
  addColumn("StrategyScanRun", "ideasUpdated", "INTEGER NOT NULL DEFAULT 0");
  addColumn("StrategyScanRun", "status", "TEXT NOT NULL DEFAULT 'running'");
  addColumn("StrategyScanRun", "error", "TEXT");
  addColumn("StrategyScanRun", "completedAt", "DATETIME");
}

db.exec(`
  CREATE INDEX IF NOT EXISTS "StrategyScanRun_createdAt_idx" ON "StrategyScanRun"("createdAt");
  CREATE INDEX IF NOT EXISTS "StrategyScanRun_portfolioId_createdAt_idx"
    ON "StrategyScanRun"("portfolioId", "createdAt");
`);

let replaced = 0;
if (tableExists("TradeIdea")) {
  const now = Date.now();
  db.prepare(`
    WITH ranked AS (
      SELECT
        "id",
        ROW_NUMBER() OVER (
          PARTITION BY "portfolioId", UPPER("symbol"), "direction", "strategy"
          ORDER BY COALESCE("updatedAt", "createdAt") DESC, "createdAt" DESC, "id" DESC
        ) AS duplicate_rank
      FROM "TradeIdea"
      WHERE "thesis" LIKE '%Auto-generated discovery idea.%'
        AND "status" NOT IN ('closed', 'replaced')
        AND ("expirationDate" IS NULL OR "expirationDate" >= ?)
    )
    UPDATE "TradeIdea"
    SET "status" = 'replaced'
    WHERE "id" IN (SELECT "id" FROM ranked WHERE duplicate_rank > 1)
  `).run(now);
  replaced = Number(db.prepare("SELECT changes() AS count").get().count);
}

db.close();
console.log(`Strategy scan migration complete; marked ${replaced} older active auto-idea rows as replaced.`);
