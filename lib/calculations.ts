import type { Position, RiskSettings, TradeIdea, TradeJournal } from "@prisma/client";

export function positionMarketValue(position: Position) {
  return position.quantity * position.currentPrice;
}

export function positionCostBasis(position: Position) {
  return position.quantity * position.averageCost;
}

export function positionPnl(position: Position) {
  return positionMarketValue(position) - positionCostBasis(position);
}

export function positionPnlPercent(position: Position) {
  const costBasis = positionCostBasis(position);
  if (!costBasis) return 0;
  return (positionPnl(position) / costBasis) * 100;
}

export function summarizePositions(positions: Position[], settings: RiskSettings) {
  const currentValue = positions.reduce((sum, position) => sum + positionMarketValue(position), 0);
  const fallbackValue = settings.totalPortfolioValue;
  const totalValue = currentValue > 0 ? currentValue : fallbackValue;
  const cash = positions
    .filter((position) => position.assetType === "cash")
    .reduce((sum, position) => sum + positionMarketValue(position), 0);
  const stocks = positions
    .filter((position) => ["stock", "etf"].includes(position.assetType))
    .reduce((sum, position) => sum + positionMarketValue(position), 0);
  const options = positions
    .filter((position) => position.assetType === "option")
    .reduce((sum, position) => sum + positionMarketValue(position), 0);

  return {
    totalValue,
    cash,
    stocks,
    options,
    manualValue: currentValue
  };
}

export function optionsRiskUsed(tradeIdeas: TradeIdea[]) {
  return tradeIdeas
    .filter((idea) => ["approved", "entered"].includes(idea.status) || idea.decision?.startsWith("approved"))
    .reduce((sum, idea) => sum + (idea.suggestedRiskMXN ?? 0), 0);
}

export function monthlyOptionsLoss(journal: TradeJournal[], now = new Date()) {
  return journal.reduce((sum, entry) => {
    if (!entry.exitDate || !entry.realizedPnL || entry.realizedPnL >= 0) return sum;
    const sameMonth =
      entry.exitDate.getFullYear() === now.getFullYear() &&
      entry.exitDate.getMonth() === now.getMonth();
    return sameMonth ? sum + Math.abs(entry.realizedPnL) : sum;
  }, 0);
}

export function journalStats(journal: TradeJournal[]) {
  const closed = journal.filter((entry) => entry.realizedPnL !== null && entry.realizedPnL !== undefined);
  const wins = closed.filter((entry) => (entry.realizedPnL ?? 0) > 0);
  const losses = closed.filter((entry) => (entry.realizedPnL ?? 0) < 0);
  const totalPnl = closed.reduce((sum, entry) => sum + (entry.realizedPnL ?? 0), 0);
  const averageWin = wins.length
    ? wins.reduce((sum, entry) => sum + (entry.realizedPnL ?? 0), 0) / wins.length
    : 0;
  const averageLoss = losses.length
    ? losses.reduce((sum, entry) => sum + (entry.realizedPnL ?? 0), 0) / losses.length
    : 0;
  const winRate = closed.length ? (wins.length / closed.length) * 100 : 0;
  const lossRate = closed.length ? (losses.length / closed.length) * 100 : 0;
  const expectancy = (winRate / 100) * averageWin + (lossRate / 100) * averageLoss;
  const pnlValues = closed.map((entry) => entry.realizedPnL ?? 0);
  const meanPnl = closed.length ? totalPnl / closed.length : 0;
  const pnlStdDev = standardDeviation(pnlValues);
  const downsideStdDev = standardDeviation(pnlValues.filter((value) => value < 0));
  const averageDurationDays = average(
    closed.flatMap((entry) => {
      if (!entry.exitDate) return [];
      const days = (entry.exitDate.getTime() - entry.entryDate.getTime()) / (1000 * 60 * 60 * 24);
      return Number.isFinite(days) && days >= 0 ? [days || 1] : [];
    })
  );
  const annualization = averageDurationDays ? Math.sqrt(252 / averageDurationDays) : 0;
  const sharpe = pnlStdDev ? (meanPnl / pnlStdDev) * annualization : 0;
  const sortino = downsideStdDev ? (meanPnl / downsideStdDev) * annualization : 0;

  return {
    closedCount: closed.length,
    winRate,
    averageWin,
    averageLoss,
    expectancy,
    totalPnl,
    sharpe,
    sortino,
    averageDurationDays,
    pnlStdDev
  };
}

