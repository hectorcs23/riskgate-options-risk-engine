import type { RiskSettings } from "@prisma/client";
import type { TradeInput } from "@/lib/risk";
import { computeKellyFromPop, estimateProbabilityOfProfit, type PopEstimate } from "@/lib/options/pop";
import { virtualLegsFromLegacyTrade } from "@/lib/options/multileg";

export type OptionAnalytics = {
  probabilityOfProfit: number | null;
  popEstimate: PopEstimate;
  expectedValueMXN: number | null;
  payoffRatio: number | null;
  kellyFraction: number | null;
  kellyRiskMXN: number | null;
  kellyDisabled: boolean;
  deltaExposure: number;
  gammaExposure: number;
  thetaDailyMXN: number;
  vegaExposure: number;
  var95MXN: number | null;
  cvar95MXN: number | null;
  methodNotes: string[];
  warnings: string[];
};

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function erf(value: number) {
  const sign = value >= 0 ? 1 : -1;
  const x = Math.abs(value);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x));

  return sign * y;
}

export function normalCdf(value: number) {
  return 0.5 * (1 + erf(value / Math.sqrt(2)));
}

function normalPdf(value: number) {
  return Math.exp(-0.5 * value * value) / Math.sqrt(2 * Math.PI);
}

function safeNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function yearsToExpiration(input: TradeInput) {
  if (input.daysToExpiration > 0) return Math.max(input.daysToExpiration / 365, 1 / 365);
  if (!input.contractSnapshotAt) return null;
  return null;
}

function optionPremium(input: TradeInput) {
  return safeNumber(input.contractMid) ?? safeNumber(input.premiumCost ? input.premiumCost / 100 : null);
}

function probabilityOfProfit(input: TradeInput) {
  const s0 = safeNumber(input.contractUnderlyingPrice);
  const k = safeNumber(input.strikePrice);
  const premium = optionPremium(input);
  const sigma = safeNumber(input.contractImpliedVolatility);
  const tau = yearsToExpiration(input);
  const optionType = input.optionType ?? (input.strategy.includes("put") ? "put" : "call");

  if (!s0 || !k || premium === null || !sigma || !tau || sigma <= 0) return null;

  const breakEven = optionType === "put" ? k - premium : k + premium;
  if (breakEven <= 0) return null;

  const z = (Math.log(breakEven / s0) - (-0.5 * sigma * sigma) * tau) / (sigma * Math.sqrt(tau));
  return optionType === "put" ? clamp01(normalCdf(z)) : clamp01(1 - normalCdf(z));
}

function inferredReward(input: TradeInput) {
  const explicit = safeNumber(input.expectedReward);
  if (explicit && explicit > 0) return explicit;

  const maxLoss = safeNumber(input.maxLoss);
  const longStrike = safeNumber(input.strikePrice);
  const shortStrike = safeNumber(input.shortStrikePrice);
  const premium = optionPremium(input);

  if (maxLoss && longStrike && shortStrike && premium !== null) {
    const width = Math.abs(shortStrike - longStrike) * 100;
    return Math.max(width - maxLoss, 0);
  }

  return null;
}

function expectedValue(input: TradeInput, pop: number | null) {
  const maxLoss = safeNumber(input.maxLoss);
  const reward = inferredReward(input);
  if (pop === null || !maxLoss || maxLoss <= 0 || !reward || reward <= 0) return null;
  return pop * reward - (1 - pop) * maxLoss;
}

function kelly(input: TradeInput, pop: number | null, settings: RiskSettings) {
  const reward = inferredReward(input);
  const result = computeKellyFromPop({
    pop,
    reward,
    maxLoss: input.maxLoss,
    portfolioValue: settings.totalPortfolioValue
  });

  return {
    payoffRatio: result.payoffRatio,
    kellyFraction: result.isDisabled ? null : result.fractionalKellyFraction,
    kellyRiskMXN: result.isDisabled ? null : result.fractionalKellyRiskCap,
    kellyDisabled: result.isDisabled,
    warnings: result.warnings
  };
}

function greekExposure(input: TradeInput) {
  const quantity = 1;
  const multiplier = 100 * quantity;
  return {
    deltaExposure: (safeNumber(input.contractDelta) ?? 0) * multiplier,
    gammaExposure: (safeNumber(input.contractGamma) ?? 0) * multiplier,
    thetaDailyMXN: (safeNumber(input.contractTheta) ?? 0) * multiplier,
    vegaExposure: (safeNumber(input.contractVega) ?? 0) * multiplier
  };
}

function varCvar(input: TradeInput) {
  const s0 = safeNumber(input.contractUnderlyingPrice);
  const sigma = safeNumber(input.contractImpliedVolatility);
  const delta = safeNumber(input.contractDelta);
  const gamma = safeNumber(input.contractGamma);
  const theta = safeNumber(input.contractTheta);
  const vega = safeNumber(input.contractVega);
  const maxLoss = safeNumber(input.maxLoss);

  if (!s0 || !sigma || delta === null || sigma <= 0) {
    return {
      var95MXN: maxLoss ?? null,
      cvar95MXN: maxLoss ?? null
    };
  }

  const dailyMove = s0 * (sigma / Math.sqrt(252));
  const deltaStd = Math.abs(delta * 100 * dailyMove);
  const gammaShock = Math.abs((gamma ?? 0) * 100 * dailyMove * dailyMove * 0.5);
  const thetaLoss = Math.abs((theta ?? 0) * 100);
  const vegaShock = Math.abs((vega ?? 0) * 100 * sigma * 0.1);
  const stdProxy = deltaStd + gammaShock + vegaShock;
  const z95 = 1.645;
  const var95 = stdProxy * z95 + thetaLoss;
  const cvar95 = stdProxy * (normalPdf(z95) / 0.05) + thetaLoss;

  return {
    var95MXN: maxLoss ? Math.min(var95, maxLoss) : var95,
    cvar95MXN: maxLoss ? Math.min(cvar95, maxLoss) : cvar95
  };
}

