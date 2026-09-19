export type PriceBarLike = {
  timestamp?: Date | number | string;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  close: number;
  volume?: number | null;
};

export type TechnicalSnapshot = {
  lastClose: number | null;
  sma20: number | null;
  sma50: number | null;
  sma200: number | null;
  rsi14: number | null;
  atr14: number | null;
  relativeVolume: number | null;
  bwap: number | null;
  distanceFromBwap: number | null;
  trendLabel: "uptrend" | "sideways" | "downtrend";
};

export type TechnicalScoreBreakdown = {
  total: number;
  trendQuality: number;
  maAlignmentQuality: number;
  rsiQuality: number;
  volumeQuality: number;
  bwapQuality: number;
  supportResistanceQuality: number;
  atrRiskQuality: number;
  warnings: string[];
};

function finite(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function average(values: number[]) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function sma(values: number[], period: number): number | null {
  const clean = values.filter(Number.isFinite);
  if (period <= 0 || clean.length < period) return null;
  return average(clean.slice(-period));
}

export function ema(values: number[], period: number): number | null {
  const clean = values.filter(Number.isFinite);
  if (period <= 0 || clean.length < period) return null;
  const multiplier = 2 / (period + 1);
  let current = average(clean.slice(0, period));
  if (current === null) return null;

  for (const value of clean.slice(period)) {
    current = value * multiplier + current * (1 - multiplier);
  }

  return current;
}

export function rsi(closes: number[], period = 14): number | null {
  const clean = closes.filter(Number.isFinite);
  if (period <= 0 || clean.length <= period) return null;

  let averageGain = 0;
  let averageLoss = 0;

  for (let index = 1; index <= period; index += 1) {
    const change = clean[index] - clean[index - 1];
    if (change >= 0) averageGain += change;
    else averageLoss += Math.abs(change);
  }

  averageGain /= period;
  averageLoss /= period;

  for (let index = period + 1; index < clean.length; index += 1) {
    const change = clean[index] - clean[index - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    averageGain = (averageGain * (period - 1) + gain) / period;
    averageLoss = (averageLoss * (period - 1) + loss) / period;
  }

  if (averageLoss === 0) return 100;
  const rs = averageGain / averageLoss;
  return 100 - 100 / (1 + rs);
}

export function atr(bars: PriceBarLike[], period = 14): number | null {
  const clean = bars.filter((bar) => finite(bar.high) !== null && finite(bar.low) !== null && finite(bar.close) !== null);
  if (period <= 0 || clean.length <= period) return null;

  const trueRanges: number[] = [];
  for (let index = 1; index < clean.length; index += 1) {
    const high = clean[index].high!;
    const low = clean[index].low!;
    const previousClose = clean[index - 1].close;
    trueRanges.push(Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose)));
  }

  return average(trueRanges.slice(-period));
}

export function relativeVolume(bars: PriceBarLike[], period = 20): number | null {
  const volumes = bars.map((bar) => finite(bar.volume)).filter((value): value is number => value !== null);
  if (period <= 0 || volumes.length <= period) return null;
  const latest = volumes.at(-1);
  const baseline = average(volumes.slice(-(period + 1), -1));
  if (latest === undefined || baseline === null || baseline <= 0) return null;
  return latest / baseline;
}

export function calculateBWAP(bars: PriceBarLike[]): number | null {
  let weightedSum = 0;
  let volumeSum = 0;

  for (const bar of bars) {
    const close = finite(bar.close);
    const volume = finite(bar.volume);
    if (close === null || volume === null || volume <= 0) continue;
    const high = finite(bar.high);
    const low = finite(bar.low);
    const typicalPrice = high !== null && low !== null ? (high + low + close) / 3 : close;
    weightedSum += typicalPrice * volume;
    volumeSum += volume;
  }

  return volumeSum > 0 ? weightedSum / volumeSum : null;
}

export const vwapOrBwap = calculateBWAP;

export function distanceToMovingAverage(price: number, ma: number): number {
  if (!Number.isFinite(price) || !Number.isFinite(ma) || ma === 0) return 0;
  return ((price - ma) / ma) * 100;
}

function round(value: number | null, digits = 4) {
  return value === null || !Number.isFinite(value) ? null : Number(value.toFixed(digits));
}

export function technicalSnapshotFromBars(bars: PriceBarLike[]): TechnicalSnapshot {
  const closes = bars.map((bar) => bar.close).filter(Number.isFinite);
  const lastClose = finite(closes.at(-1));
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(bars, 14);
  const relVolume = relativeVolume(bars, 20);
  const bwap = calculateBWAP(bars);
  const distanceFromBwap = lastClose !== null && bwap !== null ? distanceToMovingAverage(lastClose, bwap) : null;

  let trendLabel: TechnicalSnapshot["trendLabel"] = "sideways";
  if (lastClose !== null && sma20 !== null && sma50 !== null) {
    if (lastClose > sma20 && sma20 > sma50) trendLabel = "uptrend";
    else if (lastClose < sma20 && sma20 < sma50) trendLabel = "downtrend";
  }

  return {
    lastClose: round(lastClose),
    sma20: round(sma20),
    sma50: round(sma50),
    sma200: round(sma200),
    rsi14: round(rsi14, 2),
    atr14: round(atr14),
    relativeVolume: round(relVolume, 2),
    bwap: round(bwap),
    distanceFromBwap: round(distanceFromBwap, 2),
    trendLabel
  };
}

