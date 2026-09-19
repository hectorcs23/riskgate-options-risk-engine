import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const dbPath = resolve("prisma", "dev.db");

if (!existsSync(dbPath)) {
  console.log("No SQLite database found; run npm run db:init first.");
  process.exit(0);
}

const db = new DatabaseSync(dbPath);
const columns = db.prepare('PRAGMA table_info("TradeIdea")').all();
const existing = new Set(columns.map((column) => column.name));
const additions = [
  ["optionContractSymbol", "TEXT"],
  ["optionType", "TEXT"],
  ["strikePrice", "REAL"],
  ["shortStrikePrice", "REAL"],
  ["contractBid", "REAL"],
  ["contractAsk", "REAL"],
  ["contractMid", "REAL"],
  ["contractDelta", "REAL"],
  ["contractGamma", "REAL"],
  ["contractTheta", "REAL"],
  ["contractVega", "REAL"],
  ["contractRho", "REAL"],
  ["contractImpliedVolatility", "REAL"],
  ["contractUnderlyingPrice", "REAL"],
  ["contractBreakEvenPrice", "REAL"],
  ["contractSnapshotAt", "DATETIME"]
];

for (const [name, type] of additions) {
  if (!existing.has(name)) {
    db.exec(`ALTER TABLE "TradeIdea" ADD COLUMN "${name}" ${type};`);
  }
}

db.close();
console.log("Alpaca options migration complete.");
