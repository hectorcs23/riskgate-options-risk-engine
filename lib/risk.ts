import type { RiskSettings, TradeIdea } from "@prisma/client";
import { analyzeOptionTrade } from "@/lib/options-math";
import { scoreTechnicalSnapshot, type TechnicalSnapshot } from "@/lib/indicators";
import {
  calculateMultiLegMetrics,
  detectNakedShortOptionLegs,
  virtualLegsFromLegacyTrade,
  type OptionLegInput
} from "@/lib/options/multileg";
import {
  monteCarloRiskMultiplier,
  monteCarloScoreAdjustment,
  simulateMonteCarlo
} from "@/lib/options/monteCarlo";
import { computeKellyFromPop, estimateProbabilityOfProfit } from "@/lib/options/pop";
import {
  scoreOptionsQuality as scoreContinuousOptionsQuality,
  type OptionsQualityBreakdown
} from "@/lib/risk/optionsQuality";
import {
  computeCompositeMarketRegime,
  getRegimeRiskMultiplier,
  marketRegimeScore as scoreCompositeMarketRegime,
  type CompositeMarketRegime
} from "@/lib/risk/market-regime";
import { EMPTY_EVENT_RISK, evaluateEventRisk, type RiskEvent } from "@/lib/risk/event-risk";
import { evaluateStrategyChecks, type StrategyDecisionCap } from "@/lib/risk/strategy-checks";
import {
  applyYahooSentimentOverlay,
  type YahooSentimentOverlay,
  type YahooSentimentResult
} from "@/lib/sentiment/yahoo";

export type ScoreDecision = "reject" | "watchlist" | "approved_small" | "approved_normal";

export type RiskExposure = {
  optionsRiskUsed: number;
  monthlyLossUsed: number;
  openOptionsRiskUsed: number;
  concentrationMultiplier?: number;
};

export type TradeInput = Pick<
  TradeIdea,
  | "symbol"
  | "direction"
  | "strategy"
  | "thesis"
  | "catalyst"
  | "invalidationLevel"
  | "expirationDate"
  | "optionContractSymbol"
  | "optionType"
  | "strikePrice"
  | "shortStrikePrice"
  | "contractBid"
  | "contractAsk"
  | "contractMid"
  | "contractDelta"
  | "contractGamma"
  | "contractTheta"
  | "contractVega"
  | "contractRho"
  | "contractImpliedVolatility"
  | "contractUnderlyingPrice"
  | "contractBreakEvenPrice"
  | "contractSnapshotAt"
  | "premiumCost"
  | "maxLoss"
  | "expectedReward"
  | "exitPlan"
  | "spyTrend"
  | "qqqTrend"
  | "vixCondition"
  | "marketBreadth"
  | "macroRisk"
  | "trend"
  | "priceVs20MA"
  | "priceVs50MA"
  | "rsiCondition"
  | "volumeCondition"
  | "supportResistanceQuality"
  | "bidAskSpreadPercent"
  | "optionVolume"
  | "openInterest"
  | "daysToExpiration"
  | "impliedVolatilityRank"
  | "premiumAsPercentOfPortfolio"
  | "isChasing"
> & {
  optionLegs?: OptionLegInput[];
  technicalSnapshot?: TechnicalSnapshot | null;
  yahooSentiment?: YahooSentimentResult | null;
  redditSentiment?: unknown | null;
  earningsEvents?: RiskEvent[];
  macroEvents?: RiskEvent[];
  portfolioHasUnderlying?: boolean;
};

export type ScoreWeights = {
  marketRegime: number;
  technical: number;
  optionsQuality: number;
  tradeQuality: number;
};

