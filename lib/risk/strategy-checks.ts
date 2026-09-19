import {
  calculateMultiLegMetrics,
  detectNakedShortOptionLegs,
  optionLegPremium,
  type OptionLegInput,
  type StockLegInput
} from "@/lib/options/multileg";
import type { CompositeMarketRegime } from "@/lib/risk/market-regime";
import type { EventRiskResult } from "@/lib/risk/event-risk";

export type StrategyDecisionCap = "watchlist" | "approved_small";

export type StrategyCheckResult = {
  hardStops: string[];
  caps: StrategyDecisionCap[];
  warnings: string[];
  scoreAdjustments: number;
};

export type StrategyCheckInput = {
  strategy: string;
  direction: "bullish" | "bearish" | "neutral" | string;
  legs: OptionLegInput[];
  spot?: number | null;
  dte?: number | null;
  ivRank?: number | null;
  thetaPctOfMid?: number | null;
  gammaRisk?: number | null;
  rewardRisk?: number | null;
  breakEven?: number | null;
  maxLoss?: number | null;
  maxProfit?: number | null;
  marketRegime?: CompositeMarketRegime | null;
  eventRisk?: EventRiskResult | null;
  portfolioHasUnderlying?: boolean;
};

function emptyResult(): StrategyCheckResult {
  return {
    hardStops: [],
    caps: [],
    warnings: [],
    scoreAdjustments: 0
  };
}

