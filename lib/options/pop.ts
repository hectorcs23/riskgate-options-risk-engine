import type { OptionLegInput } from "@/lib/options/multileg";
import type { MonteCarloResult } from "@/lib/options/monteCarlo";

export type PopSource = "monte_carlo" | "lognormal_iv" | "delta_proxy" | "iv_proxy" | "unavailable";
export type PopConfidence = "high" | "medium" | "low";

export type PopEstimate = {
  pop: number | null;
  source: PopSource;
  confidence: PopConfidence;
  warnings: string[];
  inputsUsed: {
    iv?: number | null;
    delta?: number | null;
    dte?: number | null;
    spot?: number | null;
    strike?: number | null;
    monteCarloPaths?: number | null;
  };
};

export type KellyFromPop = {
  payoffRatio: number | null;
  fullKellyFraction: number | null;
  fractionalKellyFraction: number | null;
  fractionalKellyRiskCap: number;
  isDisabled: boolean;
  warnings: string[];
};

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function safeNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

function normalCdf(value: number) {
  return 0.5 * (1 + erf(value / Math.sqrt(2)));
}

function primaryLeg(legs: OptionLegInput[]) {
  return legs.find((leg) => leg.side === "long") ?? legs[0] ?? null;
}

function signedNetDelta(legs: OptionLegInput[]) {
  const deltas = legs
    .map((leg) => {
      const delta = safeNumber(leg.delta);
      if (delta === null) return null;
      return (leg.side === "long" ? 1 : -1) * delta * Math.max(Math.trunc(leg.quantity || 1), 1);
    })
    .filter((value): value is number => value !== null);

  if (!deltas.length) return null;
  return deltas.reduce((sum, value) => sum + value, 0);
}

function lognormalProbability(input: {
  direction: string;
  optionType?: string | null;
  spot: number;
  strike: number;
  dte: number;
  iv: number;
}) {
  if (input.spot <= 0 || input.strike <= 0 || input.dte <= 0 || input.iv <= 0) return null;
  const tau = Math.max(input.dte / 365, 1 / 365);
  const z = (Math.log(input.strike / input.spot) - -0.5 * input.iv * input.iv * tau) / (input.iv * Math.sqrt(tau));
  const optionType = input.optionType === "put" ? "put" : input.optionType === "call" ? "call" : null;

  if (input.direction === "bearish" || optionType === "put") return clamp01(normalCdf(z));
  if (input.direction === "bullish" || optionType === "call") return clamp01(1 - normalCdf(z));
  return null;
}

export function estimateProbabilityOfProfit(input: {
  strategy: string;
  direction: "bullish" | "bearish" | "neutral" | string;
  legs: OptionLegInput[];
  spot?: number | null;
  dte?: number | null;
  iv?: number | null;
  delta?: number | null;
  monteCarloResult?: MonteCarloResult | null;
  fallbackIvProxy?: number | null;
}): PopEstimate {
  const warnings: string[] = [];
  const leg = primaryLeg(input.legs);
  const spot = safeNumber(input.spot);
  const dte = safeNumber(input.dte) ?? safeNumber(leg?.dte);
  const iv = safeNumber(input.iv) ?? safeNumber(leg?.impliedVol);
  const strike = safeNumber(leg?.strike);
  const delta = safeNumber(input.delta) ?? safeNumber(leg?.delta);
  const monteCarlo = input.monteCarloResult;

  if (
    input.legs.length > 1 &&
    monteCarlo &&
    monteCarlo.simulations > 0 &&
    Number.isFinite(monteCarlo.probabilityOfProfit)
  ) {
    return {
      pop: clamp01(monteCarlo.probabilityOfProfit),
      source: "monte_carlo",
      confidence: "high",
      warnings,
      inputsUsed: {
        iv,
        delta,
        dte,
        spot,
        strike,
        monteCarloPaths: monteCarlo.simulations
      }
    };
  }

  if (spot !== null && strike !== null && dte !== null && iv !== null) {
    const pop = lognormalProbability({
      direction: input.direction,
      optionType: leg?.optionType,
      spot,
      strike,
      dte,
      iv
    });

    if (pop !== null) {
      return {
        pop,
        source: "lognormal_iv",
        confidence: "high",
        warnings,
        inputsUsed: { iv, delta, dte, spot, strike, monteCarloPaths: null }
      };
    }
  }

  const netDelta = input.legs.length > 1 ? signedNetDelta(input.legs) : null;
  const deltaForProxy = netDelta ?? delta;
  if (deltaForProxy !== null) {
    if (input.legs.length > 1) {
      warnings.push("PoP uses approximate net delta because Monte Carlo and lognormal IV inputs are incomplete.");
    }

    return {
      pop: clamp01(Math.abs(deltaForProxy)),
      source: "delta_proxy",
      confidence: "medium",
      warnings,
      inputsUsed: { iv, delta: deltaForProxy, dte, spot, strike, monteCarloPaths: null }
    };
  }

  const ivProxy = safeNumber(input.fallbackIvProxy);
  if (spot !== null && strike !== null && dte !== null && ivProxy !== null) {
    const pop = lognormalProbability({
      direction: input.direction,
      optionType: leg?.optionType,
      spot,
      strike,
      dte,
      iv: ivProxy
    });

    if (pop !== null) {
      return {
        pop,
        source: "iv_proxy",
        confidence: "low",
        warnings: ["PoP uses a calibrated IV proxy because real IV is unavailable."],
        inputsUsed: { iv: ivProxy, delta, dte, spot, strike, monteCarloPaths: null }
      };
    }
  }

  return {
    pop: null,
    source: "unavailable",
    confidence: "low",
    warnings: ["Probability of profit is unavailable because required options inputs are missing."],
    inputsUsed: { iv, delta, dte, spot, strike, monteCarloPaths: null }
  };
}

export function computeKellyFromPop(input: {
  pop: number | null;
  reward?: number | null;
  maxLoss?: number | null;
  portfolioValue?: number | null;
  fractionalKelly?: number;
}): KellyFromPop {
  const pop = safeNumber(input.pop);
  const reward = safeNumber(input.reward);
  const maxLoss = safeNumber(input.maxLoss);
  const portfolioValue = safeNumber(input.portfolioValue);
  const fraction = input.fractionalKelly ?? 0.25;

  if (pop === null || reward === null || maxLoss === null || reward <= 0 || maxLoss <= 0 || portfolioValue === null) {
    return {
      payoffRatio: null,
      fullKellyFraction: null,
      fractionalKellyFraction: null,
      fractionalKellyRiskCap: 0,
      isDisabled: true,
      warnings: ["Kelly sizing disabled because PoP is unavailable or payoff inputs are incomplete."]
    };
  }

  const payoffRatio = reward / maxLoss;
  const fullKelly = Math.max((pop * payoffRatio - (1 - pop)) / payoffRatio, 0);
  const fractionalKelly = fullKelly * fraction;

  return {
    payoffRatio,
    fullKellyFraction: fullKelly,
    fractionalKellyFraction: fractionalKelly,
    fractionalKellyRiskCap: portfolioValue * fractionalKelly,
    isDisabled: false,
    warnings: fractionalKelly === 0 ? ["Kelly fraction is zero; the probabilistic edge is not positive."] : []
  };
}