export function analyzeOptionTrade(input: TradeInput, settings: RiskSettings): OptionAnalytics {
  const optionLegs = input.optionLegs?.length ? input.optionLegs : virtualLegsFromLegacyTrade(input);
  const popEstimate = estimateProbabilityOfProfit({
    strategy: input.strategy,
    direction: input.direction,
    legs: optionLegs,
    spot: input.contractUnderlyingPrice,
    dte: input.daysToExpiration,
    iv: input.contractImpliedVolatility,
    delta: input.contractDelta,
    fallbackIvProxy:
      input.impliedVolatilityRank !== null && input.impliedVolatilityRank !== undefined
        ? Math.max(input.impliedVolatilityRank / 100, 0.05)
        : null
  });
  const pop = popEstimate.pop;
  const ev = expectedValue(input, pop);
  const kellyValues = kelly(input, pop, settings);
  const greekValues = greekExposure(input);
  const tailRisk = varCvar(input);
  const methodNotes = [
    pop !== null
      ? `PoP source is ${popEstimate.source.replaceAll("_", " ")} with ${popEstimate.confidence} confidence.`
      : "PoP unavailable until options-derived probability inputs are present.",
    ev !== null
      ? "EV uses PoP with your declared expected reward and max loss."
      : "EV unavailable until PoP, expected reward, and max loss are present.",
    kellyValues.kellyRiskMXN !== null
      ? "Kelly is quarter-Kelly using PoP and reward/loss ratio."
      : "Kelly unavailable until PoP and reward/loss ratio are present."
  ];
  const warnings = [
    ...(ev !== null && ev < 0 ? ["Expected value is negative under the current PoP/reward/loss inputs."] : []),
    ...popEstimate.warnings,
    ...kellyValues.warnings
  ];

  return {
    probabilityOfProfit: pop,
    popEstimate,
    expectedValueMXN: ev,
    ...kellyValues,
    ...greekValues,
    ...tailRisk,
    methodNotes,
    warnings
  };
}

export function aggregateOptionAnalytics(
  ideas: Array<Pick<TradeInput, "contractDelta" | "contractGamma" | "contractTheta" | "contractVega" | "maxLoss" | "contractUnderlyingPrice" | "contractImpliedVolatility"> & { status: string; decision: string | null }>
) {
  const active = ideas.filter((idea) => idea.status === "entered" || idea.decision?.startsWith("approved"));
  const deltaExposure = active.reduce((sum, idea) => sum + (safeNumber(idea.contractDelta) ?? 0) * 100, 0);
  const gammaExposure = active.reduce((sum, idea) => sum + (safeNumber(idea.contractGamma) ?? 0) * 100, 0);
  const thetaDailyMXN = active.reduce((sum, idea) => sum + (safeNumber(idea.contractTheta) ?? 0) * 100, 0);
  const vegaExposure = active.reduce((sum, idea) => sum + (safeNumber(idea.contractVega) ?? 0) * 100, 0);
  const maxLoss = active.reduce((sum, idea) => sum + (safeNumber(idea.maxLoss) ?? 0), 0);
  const tailRisks = active.map((idea) =>
    varCvar({
      ...idea,
      symbol: "",
      direction: "",
      strategy: "",
      thesis: "",
      catalyst: null,
      invalidationLevel: null,
      expirationDate: null,
      optionContractSymbol: null,
      optionType: null,
      strikePrice: null,
      shortStrikePrice: null,
      contractBid: null,
      contractAsk: null,
      contractMid: null,
      contractRho: null,
      contractBreakEvenPrice: null,
      contractSnapshotAt: null,
      premiumCost: null,
      expectedReward: null,
      exitPlan: null,
      spyTrend: "neutral",
      qqqTrend: "neutral",
      vixCondition: "normal",
      marketBreadth: "neutral",
      macroRisk: "medium",
      trend: "sideways",
      priceVs20MA: "above",
      priceVs50MA: "above",
      rsiCondition: "neutral",
      volumeCondition: "normal",
      supportResistanceQuality: "average",
      bidAskSpreadPercent: 0,
      optionVolume: 0,
      openInterest: 0,
      daysToExpiration: 30,
      impliedVolatilityRank: null,
      premiumAsPercentOfPortfolio: 0,
      isChasing: false
    })
  );

  return {
    activeCount: active.length,
    deltaExposure,
    gammaExposure,
    thetaDailyMXN,
    vegaExposure,
    maxLoss,
    var95MXN: tailRisks.reduce((sum, item) => sum + (item.var95MXN ?? 0), 0),
    cvar95MXN: tailRisks.reduce((sum, item) => sum + (item.cvar95MXN ?? 0), 0)
  };
}