export function clamp(value: number, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function qualityAtLeast(value: number, fullCredit: number) {
  if (fullCredit <= 0) return 0;
  return clamp01(Math.sqrt(Math.max(value, 0) / fullCredit));
}

function qualitySpread(spreadPercent: number) {
  if (spreadPercent <= 2) return 1;
  return clamp01(1 / (1 + Math.pow((spreadPercent - 2) / 5, 3)));
}

function qualityDte(daysToExpiration: number) {
  if (daysToExpiration < 5) return 0;
  if (daysToExpiration < 21) return clamp01((daysToExpiration - 5) / 16);
  if (daysToExpiration <= 60) return 1;
  if (daysToExpiration <= 240) return clamp01(1 - (daysToExpiration - 60) / 180);
  return 0;
}

function qualityIvRank(impliedVolatilityRank?: number | null) {
  if (impliedVolatilityRank === null || impliedVolatilityRank === undefined) return 0.65;
  return clamp01(1 - Math.pow(clamp(impliedVolatilityRank, 0, 100) / 100, 2));
}

function qualityPremiumSize(premiumAsPercentOfPortfolio: number) {
  if (premiumAsPercentOfPortfolio <= 0.25) return 1;
  if (premiumAsPercentOfPortfolio <= 1) {
    return clamp01(1 - 0.5 * Math.pow((premiumAsPercentOfPortfolio - 0.25) / 0.75, 2));
  }
  return clamp01(0.5 / (1 + Math.pow(premiumAsPercentOfPortfolio - 1, 2)));
}

function qualityDelta(input: TradeInput) {
  if (input.contractDelta === null || input.contractDelta === undefined) return 0.55;
  const directional =
    (input.direction === "bullish" && input.contractDelta > 0) ||
    (input.direction === "bearish" && input.contractDelta < 0) ||
    input.direction === "neutral";
  if (!directional) return 0;
  return clamp01(1 - Math.abs(Math.abs(input.contractDelta) - 0.4) / 0.28);
}

function qualityGamma(input: TradeInput) {
  if (input.contractGamma === null || input.contractGamma === undefined) return 0.65;
  return clamp01(1 / (1 + Math.pow(Math.abs(input.contractGamma) / 0.06, 2)));
}

function rewardToRisk(input: TradeInput) {
  return input.expectedReward && input.maxLoss > 0 ? input.expectedReward / input.maxLoss : 0;
}

export function scoreMarketRegime(input: TradeInput) {
  return scoreCompositeMarketRegime(compositeMarketRegimeFromInput(input));
}

export function scoreTechnical(input: TradeInput) {
  const calculated = scoreTechnicalSnapshot({
    direction: input.direction,
    snapshot: input.technicalSnapshot,
    manualTrend: input.trend,
    manualPriceVs20MA: input.priceVs20MA,
    manualPriceVs50MA: input.priceVs50MA,
    manualRsiCondition: input.rsiCondition,
    manualVolumeCondition: input.volumeCondition,
    supportResistanceQuality: input.supportResistanceQuality
  });

  if (calculated) return calculated.total;

  let score = 50;

  if (input.trend === "uptrend" && input.direction === "bullish") score += 18;
  if (input.trend === "downtrend" && input.direction === "bearish") score += 18;
  if (input.trend === "sideways" && input.direction === "neutral") score += 12;
  if (input.trend === "uptrend" && input.direction === "bearish") score -= 15;
  if (input.trend === "downtrend" && input.direction === "bullish") score -= 15;
  if (input.priceVs20MA === "above") score += input.direction === "bearish" ? -6 : 8;
  if (input.priceVs50MA === "above") score += input.direction === "bearish" ? -8 : 10;
  if (input.rsiCondition === "oversold" && input.direction === "bullish") score += 8;
  if (input.rsiCondition === "overbought" && input.direction === "bearish") score += 8;
  if (input.rsiCondition === "overbought" && input.direction === "bullish") score -= 8;
  if (input.volumeCondition === "strong") score += 8;
  if (input.volumeCondition === "weak") score -= 8;
  if (input.supportResistanceQuality === "good") score += 10;
  if (input.supportResistanceQuality === "poor") score -= 15;

  return clamp(score);
}

export function getOptionsQualityBreakdown(input: TradeInput, settings?: RiskSettings): OptionsQualityBreakdown {
  const premium =
    input.maxLoss && input.maxLoss > 0
      ? input.maxLoss
      : input.premiumCost && input.premiumCost > 0
        ? input.premiumCost
        : null;
  const derivedPortfolioValue =
    premium && input.premiumAsPercentOfPortfolio > 0
      ? premium / (input.premiumAsPercentOfPortfolio / 100)
      : null;

  return scoreContinuousOptionsQuality({
    spreadPercent: input.bidAskSpreadPercent,
    dte: input.daysToExpiration,
    volume: input.optionVolume,
    openInterest: input.openInterest,
    ivRank: input.impliedVolatilityRank,
    premium,
    portfolioValue: settings?.totalPortfolioValue ?? derivedPortfolioValue,
    theta: input.contractTheta,
    mid: input.contractMid
  });
}

export function scoreOptionsQuality(input: TradeInput, settings?: RiskSettings) {
  return getOptionsQualityBreakdown(input, settings).total;
}

export function scoreTradeQuality(input: TradeInput) {
  const thesisQuality = clamp01(input.thesis.trim().length / 80);
  const catalystQuality = input.catalyst?.trim() ? 1 : 0.35;
  const invalidationQuality = input.invalidationLevel !== null && input.invalidationLevel !== undefined ? 1 : 0;
  const exitQuality = input.exitPlan?.trim() ? clamp01(input.exitPlan.trim().length / 80) : 0;
  const rewardRiskQuality = clamp01(rewardToRisk(input) / 3);
  const chaseQuality = input.isChasing ? 0 : 1;
  const score =
    100 *
    (0.25 * thesisQuality +
      0.1 * catalystQuality +
      0.15 * invalidationQuality +
      0.15 * exitQuality +
      0.2 * rewardRiskQuality +
      0.15 * chaseQuality);

  return clamp(score);
}

function marketTrend(value: string) {
  return value === "bullish" || value === "bearish" ? value : "neutral";
}

function breadthStatus(value: string) {
  return value === "strong" || value === "weak" ? value : "neutral";
}

function vixStatus(value: string) {
  if (value === "low" || value === "elevated" || value === "spiking") return value;
  return "normal";
}

export function compositeMarketRegimeFromInput(input: Pick<TradeInput, "spyTrend" | "qqqTrend" | "vixCondition" | "marketBreadth">): CompositeMarketRegime {
  return computeCompositeMarketRegime({
    spy: { trend: marketTrend(input.spyTrend) },
    qqq: { trend: marketTrend(input.qqqTrend) },
    breadth: { status: breadthStatus(input.marketBreadth) },
    vix: { condition: vixStatus(input.vixCondition) }
  });
}

export function getAdaptiveWeights(input: Pick<TradeInput, "spyTrend" | "qqqTrend" | "vixCondition" | "marketBreadth"> | CompositeMarketRegime): ScoreWeights {
  const label = "label" in input ? input.label : compositeMarketRegimeFromInput(input).label;

  if (label === "stress" || label === "strong_bearish" || label === "bearish") {
    return {
      marketRegime: 0.3,
      technical: 0.2,
      optionsQuality: 0.35,
      tradeQuality: 0.15
    };
  }

  if (label === "strong_bullish" || label === "bullish") {
    return {
      marketRegime: 0.25,
      technical: 0.3,
      optionsQuality: 0.25,
      tradeQuality: 0.2
    };
  }

  return {
    marketRegime: 0.35,
    technical: 0.25,
    optionsQuality: 0.25,
    tradeQuality: 0.15
  };
}

export function weightedScore(input: {
  marketRegimeScore: number;
  technicalScore: number;
  optionsQualityScore: number;
  tradeQualityScore: number;
  weights?: ScoreWeights;
}) {
  const weights =
    input.weights ?? {
      marketRegime: 0.3,
      technical: 0.3,
      optionsQuality: 0.25,
      tradeQuality: 0.15
    };

  return (
    input.marketRegimeScore * weights.marketRegime +
    input.technicalScore * weights.technical +
    input.optionsQualityScore * weights.optionsQuality +
    input.tradeQualityScore * weights.tradeQuality
  );
}

export function getDecision(totalScore: number): ScoreDecision {
  if (totalScore < 60) return "reject";
  if (totalScore < 75) return "watchlist";
  if (totalScore < 85) return "approved_small";
  return "approved_normal";
}

export function getConfidenceMultiplier(totalScore: number) {
  if (totalScore < 75) return 0;
  if (totalScore < 80) return 0.25;
  if (totalScore < 85) return 0.5;
  if (totalScore < 90) return 0.75;
  return 1;
}

export function getLiquidityMultiplier(bidAskSpreadPercent: number) {
  if (bidAskSpreadPercent > 15) return 0;
  if (bidAskSpreadPercent > 10) return 0.25;
  if (bidAskSpreadPercent > 5) return 0.5;
  return 1;
}

export function getMarketRegimeMultiplier(regime: string, direction: string) {
  const compositeRegime = computeCompositeMarketRegime({
    spy: { trend: regime === "bullish" || regime === "bearish" ? regime : "neutral" },
    qqq: null,
    breadth: null,
    vix: null
  });
  return getRegimeRiskMultiplier(compositeRegime, direction);
}

export function getVolatilityMultiplier(impliedVolatilityRank?: number | null) {
  if (impliedVolatilityRank === null || impliedVolatilityRank === undefined) return 1;
  if (impliedVolatilityRank > 80) return 0.25;
  if (impliedVolatilityRank > 60) return 0.5;
  if (impliedVolatilityRank < 20) return 0.75;
  return 1;
}

function uniqueMessages(messages: string[]) {
  return Array.from(new Set(messages.filter(Boolean)));
}

function effectiveOptionLegs(input: TradeInput) {
  if (input.optionLegs?.length) return input.optionLegs;
  return virtualLegsFromLegacyTrade(input);
}

function averageLegValue(legs: OptionLegInput[], key: "impliedVol" | "dte") {
  const values = legs
    .map((leg) => leg[key])
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function deterministicSeed(symbol: string, score: number) {
  return Array.from(symbol).reduce((sum, char) => sum + char.charCodeAt(0), Math.round(score * 100)) || 1;
}

function runMonteCarloOverlay(input: TradeInput, legs: OptionLegInput[], totalScore: number) {
  const underlyingPrice = input.contractUnderlyingPrice;
  const impliedVolatility = averageLegValue(legs, "impliedVol") ?? input.contractImpliedVolatility;
  const dte = averageLegValue(legs, "dte") ?? input.daysToExpiration;

  if (!legs.length || !underlyingPrice || underlyingPrice <= 0 || !impliedVolatility || impliedVolatility <= 0 || !dte || dte <= 0) {
    return null;
  }

  return simulateMonteCarlo({
    underlyingPrice,
    legs,
    impliedVolatility,
    dte,
    simulations: 5000,
    expectedDrift: 0,
    seed: deterministicSeed(input.symbol, totalScore)
  });
}

function applyDecisionCaps(decision: ScoreDecision, caps: Array<StrategyDecisionCap | undefined>) {
  return caps.reduce<ScoreDecision>((current, cap) => {
    if (!cap || current === "reject") return current;
    if (cap === "watchlist" && (current === "approved_small" || current === "approved_normal")) return "watchlist";
    if (cap === "approved_small" && current === "approved_normal") return "approved_small";
    return current;
  }, decision);
}

function decisionCapReason(cap: StrategyDecisionCap | undefined, source: string) {
  if (!cap) return null;
  return `${source} caps the decision at ${cap.replaceAll("_", " ")}.`;
}

export function evaluateTradeIdea(input: TradeInput, settings: RiskSettings, exposure: RiskExposure) {
  const compositeRegime = compositeMarketRegimeFromInput(input);
  const marketRegimeScore = scoreCompositeMarketRegime(compositeRegime);
  const technicalScore = scoreTechnical(input);
  const technicalBreakdown = scoreTechnicalSnapshot({
    direction: input.direction,
    snapshot: input.technicalSnapshot,
    manualTrend: input.trend,
    manualPriceVs20MA: input.priceVs20MA,
    manualPriceVs50MA: input.priceVs50MA,
    manualRsiCondition: input.rsiCondition,
    manualVolumeCondition: input.volumeCondition,
    supportResistanceQuality: input.supportResistanceQuality
  });
  const optionsQualityBreakdown = getOptionsQualityBreakdown(input, settings);
  const optionsQualityScore = optionsQualityBreakdown.total;
  const tradeQualityScore = scoreTradeQuality(input);
  const weights = getAdaptiveWeights(compositeRegime);
  const baseScore = Number(
    weightedScore({ marketRegimeScore, technicalScore, optionsQualityScore, tradeQualityScore, weights }).toFixed(1)
  );
  const optionLegs = effectiveOptionLegs(input);
  const multiLegMetrics = optionLegs.length
    ? calculateMultiLegMetrics({
        legs: optionLegs,
        underlyingPrice: input.contractUnderlyingPrice
      })
    : null;
  const monteCarlo = runMonteCarloOverlay(input, optionLegs, baseScore);
  const monteCarloAdjustment = monteCarlo
    ? monteCarloScoreAdjustment(monteCarlo, multiLegMetrics?.maxLoss ?? input.maxLoss)
    : 0;
  const popEstimate = estimateProbabilityOfProfit({
    strategy: input.strategy,
    direction: input.direction,
    legs: optionLegs,
    spot: input.contractUnderlyingPrice,
    dte: input.daysToExpiration,
    iv: input.contractImpliedVolatility,
    delta: input.contractDelta,
    monteCarloResult: monteCarlo,
    fallbackIvProxy:
      input.impliedVolatilityRank !== null && input.impliedVolatilityRank !== undefined
        ? Math.max(input.impliedVolatilityRank / 100, 0.05)
        : null
  });

  const hardStops: string[] = [];
  if (!input.thesis.trim()) hardStops.push("Written thesis is required before approval.");
  if (input.invalidationLevel === null || input.invalidationLevel === undefined) {
    hardStops.push("Invalidation level is required before approval.");
  }
  const effectiveMaxLoss = multiLegMetrics?.maxLoss ?? input.maxLoss;
  if (!effectiveMaxLoss || effectiveMaxLoss <= 0) hardStops.push("Max loss must be defined before approval.");
  if (!input.exitPlan?.trim()) hardStops.push("Exit plan is required before approval.");
  hardStops.push(...optionsQualityBreakdown.hardStops);
  if (input.optionVolume < 25 && input.openInterest < 100) {
    hardStops.push("Option volume and open interest are both too low.");
  }
  if (multiLegMetrics?.missingPriceData && multiLegMetrics.maxLoss === null) {
    hardStops.push("Missing leg price data prevents max-loss calculation.");
  }
  if (
    ["debit_spread", "bull_call_debit_spread", "bear_put_debit_spread", "protective_put", "collar"].includes(
      input.strategy
    ) &&
    optionLegs.length > 1 &&
    multiLegMetrics?.maxLoss === null
  ) {
    hardStops.push("Undefined max loss for a strategy that should be defined-risk.");
  }
  hardStops.push(...detectNakedShortOptionLegs(optionLegs));
  const thetaToMid =
    input.contractTheta !== null &&
    input.contractTheta !== undefined &&
    input.contractMid !== null &&
    input.contractMid !== undefined &&
    input.contractMid > 0
      ? Math.abs(input.contractTheta) / input.contractMid
      : null;
  const eventRisk =
    settings.eventRiskEnabled === false
      ? EMPTY_EVENT_RISK
      : evaluateEventRisk({
          symbol: input.symbol,
          strategy: input.strategy,
          direction: input.direction,
          expiration: input.expirationDate,
          marketRegimeLabel: compositeRegime.label,
          vixStatus: input.vixCondition,
          earningsEvents: input.earningsEvents,
          macroEvents: input.macroEvents,
          hasNakedShortLeg: detectNakedShortOptionLegs(optionLegs).length > 0
        });
  const effectiveReward = multiLegMetrics?.maxProfit ?? input.expectedReward;
  const strategyChecks = evaluateStrategyChecks({
    strategy: input.strategy,
    direction: input.direction,
    legs: optionLegs,
    spot: input.contractUnderlyingPrice,
    dte: input.daysToExpiration,
    ivRank: input.impliedVolatilityRank,
    thetaPctOfMid: thetaToMid,
    gammaRisk: input.contractGamma,
    rewardRisk: effectiveReward && effectiveMaxLoss && effectiveMaxLoss > 0 ? effectiveReward / effectiveMaxLoss : null,
    breakEven: input.contractBreakEvenPrice,
    maxLoss: effectiveMaxLoss,
    maxProfit: multiLegMetrics?.maxProfit,
    marketRegime: compositeRegime,
    eventRisk,
    portfolioHasUnderlying: input.portfolioHasUnderlying
  });
  const yahooSentiment = input.yahooSentiment ?? null;
  const sentimentOverlay: YahooSentimentOverlay | null =
    settings.enableYahooFinanceSentiment && yahooSentiment
      ? applyYahooSentimentOverlay({
          baseScore: baseScore + strategyChecks.scoreAdjustments + (monteCarlo ? monteCarloAdjustment : 0),
          direction: input.direction,
          sentiment: yahooSentiment
        })
      : null;
  const sentimentAdjustment = sentimentOverlay?.scoreAdjustment ?? 0;
  const totalScore = Number(
    clamp(baseScore + strategyChecks.scoreAdjustments + (monteCarlo ? monteCarloAdjustment : 0) + sentimentAdjustment).toFixed(1)
  );
  const kelly = computeKellyFromPop({
    pop: popEstimate.pop,
    reward: effectiveReward,
    maxLoss: effectiveMaxLoss,
    portfolioValue: settings.totalPortfolioValue
  });

  const initialDecision = getDecision(totalScore);
  const approvalCaps: string[] = [];
  if (input.isChasing) {
    approvalCaps.push("Chasing or extended setup caps the decision at watchlist.");
  }
  if (
    input.impliedVolatilityRank !== null &&
    input.impliedVolatilityRank !== undefined &&
    input.impliedVolatilityRank > 80
  ) {
    approvalCaps.push("IV rank above 80 caps the decision at watchlist.");
  }
  if (
    input.contractImpliedVolatility !== null &&
    input.contractImpliedVolatility !== undefined &&
    input.contractImpliedVolatility > 0.85
  ) {
    approvalCaps.push("Current contract IV above 85% caps the decision at watchlist.");
  }
  if (thetaToMid !== null && thetaToMid > 0.08) {
    approvalCaps.push("Theta is more than 8% of contract mid per day, so approval is capped at watchlist.");
  }
  if (
    input.contractGamma !== null &&
    input.contractGamma !== undefined &&
    Math.abs(input.contractGamma) > 0.08 &&
    input.daysToExpiration < 30
  ) {
    approvalCaps.push("High gamma with less than 30 DTE caps the decision at watchlist.");
  }
  const finalHardStops = uniqueMessages([...hardStops, ...eventRisk.hardStops, ...strategyChecks.hardStops]);
  const finalApprovalCaps = uniqueMessages(approvalCaps);
  const decisionCaps: Array<StrategyDecisionCap | undefined> = [
    finalApprovalCaps.length ? "watchlist" : undefined,
    eventRisk.decisionCap,
    ...strategyChecks.caps,
    sentimentOverlay?.decisionCap,
    popEstimate.source === "unavailable" ? "watchlist" : undefined,
    popEstimate.confidence === "low" ? "approved_small" : undefined
  ];
  const decisionCapReasons = uniqueMessages(
    [
      finalApprovalCaps.length ? "General approval caps limit the decision to watchlist." : null,
      decisionCapReason(eventRisk.decisionCap, "Event risk"),
      ...strategyChecks.caps.map((cap) => decisionCapReason(cap, "Strategy checks")),
      decisionCapReason(sentimentOverlay?.decisionCap, "Yahoo Finance sentiment"),
      popEstimate.source === "unavailable" ? "PoP unavailable caps the decision at watchlist." : null,
      popEstimate.confidence === "low" ? "Low-confidence PoP caps maximum approval at approved small." : null
    ].filter((message): message is string => Boolean(message))
  );
  const cappedDecision = applyDecisionCaps(initialDecision, decisionCaps);
  const decision: ScoreDecision = finalHardStops.length ? "reject" : cappedDecision;
  const confidenceMultiplier = getConfidenceMultiplier(totalScore);
  const liquidityMultiplier = getLiquidityMultiplier(input.bidAskSpreadPercent);
  const marketRegimeMultiplier = getRegimeRiskMultiplier(compositeRegime, input.direction);
  const volatilityMultiplier = getVolatilityMultiplier(input.impliedVolatilityRank);
  const concentrationMultiplier = exposure.concentrationMultiplier ?? 1;
  const analytics = analyzeOptionTrade(input, settings);
  const monteCarloMultiplier = monteCarloRiskMultiplier(monteCarlo, multiLegMetrics?.maxLoss ?? input.maxLoss);
  const sentimentMultiplier = sentimentOverlay?.riskMultiplier ?? 1;
  const multiplierRisk =
    settings.baseRiskPerTradeMXN *
    confidenceMultiplier *
    liquidityMultiplier *
    marketRegimeMultiplier *
    volatilityMultiplier *
    concentrationMultiplier *
    monteCarloMultiplier *
    sentimentMultiplier *
    eventRisk.riskMultiplier;
  const probabilisticKellyRisk = kelly.isDisabled ? 0 : kelly.fractionalKellyRiskCap;
  const uncappedRisk = Math.min(multiplierRisk, probabilisticKellyRisk);
  const remainingOptionsSleeve = Math.max(settings.maxOptionsSleeveMXN - exposure.optionsRiskUsed, 0);
  const remainingMonthlyLossLimit = Math.max(settings.maxMonthlyOptionsLossMXN - exposure.monthlyLossUsed, 0);
  const remainingOpenOptionsRiskLimit = Math.max(settings.maxOpenOptionsRiskMXN - exposure.openOptionsRiskUsed, 0);
  const cappedRisk = Math.min(
    uncappedRisk,
    remainingOptionsSleeve,
    remainingMonthlyLossLimit,
    remainingOpenOptionsRiskLimit
  );
  const suggestedRiskMXN = decision.startsWith("approved") ? Number(cappedRisk.toFixed(0)) : 0;

  const reasons = [
    `Base weighted score: ${baseScore}/100. Final score after overlays: ${totalScore}/100.`,
    `Adaptive weights: market ${(weights.marketRegime * 100).toFixed(0)}%, technical ${(weights.technical * 100).toFixed(0)}%, options ${(weights.optionsQuality * 100).toFixed(0)}%, trade ${(weights.tradeQuality * 100).toFixed(0)}%.`,
    `Composite market regime: ${compositeRegime.label.replaceAll("_", " ")} (${compositeRegime.compositeScore}) with ${(compositeRegime.confidence * 100).toFixed(0)}% confidence.`,
    `Options quality is continuous: spread ${(optionsQualityBreakdown.spreadQuality * 100).toFixed(0)}%, DTE ${(optionsQualityBreakdown.dteQuality * 100).toFixed(0)}%, volume ${(optionsQualityBreakdown.volumeQuality * 100).toFixed(0)}%, open interest ${(optionsQualityBreakdown.openInterestQuality * 100).toFixed(0)}%, IV rank ${(optionsQualityBreakdown.ivRankQuality * 100).toFixed(0)}%, premium ${(optionsQualityBreakdown.premiumSizeQuality * 100).toFixed(0)}%, theta ${(optionsQualityBreakdown.thetaDecayQuality * 100).toFixed(0)}%.`,
    ...(technicalBreakdown
      ? [
          `Technical score uses calculated indicators: trend ${(technicalBreakdown.trendQuality * 100).toFixed(0)}%, MA alignment ${(technicalBreakdown.maAlignmentQuality * 100).toFixed(0)}%, RSI ${(technicalBreakdown.rsiQuality * 100).toFixed(0)}%, volume ${(technicalBreakdown.volumeQuality * 100).toFixed(0)}%, BWAP ${(technicalBreakdown.bwapQuality * 100).toFixed(0)}%, S/R ${(technicalBreakdown.supportResistanceQuality * 100).toFixed(0)}%, ATR ${(technicalBreakdown.atrRiskQuality * 100).toFixed(0)}%.`
        ]
      : ["Technical score used manual labels because a calculated technical snapshot was unavailable."]),
    ...(multiLegMetrics
      ? [
          `Multi-leg metrics: net debit ${multiLegMetrics.netDebit.toFixed(0)}, net credit ${multiLegMetrics.netCredit.toFixed(0)}, max loss ${multiLegMetrics.maxLoss === null ? "undefined" : multiLegMetrics.maxLoss.toFixed(0)}, max profit ${multiLegMetrics.maxProfit === null ? "unlimited/undefined" : multiLegMetrics.maxProfit.toFixed(0)}, breakeven(s) ${multiLegMetrics.breakevens.length ? multiLegMetrics.breakevens.join(", ") : "n/a"}.`
        ]
      : []),
    ...(monteCarlo
      ? [
          `Monte Carlo overlay ${monteCarloAdjustment >= 0 ? "+" : ""}${monteCarloAdjustment}: PoP ${(monteCarlo.probabilityOfProfit * 100).toFixed(1)}%, EV ${monteCarlo.expectedValue.toFixed(0)}, median ${monteCarlo.medianPnL.toFixed(0)}, P5 ${monteCarlo.p5.toFixed(0)}, CVaR95 ${monteCarlo.cvar95.toFixed(0)}.`
        ]
      : ["Monte Carlo overlay unavailable until legs, underlying price, IV, and DTE are present."]),
    ...(settings.enableYahooFinanceSentiment
      ? [
          `Yahoo Finance sentiment overlay ${sentimentAdjustment >= 0 ? "+" : ""}${sentimentAdjustment}; label ${yahooSentiment?.label ?? "low_signal"}, confidence ${yahooSentiment?.confidence ?? 0}.`
        ]
      : ["Yahoo Finance sentiment overlay is off in settings."]),
    ...(input.optionContractSymbol
      ? [
          `Alpaca contract data: ${input.optionContractSymbol}, ${input.optionType ?? "option"} strike ${input.strikePrice ?? "n/a"}, delta ${input.contractDelta?.toFixed(2) ?? "n/a"}, theta ${input.contractTheta?.toFixed(2) ?? "n/a"}, IV ${input.contractImpliedVolatility !== null && input.contractImpliedVolatility !== undefined ? `${(input.contractImpliedVolatility * 100).toFixed(1)}%` : "n/a"}.`
        ]
      : []),
    ...(popEstimate.pop !== null
      ? [
          `PoP ${((popEstimate.pop ?? 0) * 100).toFixed(1)}% from ${popEstimate.source.replaceAll("_", " ")} with ${popEstimate.confidence} confidence.`
        ]
      : ["PoP unavailable. Kelly sizing disabled and approval is capped at watchlist."]),
    `Event risk: ${eventRisk.eventRiskLevel}; earnings crossing ${eventRisk.crossesEarnings ? "yes" : "no"}, macro crossing ${eventRisk.crossesMacroEvent ? "yes" : "no"}, multiplier ${eventRisk.riskMultiplier}.`,
    `Strategy checks: adjustment ${strategyChecks.scoreAdjustments >= 0 ? "+" : ""}${strategyChecks.scoreAdjustments}, ${strategyChecks.hardStops.length} hard stop(s), ${strategyChecks.caps.length} cap(s).`,
    ...(analytics.var95MXN !== null
      ? [`One-day VaR95 ${analytics.var95MXN.toFixed(0)} MXN, CVaR95 ${analytics.cvar95MXN?.toFixed(0) ?? "n/a"} MXN.`]
      : []),
    `Risk formula: ${settings.baseRiskPerTradeMXN} x confidence ${confidenceMultiplier} x liquidity ${liquidityMultiplier} x regime ${marketRegimeMultiplier} x volatility ${volatilityMultiplier} x concentration ${concentrationMultiplier} x Monte Carlo ${monteCarloMultiplier} x sentiment ${sentimentMultiplier} x event ${eventRisk.riskMultiplier}.`,
    ...(kelly.isDisabled
      ? ["Kelly sizing disabled because PoP is unavailable or payoff inputs are incomplete."]
      : [
          `Kelly cap: PoP ${(popEstimate.pop! * 100).toFixed(1)}%, payoff ratio ${kelly.payoffRatio?.toFixed(2) ?? "n/a"}x, quarter-Kelly risk ${kelly.fractionalKellyRiskCap.toFixed(0)} MXN.`
        ]),
    ...decisionCapReasons,
    ...(analytics.expectedValueMXN !== null
      ? [
          `EV ${analytics.expectedValueMXN.toFixed(0)} MXN using options-derived PoP and declared payoff inputs.`
        ]
      : []),
    `Remaining caps: options sleeve ${remainingOptionsSleeve.toFixed(0)} MXN, monthly loss ${remainingMonthlyLossLimit.toFixed(0)} MXN, open risk ${remainingOpenOptionsRiskLimit.toFixed(0)} MXN.`
  ];

  const warnings = [
    ...finalHardStops,
    ...finalApprovalCaps,
    ...decisionCapReasons,
    ...optionsQualityBreakdown.warnings,
    ...(technicalBreakdown?.warnings ?? []),
    ...(multiLegMetrics?.warnings ?? []),
    ...compositeRegime.warnings,
    ...popEstimate.warnings,
    ...kelly.warnings,
    ...eventRisk.eventWarnings,
    ...strategyChecks.warnings,
    ...(sentimentOverlay?.warnings ?? []),
    ...(input.isChasing ? ["Trade is marked as chasing."] : []),
    ...(effectiveMaxLoss > suggestedRiskMXN && suggestedRiskMXN > 0
      ? ["Planned max loss is above suggested risk size."]
      : []),
    ...(monteCarlo && monteCarlo.expectedValue < 0 ? ["Monte Carlo EV is negative under current IV assumptions."] : []),
    ...(monteCarlo && multiLegMetrics?.maxLoss && Math.abs(monteCarlo.cvar95) >= multiLegMetrics.maxLoss * 0.85
      ? ["Monte Carlo tail risk is high relative to max loss."]
      : []),
    ...(monteCarlo && monteCarlo.probabilityOfProfit < 0.35
      ? ["Payoff depends on a low-probability favorable move under current assumptions."]
      : []),
    ...(thetaToMid !== null && thetaToMid > 0.08 ? ["Theta decay is high relative to contract mid price."] : []),
    ...(input.contractDelta !== null &&
    input.contractDelta !== undefined &&
    input.direction === "bullish" &&
    input.contractDelta < 0
      ? ["Selected contract delta is negative for a bullish setup."]
      : []),
    ...(input.contractDelta !== null &&
    input.contractDelta !== undefined &&
    input.direction === "bearish" &&
    input.contractDelta > 0
      ? ["Selected contract delta is positive for a bearish setup."]
      : []),
    ...analytics.warnings
  ];

  return {
    marketRegimeScore,
    technicalScore,
    optionsQualityScore,
    tradeQualityScore,
    totalScore,
    decision,
    suggestedRiskMXN,
    reasons,
    warnings: uniqueMessages(warnings),
    analytics,
    optionsQualityBreakdown,
    technicalBreakdown,
    multiLegMetrics,
    monteCarlo,
    compositeRegime,
    popEstimate,
    kelly,
    eventRisk,
    strategyChecks,
    yahooSentiment,
    yahooSentimentOverlay: sentimentOverlay
  };
}
