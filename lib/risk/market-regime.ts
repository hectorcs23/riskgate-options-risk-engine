export type MarketRegimeLabel =
  | "strong_bullish"
  | "bullish"
  | "neutral"
  | "bearish"
  | "strong_bearish"
  | "stress";

export type RegimeComponentStatus = "bullish" | "neutral" | "bearish" | "stress" | "unavailable";

export type MarketRegimeComponent = {
  name: "SPY" | "QQQ" | "BREADTH" | "VIX";
  score: number;
  weight: number;
  status: RegimeComponentStatus;
  reason: string;
  isAvailable: boolean;
};

export type CompositeMarketRegime = {
  compositeScore: number;
  label: MarketRegimeLabel;
  confidence: number;
  components: MarketRegimeComponent[];
  reasons: string[];
  warnings: string[];
};

export type TrendComponentInput = {
  price?: number | null;
  sma20?: number | null;
  sma50?: number | null;
  change20d?: number | null;
  trend?: "bullish" | "neutral" | "bearish" | null;
};

export type BreadthComponentInput = {
  ratio?: number | null;
  status?: "strong" | "neutral" | "weak" | null;
};

export type VixComponentInput = {
  value?: number | null;
  dailyChangePercent?: number | null;
  condition?: "low" | "normal" | "elevated" | "spiking" | null;
};

export type MarketRegimeInput = {
  spy?: TrendComponentInput | null;
  qqq?: TrendComponentInput | null;
  breadth?: BreadthComponentInput | null;
  vix?: VixComponentInput | null;
};

export const DEFAULT_REGIME_WEIGHTS = {
  SPY: 0.3,
  QQQ: 0.25,
  BREADTH: 0.25,
  VIX: 0.2
} as const;

function clampUnit(value: number) {
  return Math.min(1, Math.max(-1, value));
}

function round(value: number, digits = 3) {
  return Number(value.toFixed(digits));
}

