import type { TradeIdea } from "@prisma/client";

const sectorMap: Record<string, string> = {
  AAPL: "Technology",
  MSFT: "Technology",
  NVDA: "Semiconductors",
  AMD: "Semiconductors",
  AVGO: "Semiconductors",
  META: "Communication Services",
  GOOGL: "Communication Services",
  NFLX: "Communication Services",
  AMZN: "Consumer Discretionary",
  TSLA: "Consumer Discretionary",
  JPM: "Financials",
  XLF: "Financials",
  XLK: "Technology",
  XLV: "Healthcare",
  XLE: "Energy",
  SPY: "Broad Market",
  QQQ: "Broad Market",
  DIA: "Broad Market",
  IWM: "Broad Market",
  VOO: "Broad Market",
  VTI: "Broad Market"
};

function sectorFor(symbol: string) {
  return sectorMap[symbol.toUpperCase()] ?? "Other";
}

export function concentrationAnalytics(ideas: TradeIdea[]) {
  const active = ideas.filter((idea) => idea.status === "entered" || idea.decision?.startsWith("approved"));
  const totalRisk = active.reduce((sum, idea) => sum + (idea.suggestedRiskMXN ?? idea.maxLoss ?? 0), 0);
  const sectorRisk = new Map<string, number>();

  for (const idea of active) {
    const risk = idea.suggestedRiskMXN ?? idea.maxLoss ?? 0;
    const sector = sectorFor(idea.symbol);
    sectorRisk.set(sector, (sectorRisk.get(sector) ?? 0) + risk);
  }

  const sectors = Array.from(sectorRisk.entries())
    .map(([sector, risk]) => ({
      sector,
      risk,
      weight: totalRisk ? risk / totalRisk : 0
    }))
    .sort((left, right) => right.risk - left.risk);
  const hhi = sectors.reduce((sum, sector) => sum + sector.weight * sector.weight, 0);
  const topSector = sectors[0] ?? null;
  const concentrationPenalty = hhi > 0.5 ? 0.5 : hhi > 0.35 ? 0.75 : 1;

  return {
    activeCount: active.length,
    totalRisk,
    sectors,
    hhi,
    topSector,
    concentrationPenalty,
    warning:
      hhi > 0.5
        ? "High concentration: most open options risk is in one sector/theme."
        : hhi > 0.35
          ? "Moderate concentration: size future correlated trades carefully."
          : null
  };
}
