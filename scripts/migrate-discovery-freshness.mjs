import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const dbPath = resolve("prisma", "dev.db");

if (!existsSync(dbPath)) {
  console.log("No SQLite database found; run npm run db:init first.");
  process.exit(0);
}

const stamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const backupPath = resolve("prisma", "backups", `dev-before-discovery-freshness-${stamp}.db`);
mkdirSync(dirname(backupPath), { recursive: true });
copyFileSync(dbPath, backupPath);

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON;");

function tableExists(name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function columns(table) {
  return new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((column) => column.name));
}

if (tableExists("TradeIdea") && !columns("TradeIdea").has("lastEvaluatedAt")) {
  db.exec('ALTER TABLE "TradeIdea" ADD COLUMN "lastEvaluatedAt" DATETIME;');
}

if (tableExists("TradeIdea")) {
  db.exec(`
    UPDATE "TradeIdea"
    SET "lastEvaluatedAt" = "updatedAt"
    WHERE "lastEvaluatedAt" IS NULL;
  `);
}

if (!tableExists("DiscoverySymbolHistory")) {
  db.exec(`
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
      CONSTRAINT "DiscoverySymbolHistory_portfolioId_fkey"
        FOREIGN KEY ("portfolioId") REFERENCES "Portfolio" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );
  `);
}

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS "DiscoverySymbolHistory_portfolioId_symbol_key"
    ON "DiscoverySymbolHistory"("portfolioId", "symbol");
  CREATE INDEX IF NOT EXISTS "DiscoverySymbolHistory_portfolioId_lastQualifiedAt_idx"
    ON "DiscoverySymbolHistory"("portfolioId", "lastQualifiedAt");
  CREATE INDEX IF NOT EXISTS "DiscoverySymbolHistory_portfolioId_lastSavedAt_idx"
    ON "DiscoverySymbolHistory"("portfolioId", "lastSavedAt");
`);

let seeded = 0;
if (tableExists("TradeIdea")) {
  const historicalSymbols = db.prepare(`
    SELECT
      "portfolioId",
      UPPER("symbol") AS "symbol",
      MIN("createdAt") AS "firstQualifiedAt",
      MAX(COALESCE("lastEvaluatedAt", "updatedAt", "createdAt")) AS "lastQualifiedAt",
      MAX("createdAt") AS "lastSavedAt",
      COUNT(*) AS "timesSurfaced"
    FROM "TradeIdea"
    WHERE "thesis" LIKE '%Auto-generated discovery idea.%'
    GROUP BY "portfolioId", UPPER("symbol")
  `).all();
  const upsert = db.prepare(`
    INSERT INTO "DiscoverySymbolHistory" (
      "id", "portfolioId", "symbol", "firstQualifiedAt", "lastQualifiedAt", "lastSavedAt",
      "timesSurfaced", "lastOutcome", "lastReason", "createdAt", "updatedAt"
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'seeded', 'Seeded from existing RiskGate auto ideas.', ?, ?)
    ON CONFLICT("portfolioId", "symbol") DO UPDATE SET
      "firstQualifiedAt" = MIN("DiscoverySymbolHistory"."firstQualifiedAt", excluded."firstQualifiedAt"),
      "lastQualifiedAt" = MAX("DiscoverySymbolHistory"."lastQualifiedAt", excluded."lastQualifiedAt"),
      "lastSavedAt" = MAX("DiscoverySymbolHistory"."lastSavedAt", excluded."lastSavedAt"),
      "timesSurfaced" = MAX("DiscoverySymbolHistory"."timesSurfaced", excluded."timesSurfaced"),
      "updatedAt" = excluded."updatedAt";
  `);
  const now = Date.now();

  db.exec("BEGIN IMMEDIATE;");
  try {
    for (const row of historicalSymbols) {
      upsert.run(
        `history_${randomUUID()}`,
        row.portfolioId,
        row.symbol,
        row.firstQualifiedAt,
        row.lastQualifiedAt,
        row.lastSavedAt,
        Number(row.timesSurfaced),
        now,
        now
      );
      seeded += 1;
    }
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

db.close();
console.log(`Discovery freshness migration complete; seeded ${seeded} symbol histories.`);
console.log(`Backup: ${backupPath}`);