function finite(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function statusFromScore(score: number): RegimeComponentStatus {
  if (score <= -0.85) return "stress";
  if (score <= -0.25) return "bearish";
  if (score >= 0.25) return "bullish";
  return "neutral";
}

export function labelFromCompositeScore(score: number): MarketRegimeLabel {
  if (score >= 0.6) return "strong_bullish";
  if (score >= 0.25) return "bullish";
  if (score > -0.25) return "neutral";
  if (score > -0.6) return "bearish";
  if (score > -0.8) return "strong_bearish";
  return "stress";
}

export function scoreTrend(price?: number | null, sma20?: number | null, sma50?: number | null, change20d?: number | null) {
  const p = finite(price);
  const ma20 = finite(sma20);
  const ma50 = finite(sma50);
  const change = finite(change20d);

  if (p === null || ma20 === null || ma50 === null || change === null) return 0;

  let score = 0;
  score += p > ma20 ? 0.25 : -0.25;
  score += p > ma50 ? 0.35 : -0.35;
  score += ma20 > ma50 ? 0.25 : -0.25;
  score += change > 0 ? 0.15 : -0.15;

  return clampUnit(score);
}

function scoreTrendLabel(trend?: TrendComponentInput["trend"]) {
  if (trend === "bullish") return 0.65;
  if (trend === "bearish") return -0.65;
  if (trend === "neutral") return 0;
  return null;
}

export function scoreBreadthRatio(ratio: number) {
  if (ratio >= 0.7) return 1;
  if (ratio >= 0.6) return 0.6;
  if (ratio >= 0.5) return 0.25;
  if (ratio >= 0.4) return -0.25;
  if (ratio >= 0.3) return -0.6;
  return -1;
}

function scoreBreadthStatus(status?: BreadthComponentInput["status"]) {
  if (status === "strong") return 0.75;
  if (status === "weak") return -0.75;
  if (status === "neutral") return 0;
  return null;
}

export function scoreVix(value?: number | null, dailyChangePercent?: number | null, condition?: VixComponentInput["condition"]) {
  const vix = finite(value);
  const dailyChange = finite(dailyChangePercent);
  let score: number | null = null;

  if (vix !== null) {
    if (vix < 15) score = 0.75;
    else if (vix < 22) score = 0.25;
    else if (vix < 30) score = -0.5;
    else score = -1;
  } else if (condition === "low") {
    score = 0.75;
  } else if (condition === "normal") {
    score = 0.25;
  } else if (condition === "elevated") {
    score = -0.5;
  } else if (condition === "spiking") {
    score = -1;
  }

  if (score === null) return null;
  return clampUnit(score - (dailyChange !== null && dailyChange >= 15 ? 0.25 : 0));
}

function trendComponent(name: "SPY" | "QQQ", input: TrendComponentInput | null | undefined, weight: number): MarketRegimeComponent {
  const detailedScore =
    finite(input?.price) !== null && finite(input?.sma20) !== null && finite(input?.sma50) !== null && finite(input?.change20d) !== null
      ? scoreTrend(input?.price, input?.sma20, input?.sma50, input?.change20d)
      : null;
  const labelScore = scoreTrendLabel(input?.trend);
  const score = detailedScore ?? labelScore;

  if (score === null) {
    return {
      name,
      score: 0,
      weight,
      status: "unavailable",
      reason: `${name} trend data is unavailable.`,
      isAvailable: false
    };
  }

  return {
    name,
    score: round(score),
    weight,
    status: statusFromScore(score),
    reason:
      detailedScore !== null
        ? `${name} trend uses price versus SMA20/SMA50, SMA alignment, and 20-day change.`
        : `${name} trend uses the stored ${input?.trend ?? "neutral"} market-context label.`,
    isAvailable: true
  };
}

function breadthComponent(input: BreadthComponentInput | null | undefined): MarketRegimeComponent {
  const ratio = finite(input?.ratio);
  const score = ratio !== null ? scoreBreadthRatio(ratio) : scoreBreadthStatus(input?.status);

  if (score === null) {
    return {
      name: "BREADTH",
      score: 0,
      weight: DEFAULT_REGIME_WEIGHTS.BREADTH,
      status: "unavailable",
      reason: "Market breadth data is unavailable.",
      isAvailable: false
    };
  }

  return {
    name: "BREADTH",
    score: round(score),
    weight: DEFAULT_REGIME_WEIGHTS.BREADTH,
    status: statusFromScore(score),
    reason:
      ratio !== null
        ? `${(ratio * 100).toFixed(0)}% of the breadth universe is above SMA50.`
        : `Breadth uses the stored ${input?.status ?? "neutral"} market-context label.`,
    isAvailable: true
  };
}

function vixComponent(input: VixComponentInput | null | undefined): MarketRegimeComponent {
  const score = scoreVix(input?.value, input?.dailyChangePercent, input?.condition);

  if (score === null) {
    return {
      name: "VIX",
      score: 0,
      weight: DEFAULT_REGIME_WEIGHTS.VIX,
      status: "unavailable",
      reason: "VIX data is unavailable.",
      isAvailable: false
    };
  }

  return {
    name: "VIX",
    score: round(score),
    weight: DEFAULT_REGIME_WEIGHTS.VIX,
    status: statusFromScore(score),
    reason:
      finite(input?.value) !== null
        ? `VIX is ${input?.value}; higher VIX is scored as worse regime risk.`
        : `VIX uses the stored ${input?.condition ?? "normal"} market-context label.`,
    isAvailable: true
  };
}

export function computeCompositeMarketRegime(input: MarketRegimeInput): CompositeMarketRegime {
  const components = [
    trendComponent("SPY", input.spy, DEFAULT_REGIME_WEIGHTS.SPY),
    trendComponent("QQQ", input.qqq, DEFAULT_REGIME_WEIGHTS.QQQ),
    breadthComponent(input.breadth),
    vixComponent(input.vix)
  ];
  const available = components.filter((component) => component.isAvailable);
  const availableWeight = available.reduce((sum, component) => sum + component.weight, 0);
  const weightedScore = available.reduce((sum, component) => sum + component.score * component.weight, 0);
  let compositeScore = availableWeight > 0 ? weightedScore / availableWeight : 0;
  const vix = input.vix?.value;
  const vixDailyChange = input.vix?.dailyChangePercent;
  const vixStress = (typeof vix === "number" && vix >= 35) || (typeof vixDailyChange === "number" && vixDailyChange >= 15);
  let label = labelFromCompositeScore(compositeScore);

  if (vixStress) {
    compositeScore = Math.min(compositeScore, -0.8);
    label = "stress";
  }

  const warnings = [
    ...(availableWeight < 0.5
      ? ["Market regime confidence is low because some required components are unavailable."]
      : []),
    ...(vixStress ? ["VIX stress condition forces the composite market regime to stress."] : []),
    ...components.filter((component) => !component.isAvailable).map((component) => component.reason)
  ];

  return {
    compositeScore: round(clampUnit(compositeScore)),
    label,
    confidence: round(Math.min(1, Math.max(0, availableWeight))),
    components,
    reasons: components.filter((component) => component.isAvailable).map((component) => component.reason),
    warnings
  };
}

export function marketRegimeScore(compositeRegime: CompositeMarketRegime) {
  return Math.min(100, Math.max(0, Number((50 + compositeRegime.compositeScore * 50).toFixed(1))));
}

export function getRegimeRiskMultiplier(
  compositeRegime: CompositeMarketRegime,
  tradeDirection: "bullish" | "bearish" | "neutral" | string
) {
  const direction = tradeDirection === "bearish" ? "bearish" : tradeDirection === "neutral" ? "neutral" : "bullish";
  const byDirection = {
    bullish: {
      strong_bullish: 1,
      bullish: 0.85,
      neutral: 0.5,
      bearish: 0.35,
      strong_bearish: 0.25,
      stress: 0.15
    },
    bearish: {
      strong_bullish: 0.25,
      bullish: 0.35,
      neutral: 0.5,
      bearish: 0.85,
      strong_bearish: 1,
      stress: 0.75
    },
    neutral: {
      strong_bullish: 0.75,
      bullish: 0.85,
      neutral: 1,
      bearish: 0.85,
      strong_bearish: 0.75,
      stress: 0.5
    }
  } as const;
  const raw = byDirection[direction][compositeRegime.label];

  return compositeRegime.confidence < 0.5 ? Math.min(raw, 0.5) : raw;
}
