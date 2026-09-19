import type { PortfolioSnapshot } from "@prisma/client";
import { prisma } from "@/lib/db";

export type PortfolioSnapshotInput = {
  portfolioId: string;
  totalValue: number;
  cashValue: number;
  stockValue: number;
  optionValue: number;
  source?: string;
};

export type IntradayPerformance = {
  firstSnapshot: PortfolioSnapshot | null;
  previousSnapshot: PortfolioSnapshot | null;
  latestSnapshot: PortfolioSnapshot | null;
  snapshotCount: number;
  intradayChangeMXN: number;
  intradayChangePercent: number;
  lastChangeMXN: number;
  lastChangePercent: number;
  chartData: { label: string; value: number }[];
};

export function startOfLocalDay(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function minutesBetween(left: Date, right: Date) {
  return Math.abs(right.getTime() - left.getTime()) / (1000 * 60);
}

function percentChange(current: number, previous: number) {
  if (!previous) return 0;
  return ((current - previous) / previous) * 100;
}

function timeLabel(date: Date) {
  return date.toLocaleTimeString("es-MX", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

export async function createPortfolioSnapshot(input: PortfolioSnapshotInput) {
  return prisma.portfolioSnapshot.create({
    data: {
      portfolioId: input.portfolioId,
      totalValue: input.totalValue,
      cashValue: input.cashValue,
      stockValue: input.stockValue,
      optionValue: input.optionValue,
      source: input.source ?? "manual"
    }
  });
}

export async function ensurePortfolioSnapshot(input: PortfolioSnapshotInput, intervalMinutes = 30) {
  const latest = await prisma.portfolioSnapshot.findFirst({
    where: { portfolioId: input.portfolioId },
    orderBy: { createdAt: "desc" }
  });
  const now = new Date();
  const valueChanged = latest ? Math.abs(latest.totalValue - input.totalValue) >= 1 : true;
  const stale = latest ? minutesBetween(latest.createdAt, now) >= intervalMinutes : true;
  const newDay = latest ? latest.createdAt < startOfLocalDay(now) : true;

  if (!latest || valueChanged || stale || newDay) {
    return createPortfolioSnapshot({
      ...input,
      source: input.source ?? (valueChanged ? "value_change" : "interval")
    });
  }

  return latest;
}

export async function getIntradayPerformance(portfolioId: string, currentTotalValue?: number): Promise<IntradayPerformance> {
  const todayStart = startOfLocalDay();
  const snapshots = await prisma.portfolioSnapshot.findMany({
    where: {
      portfolioId,
      createdAt: {
        gte: todayStart
      }
    },
    orderBy: { createdAt: "asc" }
  });
  const firstSnapshot = snapshots[0] ?? null;
  const latestSnapshot = snapshots.at(-1) ?? null;
  const previousSnapshot = snapshots.length >= 2 ? snapshots.at(-2) ?? null : null;
  const currentValue = currentTotalValue ?? latestSnapshot?.totalValue ?? firstSnapshot?.totalValue ?? 0;
  const baseline = firstSnapshot?.totalValue ?? currentValue;
  const previousValue = previousSnapshot?.totalValue ?? baseline;

  return {
    firstSnapshot,
    previousSnapshot,
    latestSnapshot,
    snapshotCount: snapshots.length,
    intradayChangeMXN: currentValue - baseline,
    intradayChangePercent: percentChange(currentValue, baseline),
    lastChangeMXN: currentValue - previousValue,
    lastChangePercent: percentChange(currentValue, previousValue),
    chartData: snapshots.map((snapshot) => ({
      label: timeLabel(snapshot.createdAt),
      value: snapshot.totalValue
    }))
  };
}