function average(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: number[]) {
  if (values.length < 2) return 0;
  const mean = average(values);
  const variance = values.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

type JournalWithIdea = TradeJournal & {
  tradeIdea: TradeIdea;
};

const scoreBands = [
  { label: "< 60", min: Number.NEGATIVE_INFINITY, max: 60 },
  { label: "60-74", min: 60, max: 75 },
  { label: "75-84", min: 75, max: 85 },
  { label: "85+", min: 85, max: Number.POSITIVE_INFINITY }
];

export function scoreBandBacktest(journal: JournalWithIdea[]) {
  const closed = journal.filter(
    (entry) =>
      entry.realizedPnL !== null &&
      entry.realizedPnL !== undefined &&
      entry.tradeIdea.totalScore !== null &&
      entry.tradeIdea.totalScore !== undefined
  );

  return scoreBands.map((band) => {
    const entries = closed.filter((entry) => {
      const score = entry.tradeIdea.totalScore ?? 0;
      return score >= band.min && score < band.max;
    });
    const wins = entries.filter((entry) => (entry.realizedPnL ?? 0) > 0);
    const losses = entries.filter((entry) => (entry.realizedPnL ?? 0) < 0);
    const averageWin = average(wins.map((entry) => entry.realizedPnL ?? 0));
    const averageLoss = average(losses.map((entry) => entry.realizedPnL ?? 0));
    const winRate = entries.length ? (wins.length / entries.length) * 100 : 0;
    const lossRate = entries.length ? (losses.length / entries.length) * 100 : 0;
    const expectancy = (winRate / 100) * averageWin + (lossRate / 100) * averageLoss;
    const totalPnl = entries.reduce((sum, entry) => sum + (entry.realizedPnL ?? 0), 0);

    return {
      ...band,
      count: entries.length,
      winRate,
      averageWin,
      averageLoss,
      expectancy,
      totalPnl
    };
  });
}

function lcg(seed: number) {
  let state = seed || 1;
  return () => {
    state = (1664525 * state + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function percentile(values: number[], p: number) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[index];
}

export function journalBootstrap(journal: TradeJournal[], iterations = 1000) {
  const closed = journal.filter((entry) => entry.realizedPnL !== null && entry.realizedPnL !== undefined);
  if (closed.length < 5) {
    return {
      enoughData: false,
      winRateCI: [0, 0] as [number, number],
      expectancyCI: [0, 0] as [number, number],
      sharpeCI: [0, 0] as [number, number]
    };
  }

  const random = lcg(closed.length * 7919);
  const winRates: number[] = [];
  const expectancies: number[] = [];
  const sharpes: number[] = [];

  for (let i = 0; i < iterations; i += 1) {
    const sample = Array.from({ length: closed.length }, () => closed[Math.floor(random() * closed.length)]);
    const stats = journalStats(sample);
    winRates.push(stats.winRate);
    expectancies.push(stats.expectancy);
    sharpes.push(stats.sharpe);
  }

  return {
    enoughData: true,
    winRateCI: [percentile(winRates, 0.025), percentile(winRates, 0.975)] as [number, number],
    expectancyCI: [percentile(expectancies, 0.025), percentile(expectancies, 0.975)] as [number, number],
    sharpeCI: [percentile(sharpes, 0.025), percentile(sharpes, 0.975)] as [number, number]
  };
}
