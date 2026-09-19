export type OptionsQualityInput = {
  spreadPercent?: number | null;
  dte?: number | null;
  volume?: number | null;
  openInterest?: number | null;
  ivRank?: number | null;
  premium?: number | null;
  portfolioValue?: number | null;
  theta?: number | null;
  mid?: number | null;
};

export type OptionsQualityBreakdown = {
  total: number;
  spreadQuality: number;
  dteQuality: number;
  volumeQuality: number;
  openInterestQuality: number;
  ivRankQuality: number;
  premiumSizeQuality: number;
  thetaDecayQuality: number;
  warnings: string[];
  hardStops: string[];
};

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function safe(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function spreadQuality(spreadPercent?: number | null) {
  const spread = safe(spreadPercent);
  if (spread === null) return 0.35;
  if (spread <= 2) return 1;
  return clamp01(1 / (1 + Math.pow((spread - 2) / 5, 3)));
}

export function dteQuality(dte?: number | null) {
  const days = safe(dte);
  if (days === null) return 0.55;
  if (days < 5) return 0;
  if (days < 21) return clamp01((days - 5) / 16);
  if (days <= 60) return 1;
  if (days <= 240) return clamp01(1 - (days - 60) / 180);
  return 0;
}

export function volumeQuality(volume?: number | null) {
  return clamp01(Math.sqrt(Math.max(safe(volume) ?? 0, 0) / 500));
}

export function openInterestQuality(openInterest?: number | null) {
  return clamp01(Math.sqrt(Math.max(safe(openInterest) ?? 0, 0) / 1000));
}

export function ivRankQuality(ivRank?: number | null) {
  const value = safe(ivRank);
  if (value === null) return 0.65;
  return clamp01(1 - Math.pow(clamp01(value / 100), 2));
}

export function premiumSizeQuality(input: Pick<OptionsQualityInput, "premium" | "portfolioValue">) {
  const premium = safe(input.premium);
  const portfolioValue = safe(input.portfolioValue);
  if (premium === null || portfolioValue === null || portfolioValue <= 0) return 0.65;
  const percent = (premium / portfolioValue) * 100;
  if (percent <= 0.25) return 1;
  if (percent <= 1) return clamp01(1 - 0.65 * Math.pow((percent - 0.25) / 0.75, 2));
  return clamp01(0.35 / (1 + Math.pow(percent - 1, 2)));
}

export function thetaDecayQuality(theta?: number | null, mid?: number | null) {
  const thetaValue = safe(theta);
  const midValue = safe(mid);
  if (thetaValue === null || midValue === null || midValue <= 0) return 0.75;
  return clamp01(1 - Math.abs(thetaValue / midValue));
}

export function scoreOptionsQuality(input: OptionsQualityInput): OptionsQualityBreakdown {
  const spread = safe(input.spreadPercent);
  const dte = safe(input.dte);
  const premium = safe(input.premium);
  const portfolioValue = safe(input.portfolioValue);
  const spreadScore = spreadQuality(spread);
  const dteScore = dteQuality(dte);
  const volumeScore = volumeQuality(input.volume);
  const oiScore = openInterestQuality(input.openInterest);
  const ivRankScore = ivRankQuality(input.ivRank);
  const premiumScore = premiumSizeQuality(input);
  const thetaScore = thetaDecayQuality(input.theta, input.mid);
  const total =
    100 *
    (0.3 * spreadScore +
      0.2 * dteScore +
      0.15 * volumeScore +
      0.15 * oiScore +
      0.08 * ivRankScore +
      0.07 * premiumScore +
      0.05 * thetaScore);
  const hardStops = [
    ...(spread !== null && spread > 15 ? ["Bid/ask spread is wider than 15%."] : []),
    ...(dte !== null && dte < 7 ? ["Days to expiration is below 7."] : []),
    ...(premium !== null && portfolioValue !== null && portfolioValue > 0 && (premium / portfolioValue) * 100 > 1
      ? ["Premium exceeds 1% of portfolio."]
      : [])
  ];
  const warnings = [
    ...(spread === null ? ["Spread quality is using a conservative fallback because spread is missing."] : []),
    ...(dte === null ? ["DTE quality is using a neutral fallback because DTE is missing."] : []),
    ...(input.ivRank === null || input.ivRank === undefined ? ["IV rank missing; options quality assigned 0.65 for IV rank."] : []),
    ...(input.theta === null || input.theta === undefined || input.mid === null || input.mid === undefined
      ? ["Theta or mid missing; options quality assigned 0.75 for theta decay."]
      : []),
    ...(spread !== null && spread > 10 && spread <= 15 ? ["Bid/ask spread is wide and materially reduces options quality."] : []),
    ...(input.ivRank !== null && input.ivRank !== undefined && input.ivRank > 70 ? ["IV rank is elevated."] : [])
  ];

  return {
    total: Math.min(100, Math.max(0, Number(total.toFixed(1)))),
    spreadQuality: spreadScore,
    dteQuality: dteScore,
    volumeQuality: volumeScore,
    openInterestQuality: oiScore,
    ivRankQuality: ivRankScore,
    premiumSizeQuality: premiumScore,
    thetaDecayQuality: thetaScore,
    warnings,
    hardStops
  };
}
