import { calculateMultiLegMetrics, optionLegPnL, type OptionLegInput, type StockLegInput } from "@/lib/options/multileg";

export type MonteCarloInput = {
  underlyingPrice: number;
  legs: OptionLegInput[];
  impliedVolatility: number;
  dte: number;
  riskFreeRate?: number;
  dividendYield?: number;
  simulations?: number;
  expectedDrift?: number;
  stockLeg?: StockLegInput | null;
  seed?: number;
};

export type MonteCarloResult = {
  simulations: number;
  probabilityOfProfit: number;
  expectedValue: number;
  medianPnL: number;
  p5: number;
  p95: number;
  probabilityOfMaxLoss?: number | null;
  cvar95: number;
  maxSimulatedLoss: number;
  maxSimulatedGain: number;
  histogram: { binStart: number; binEnd: number; count: number }[];
};

function lcg(seed: number) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function randomSource(seed?: number) {
  return seed === undefined ? Math.random : lcg(seed);
}

function standardNormal(random: () => number) {
  const u1 = Math.max(random(), Number.EPSILON);
  const u2 = Math.max(random(), Number.EPSILON);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function percentile(sortedValues: number[], percentileValue: number) {
  if (!sortedValues.length) return 0;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.round((sortedValues.length - 1) * percentileValue))
  );
  return sortedValues[index];
}

function stockPnL(stockLeg: StockLegInput | null | undefined, underlyingPrice: number) {
  if (!stockLeg) return 0;
  const sideMultiplier = stockLeg.side === "long" ? 1 : -1;
  return sideMultiplier * stockLeg.quantity * (underlyingPrice - stockLeg.entryPrice);
}

function histogram(values: number[], bins = 20) {
  if (!values.length) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return [{ binStart: min, binEnd: max, count: values.length }];

  const width = (max - min) / bins;
  const counts = Array.from({ length: bins }, () => 0);

  for (const value of values) {
    const index = Math.min(bins - 1, Math.floor((value - min) / width));
    counts[index] += 1;
  }

  return counts.map((count, index) => ({
    binStart: Number((min + width * index).toFixed(2)),
    binEnd: Number((min + width * (index + 1)).toFixed(2)),
    count
  }));
}

export function simulateMonteCarlo(input: MonteCarloInput): MonteCarloResult {
  const simulations = Math.max(Math.trunc(input.simulations ?? 10000), 100);
  const sigma = Math.max(input.impliedVolatility, 0.0001);
  const tau = Math.max(input.dte, 1) / 365;
  const mu = input.expectedDrift ?? 0;
  const q = input.dividendYield ?? 0;
  const random = randomSource(input.seed);
  const pnlValues: number[] = [];

  for (let index = 0; index < simulations; index += 1) {
    const z = standardNormal(random);
    const terminalPrice =
      input.underlyingPrice *
      Math.exp((mu - q - 0.5 * sigma * sigma) * tau + sigma * Math.sqrt(tau) * z);
    const pnl =
      input.legs.reduce((sum, leg) => sum + optionLegPnL(leg, terminalPrice), 0) +
      stockPnL(input.stockLeg, terminalPrice);
    pnlValues.push(pnl);
  }

  const sorted = pnlValues.slice().sort((left, right) => left - right);
  const expectedValue = pnlValues.reduce((sum, value) => sum + value, 0) / pnlValues.length;
  const p5 = percentile(sorted, 0.05);
  const p95 = percentile(sorted, 0.95);
  const tailCount = Math.max(1, Math.floor(sorted.length * 0.05));
  const cvar95 = sorted.slice(0, tailCount).reduce((sum, value) => sum + value, 0) / tailCount;
  const metrics = calculateMultiLegMetrics({
    legs: input.legs,
    underlyingPrice: input.underlyingPrice,
    stockLeg: input.stockLeg
  });
  const maxLoss = metrics.maxLoss;
  const probabilityOfMaxLoss =
    maxLoss === null || maxLoss <= 0
      ? null
      : pnlValues.filter((value) => value <= -maxLoss * 0.98).length / pnlValues.length;

  return {
    simulations,
    probabilityOfProfit: pnlValues.filter((value) => value > 0).length / pnlValues.length,
    expectedValue,
    medianPnL: percentile(sorted, 0.5),
    p5,
    p95,
    probabilityOfMaxLoss,
    cvar95,
    maxSimulatedLoss: Math.min(...pnlValues),
    maxSimulatedGain: Math.max(...pnlValues),
    histogram: histogram(pnlValues)
  };
}

export function monteCarloScoreAdjustment(result: MonteCarloResult, maxLoss?: number | null) {
  if (maxLoss !== null && maxLoss !== undefined && maxLoss > 0 && Math.abs(result.cvar95) >= maxLoss * 0.85) {
    return -10;
  }
  if (result.expectedValue < 0) return -5;
  if (result.expectedValue > 0 && result.probabilityOfProfit > 0.55) return 5;
  return 0;
}

export function monteCarloRiskMultiplier(result: MonteCarloResult | null, maxLoss?: number | null) {
  if (!result) return 1;
  if (maxLoss !== null && maxLoss !== undefined && maxLoss > 0 && Math.abs(result.cvar95) >= maxLoss * 0.85) {
    return 0.5;
  }
  if (result.expectedValue < 0 || result.probabilityOfProfit < 0.4) return 0.75;
  return 1;
}
