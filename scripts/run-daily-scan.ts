import { appendFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { ensureDailyAutoIdeas } from "../lib/auto-ideas";
import { prisma } from "../lib/db";
import { refreshPortfolioDaily } from "../lib/daily-refresh";
import { refreshPortfolioMarketPrices } from "../lib/portfolio-prices";

const logDirectory = resolve("logs");
const logPath = resolve(logDirectory, "daily-scan.log");

function errorMessage(error: unknown) {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

async function writeLog(level: "info" | "error", message: string, details: Record<string, unknown> = {}) {
  await mkdir(logDirectory, { recursive: true });
  await appendFile(
    logPath,
    `${JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...details })}\n`,
    "utf8"
  );
}

async function scanPortfolio(portfolio: { id: string; name: string }) {
  const run = await prisma.strategyScanRun.create({
    data: {
      portfolioId: portfolio.id,
      universe: "core-liquid-universe",
      mode: "daily",
      source: "riskgate-daily",
      status: "running"
    }
  });

  await writeLog("info", "Strategy scan started", { runId: run.id, portfolioId: portfolio.id, portfolio: portfolio.name });

  try {
    const positions = await refreshPortfolioMarketPrices(portfolio.id, { force: true });
    const refresh = await refreshPortfolioDaily(portfolio.id, { force: true });
    const ideas = await ensureDailyAutoIdeas(portfolio.id, 5, true);
    const errors = Array.from(
      new Set([
        ...refresh.errors,
        ...ideas.errors,
        ...(positions.failed ? [`Portfolio price refresh failed for ${positions.failed} position(s).`] : [])
      ])
    );
    const status = errors.length ? "partial" : "success";
    const completedAt = new Date();
    const notes = JSON.stringify({
      portfolio: portfolio.name,
      positions: {
        updated: positions.updated,
        failed: positions.failed,
        skipped: positions.skipped,
        usdMxnRate: positions.usdMxnRate
      },
      refresh: {
        refreshedQuotes: refresh.refreshedQuotes,
        rescoredIdeas: refresh.rescoredIdeas,
        skipped: refresh.skipped
      },
      sourceStatus: ideas.sourceStatus,
      errors
    });
    const completed = await prisma.strategyScanRun.update({
      where: { id: run.id },
      data: {
        status,
        symbolsScanned: ideas.symbolsScanned,
        candidatesFound: ideas.candidatesFound,
        ideasInserted: ideas.created,
        ideasUpdated: ideas.updated,
        notes,
        error: errors.length ? errors.join(" | ").slice(0, 4000) : null,
        completedAt
      }
    });
    const summary = {
      id: completed.id,
      portfolioId: completed.portfolioId,
      status: completed.status,
      symbolsScanned: completed.symbolsScanned,
      candidatesFound: completed.candidatesFound,
      ideasInserted: completed.ideasInserted,
      ideasUpdated: completed.ideasUpdated,
      createdAt: completed.createdAt.toISOString(),
      completedAt: completed.completedAt?.toISOString() ?? null,
      errors
    };

    await writeLog("info", "Strategy scan completed", summary);
    console.log(JSON.stringify(summary));
    return summary;
  } catch (error) {
    const message = errorMessage(error);
    const completedAt = new Date();

    await prisma.strategyScanRun.update({
      where: { id: run.id },
      data: {
        status: "failed",
        error: message.slice(0, 4000),
        completedAt
      }
    });
    await writeLog("error", "Strategy scan failed", { runId: run.id, portfolioId: portfolio.id, error: message });
    throw error;
  }
}

async function main() {
  const portfolios = await prisma.portfolio.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true }
  });

  if (!portfolios.length) {
    throw new Error("No RiskGate portfolios exist; the daily strategy scan cannot run.");
  }

  const failures: string[] = [];
  for (const portfolio of portfolios) {
    try {
      await scanPortfolio(portfolio);
    } catch (error) {
      failures.push(`${portfolio.name}: ${errorMessage(error)}`);
    }
  }

  if (failures.length) {
    throw new Error(failures.join("\n"));
  }
}

main()
  .catch(async (error) => {
    const message = errorMessage(error);
    await writeLog("error", "Daily scan command failed", { error: message });
    console.error(message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