function safe(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sameExpiration(left: OptionLegInput, right: OptionLegInput) {
  return left.expirationDate.toISOString().slice(0, 10) === right.expirationDate.toISOString().slice(0, 10);
}

function oneLong(legs: OptionLegInput[], optionType: "call" | "put") {
  return legs.find((leg) => leg.optionType === optionType && leg.side === "long") ?? null;
}

function oneShort(legs: OptionLegInput[], optionType: "call" | "put") {
  return legs.find((leg) => leg.optionType === optionType && leg.side === "short") ?? null;
}

function stockCoverage(input: StrategyCheckInput): StockLegInput | null {
  const spot = safe(input.spot);
  if (!input.portfolioHasUnderlying || spot === null || spot <= 0) return null;
  return {
    side: "long",
    quantity: 100,
    entryPrice: spot
  };
}

function addGeneralChecks(input: StrategyCheckInput, result: StrategyCheckResult) {
  if (!input.legs.length) {
    result.hardStops.push("Strategy requires at least one option leg.");
    return;
  }

  for (const leg of input.legs) {
    if (!leg.optionType || !leg.side || !leg.strike || !leg.expirationDate) {
      result.hardStops.push("All option legs require type, side, strike, and expiration.");
    }
    if (leg.spreadPercent !== null && leg.spreadPercent !== undefined && leg.spreadPercent > 15) {
      result.hardStops.push("Option leg bid/ask spread is above 15%.");
    } else if (leg.spreadPercent !== null && leg.spreadPercent !== undefined && leg.spreadPercent > 10) {
      result.warnings.push("Option leg bid/ask spread is wide.");
    }
    if ((leg.volume ?? 100) < 25 && (leg.openInterest ?? 100) < 100) {
      result.hardStops.push("Option leg volume and open interest are both too low.");
    }
  }

  const dte = safe(input.dte) ?? Math.min(...input.legs.map((leg) => leg.dte ?? Number.POSITIVE_INFINITY));
  if (Number.isFinite(dte)) {
    if (dte < 5) result.hardStops.push("DTE is below 5 days.");
    else if (dte < 14) result.warnings.push("DTE is short; gamma and theta risk are elevated.");
  }

  result.hardStops.push(...detectNakedShortOptionLegs(input.legs, stockCoverage(input)));
}

function genericStrategyChecks(input: StrategyCheckInput) {
  const result = emptyResult();
  addGeneralChecks(input, result);
  return result;
}

function checkDirectionalLong(input: StrategyCheckInput, optionType: "call" | "put") {
  const result = emptyResult();
  addGeneralChecks(input, result);
  const label = optionType === "call" ? "Long call" : "Long put";
  const desiredDirection = optionType === "call" ? "bullish" : "bearish";

  if (!input.legs.some((leg) => leg.optionType === optionType && leg.side === "long")) {
    result.hardStops.push(`${label} requires one long ${optionType} leg.`);
  }

  if ((safe(input.dte) ?? 999) < 14) {
    result.warnings.push(`${label} has very short DTE; theta decay may dominate.`);
  }

  if ((safe(input.ivRank) ?? 0) > 80) {
    result.caps.push("watchlist");
    result.warnings.push(`${label} has very high IV rank; consider IV crush risk.`);
  }

  if ((safe(input.thetaPctOfMid) ?? 0) > 0.08) {
    result.caps.push("watchlist");
    result.warnings.push("Daily theta exceeds 8% of option mid price.");
  }

  if ((safe(input.rewardRisk) ?? 99) < 1.5) {
    result.warnings.push(`Reward/risk is weak for a directional ${label.toLowerCase()}.`);
  }

  if (
    optionType === "call" &&
    ["bearish", "strong_bearish", "stress"].includes(input.marketRegime?.label ?? "")
  ) {
    result.warnings.push("Bullish long call is not aligned with current composite market regime.");
    result.scoreAdjustments -= 3;
  }

  if (
    optionType === "put" &&
    ["strong_bullish", "bullish"].includes(input.marketRegime?.label ?? "")
  ) {
    result.warnings.push("Bearish long put is fighting a bullish composite market regime.");
    result.scoreAdjustments -= 3;
  }

  if (input.direction !== desiredDirection && input.direction !== "neutral") {
    result.warnings.push(`${label} direction does not match the selected trade direction.`);
  }

  return result;
}

function checkBullCallDebitSpread(input: StrategyCheckInput) {
  const result = emptyResult();
  addGeneralChecks(input, result);
  const calls = input.legs.filter((leg) => leg.optionType === "call");
  const longCall = oneLong(calls, "call");
  const shortCall = oneShort(calls, "call");

  if (calls.length !== 2 || !longCall || !shortCall) {
    result.hardStops.push("Bull call debit spread requires two complete call legs.");
    return result;
  }

  if (!sameExpiration(longCall, shortCall)) {
    result.hardStops.push("Bull call debit spread legs must use the same expiration.");
  }

  if (shortCall.strike <= longCall.strike) {
    result.hardStops.push("Bull call debit spread short strike must be above long strike.");
  }

  const metrics = calculateMultiLegMetrics({ legs: calls, underlyingPrice: input.spot });
  if (metrics.netDebit <= 0) {
    result.hardStops.push("Bull call debit spread must be entered for a net debit.");
  }

  const maxLoss = safe(input.maxLoss) ?? metrics.maxLoss;
  const maxProfit = safe(input.maxProfit) ?? metrics.maxProfit;
  if (maxLoss !== null && maxLoss > 0 && maxProfit !== null && maxProfit / maxLoss < 1) {
    result.warnings.push("Debit spread has weak reward/risk.");
  }

  const width = Math.abs(shortCall.strike - longCall.strike);
  if (width < 2 || (longCall.spreadPercent ?? 0) + (shortCall.spreadPercent ?? 0) > 20) {
    result.warnings.push("Spread width may be too narrow after transaction costs.");
  }

  return result;
}

function checkBearPutDebitSpread(input: StrategyCheckInput) {
  const result = emptyResult();
  addGeneralChecks(input, result);
  const puts = input.legs.filter((leg) => leg.optionType === "put");
  const longPut = oneLong(puts, "put");
  const shortPut = oneShort(puts, "put");

  if (puts.length !== 2 || !longPut || !shortPut) {
    result.hardStops.push("Bear put debit spread requires two complete put legs.");
    return result;
  }

  if (!sameExpiration(longPut, shortPut)) {
    result.hardStops.push("Bear put debit spread legs must use the same expiration.");
  }

  if (shortPut.strike >= longPut.strike) {
    result.hardStops.push("Bear put debit spread short strike must be below long strike.");
  }

  const metrics = calculateMultiLegMetrics({ legs: puts, underlyingPrice: input.spot });
  if (metrics.netDebit <= 0) {
    result.hardStops.push("Bear put debit spread must be entered for a net debit.");
  }

  const maxLoss = safe(input.maxLoss) ?? metrics.maxLoss;
  const maxProfit = safe(input.maxProfit) ?? metrics.maxProfit;
  if (maxLoss !== null && maxLoss > 0 && maxProfit !== null && maxProfit / maxLoss < 1) {
    result.warnings.push("Debit spread has weak reward/risk.");
  }

  return result;
}

function checkProtectivePut(input: StrategyCheckInput) {
  const result = emptyResult();
  addGeneralChecks(input, result);
  const put = oneLong(input.legs, "put");

  if (!put) {
    result.hardStops.push("Protective put requires one long put leg.");
  }

  if (!input.portfolioHasUnderlying) {
    result.warnings.push("Protective put selected, but no underlying position was detected.");
    result.caps.push("watchlist");
  }

  const spot = safe(input.spot);
  const putCost = put ? optionLegPremium(put) : null;
  const protectedNotional = spot !== null ? spot * 100 : null;
  if (putCost !== null && protectedNotional !== null && (putCost * 100) / protectedNotional > 0.05) {
    result.warnings.push("Protective put cost exceeds 5% of protected notional.");
  }

  return result;
}

function checkCollar(input: StrategyCheckInput) {
  const result = emptyResult();
  addGeneralChecks(input, result);
  const longPut = oneLong(input.legs, "put");
  const shortCall = oneShort(input.legs, "call");
  const spot = safe(input.spot);

  if (!input.portfolioHasUnderlying) {
    result.hardStops.push("Collar requires an underlying position.");
  }

  if (!longPut || !shortCall) {
    result.hardStops.push("Collar requires one long put and one short call.");
    return result;
  }

  if (!sameExpiration(longPut, shortCall)) {
    result.warnings.push("Collar legs usually should share the same expiration.");
  }

  if (spot !== null) {
    if (shortCall.strike <= spot * 1.03) {
      result.warnings.push("Collar gives up upside very close to current spot.");
    }
    if (longPut.strike >= spot) {
      result.warnings.push("Collar long put strike is at or above current spot; confirm hedge intent and cost.");
    }
  }

  return result;
}

export function evaluateStrategyChecks(input: StrategyCheckInput): StrategyCheckResult {
  switch (input.strategy) {
    case "long_call":
      return checkDirectionalLong(input, "call");
    case "long_put":
      return checkDirectionalLong(input, "put");
    case "bull_call_debit_spread":
      return checkBullCallDebitSpread(input);
    case "bear_put_debit_spread":
      return checkBearPutDebitSpread(input);
    case "protective_put":
      return checkProtectivePut(input);
    case "collar":
      return checkCollar(input);
    default:
      return genericStrategyChecks(input);
  }
}