function directionalQuality(direction: string, bullishValue: boolean, bearishValue: boolean, neutralValue = false) {
  if (direction === "bullish") return bullishValue ? 1 : 0.2;
  if (direction === "bearish") return bearishValue ? 1 : 0.2;
  return neutralValue ? 1 : 0.55;
}

function rsiQualityForDirection(direction: string, value: number | null) {
  if (value === null) return 0.55;
  if (direction === "bullish") {
    if (value >= 45 && value <= 70) return 1;
    if (value > 75) return 0.15;
    if (value < 30) return 0.45;
    return clamp01(1 - Math.abs(value - 57.5) / 40);
  }
  if (direction === "bearish") {
    if (value >= 30 && value <= 55) return 1;
    if (value < 20) return 0.25;
    if (value > 72) return 0.45;
    return clamp01(1 - Math.abs(value - 42.5) / 40);
  }
  return clamp01(1 - Math.abs(value - 50) / 35);
}

function supportResistanceQuality(value: string) {
  if (value === "good") return 1;
  if (value === "poor") return 0.2;
  return 0.65;
}

export function scoreTechnicalSnapshot(input: {
  direction: string;
  snapshot?: TechnicalSnapshot | null;
  manualTrend?: string | null;
  manualPriceVs20MA?: string | null;
  manualPriceVs50MA?: string | null;
  manualRsiCondition?: string | null;
  manualVolumeCondition?: string | null;
  supportResistanceQuality?: string | null;
}): TechnicalScoreBreakdown | null {
  const snapshot = input.snapshot;
  if (!snapshot || snapshot.lastClose === null) return null;

  const price = snapshot.lastClose;
  const above20 = snapshot.sma20 !== null && price >= snapshot.sma20;
  const above50 = snapshot.sma50 !== null && price >= snapshot.sma50;
  const maBull = above20 && above50 && (snapshot.sma20 === null || snapshot.sma50 === null || snapshot.sma20 >= snapshot.sma50);
  const maBear = !above20 && !above50 && (snapshot.sma20 === null || snapshot.sma50 === null || snapshot.sma20 <= snapshot.sma50);
  const trendQuality = directionalQuality(
    input.direction,
    snapshot.trendLabel === "uptrend",
    snapshot.trendLabel === "downtrend",
    snapshot.trendLabel === "sideways"
  );
  const maAlignmentQuality = directionalQuality(input.direction, maBull, maBear, Math.abs(snapshot.distanceFromBwap ?? 0) <= 2);
  const rsiQuality = rsiQualityForDirection(input.direction, snapshot.rsi14);
  const volumeQuality = snapshot.relativeVolume === null ? 0.55 : clamp01(Math.sqrt(Math.min(snapshot.relativeVolume, 3) / 1.25));
  const bwapQuality =
    snapshot.distanceFromBwap === null
      ? 0.55
      : input.direction === "bullish"
        ? snapshot.distanceFromBwap >= 0
          ? clamp01(1 - Math.max(snapshot.distanceFromBwap - 8, 0) / 15)
          : clamp01(1 + snapshot.distanceFromBwap / 8)
        : input.direction === "bearish"
          ? snapshot.distanceFromBwap <= 0
            ? clamp01(1 - Math.max(Math.abs(snapshot.distanceFromBwap) - 8, 0) / 15)
            : clamp01(1 - snapshot.distanceFromBwap / 8)
          : clamp01(1 - Math.abs(snapshot.distanceFromBwap) / 6);
  const srQuality = supportResistanceQuality(input.supportResistanceQuality ?? "average");
  const atrPercent = snapshot.atr14 !== null && price > 0 ? (snapshot.atr14 / price) * 100 : null;
  const atrRiskQuality = atrPercent === null ? 0.6 : clamp01(1 - Math.max(atrPercent - 2.5, 0) / 7.5);
  const total =
    100 *
    (0.25 * trendQuality +
      0.2 * maAlignmentQuality +
      0.15 * rsiQuality +
      0.15 * volumeQuality +
      0.1 * bwapQuality +
      0.1 * srQuality +
      0.05 * atrRiskQuality);
  const warnings = [
    ...(input.manualTrend && input.manualTrend !== snapshot.trendLabel
      ? [`Manual trend (${input.manualTrend}) conflicts with calculated trend (${snapshot.trendLabel}).`]
      : []),
    ...(input.manualPriceVs20MA && snapshot.sma20 !== null && input.manualPriceVs20MA !== (above20 ? "above" : "below")
      ? ["Manual 20MA selection conflicts with calculated SMA20."]
      : []),
    ...(input.manualPriceVs50MA && snapshot.sma50 !== null && input.manualPriceVs50MA !== (above50 ? "above" : "below")
      ? ["Manual 50MA selection conflicts with calculated SMA50."]
      : []),
    ...(snapshot.distanceFromBwap !== null && snapshot.distanceFromBwap > 12
      ? ["Price is extended far above BWAP / VWAP-style weighted average price."]
      : []),
    ...(snapshot.distanceFromBwap !== null && snapshot.distanceFromBwap < -12
      ? ["Price is extended far below BWAP / VWAP-style weighted average price."]
      : [])
  ];

  return {
    total: Math.min(100, Math.max(0, Number(total.toFixed(1)))),
    trendQuality,
    maAlignmentQuality,
    rsiQuality,
    volumeQuality,
    bwapQuality,
    supportResistanceQuality: srQuality,
    atrRiskQuality,
    warnings
  };
}
