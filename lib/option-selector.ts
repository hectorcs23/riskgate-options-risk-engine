import { alpacaConfigured, fetchAlpacaOptionChain, type AlpacaOptionContract, type OptionType } from "@/lib/alpaca-options";

export type OptionContractSelection = {
  contract: AlpacaOptionContract;
  shortContract: AlpacaOptionContract | null;
  strategy: "long_option" | "debit_spread";
  score: number;
  dte: number | null;
  netMid: number | null;
  netDelta: number | null;
  netGamma: number | null;
  netTheta: number | null;
  netVega: number | null;
  netRho: number | null;
  netSpreadPercent: number | null;
  width: number | null;
  thetaRatio: number | null;
  reasons: string[];
  warnings: string[];
};

type SelectionInput = {
  symbol: string;
  direction: string;
  underlyingPrice?: number | null;
  maxDebit?: number | null;
};

function clamp(value: number, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}

export function optionContractDte(expirationDate: string | null | undefined, now = new Date()) {
  if (!expirationDate) return null;
  const expiration = new Date(`${expirationDate}T00:00:00`);
  if (Number.isNaN(expiration.getTime())) return null;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.max(Math.ceil((expiration.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)), 0);
}

function dateAfterDays(days: number, now = new Date()) {
  const target = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  return `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}-${String(
    target.getDate()
  ).padStart(2, "0")}`;
}

function scoreDelta(contract: AlpacaOptionContract, type: OptionType) {
  if (contract.delta === null) return 45;
  const directional = type === "put" ? contract.delta < 0 : contract.delta > 0;
  if (!directional) return 0;
  const target = 0.4;
  return clamp(100 - Math.abs(Math.abs(contract.delta) - target) * 260);
}

function scoreDte(dte: number | null) {
  if (dte === null) return 55;
  if (dte < 14) return 0;
  if (dte < 21) return clamp((dte - 14) * 10);
  if (dte <= 60) return clamp(100 - Math.abs(dte - 42) * 1.15);
  if (dte <= 90) return clamp(78 - (dte - 60) * 1.3);
  return 10;
}

function scoreSpread(spreadPercent: number | null) {
  if (spreadPercent === null) return 35;
  if (spreadPercent <= 5) return 100;
  if (spreadPercent <= 8) return 84;
  if (spreadPercent <= 12) return 62;
  if (spreadPercent <= 15) return 38;
  return 0;
}

function scoreLiquidity(volume: number | null, openInterest: number | null) {
  const volumeScore = clamp(Math.sqrt(Math.max(volume ?? 0, 0) / 250) * 100);
  const oiScore = clamp(Math.sqrt(Math.max(openInterest ?? 0, 0) / 1000) * 100);
  return 0.45 * volumeScore + 0.55 * oiScore;
}

function scoreImpliedVolatility(iv: number | null) {
  if (iv === null) return 60;
  if (iv < 0.15) return 55;
  if (iv <= 0.7) return clamp(100 - Math.abs(iv - 0.42) * 70);
  if (iv <= 0.95) return clamp(75 - (iv - 0.7) * 140);
  if (iv <= 1.2) return clamp(40 - (iv - 0.95) * 120);
  return 0;
}

function scoreTheta(contract: AlpacaOptionContract) {
  if (contract.theta === null || contract.mid === null || contract.mid <= 0) {
    return { score: 60, ratio: null };
  }

  const ratio = Math.abs(contract.theta) / contract.mid;
  if (ratio <= 0.025) return { score: 100, ratio };
  if (ratio <= 0.05) return { score: 82, ratio };
  if (ratio <= 0.08) return { score: 55, ratio };
  if (ratio <= 0.12) return { score: 25, ratio };
  return { score: 0, ratio };
}

function scoreGamma(contract: AlpacaOptionContract) {
  if (contract.gamma === null) return 62;
  return clamp(100 / (1 + Math.pow(Math.abs(contract.gamma) / 0.06, 2)));
}

function scoreMoneyness(contract: AlpacaOptionContract, type: OptionType) {
  if (!contract.underlyingPrice || !contract.strikePrice) return 65;
  const ratio = contract.strikePrice / contract.underlyingPrice;
  const target = type === "put" ? 0.97 : 1.03;
  return clamp(100 - Math.abs(ratio - target) * 420);
}

function contractScore(contract: AlpacaOptionContract, type: OptionType): OptionContractSelection {
  const dte = optionContractDte(contract.expirationDate);
  const theta = scoreTheta(contract);
  const delta = scoreDelta(contract, type);
  const spread = scoreSpread(contract.bidAskSpreadPercent);
  const liquidity = scoreLiquidity(contract.volume, contract.openInterest);
  const dteScore = scoreDte(dte);
  const iv = scoreImpliedVolatility(contract.impliedVolatility);
  const gamma = scoreGamma(contract);
  const moneyness = scoreMoneyness(contract, type);
  const score =
    0.22 * delta +
    0.2 * spread +
    0.18 * liquidity +
    0.14 * dteScore +
    0.1 * iv +
    0.08 * theta.score +
    0.04 * gamma +
    0.04 * moneyness;
  const warnings = [
    ...(contract.bidAskSpreadPercent !== null && contract.bidAskSpreadPercent > 10
      ? [`Wide contract spread (${contract.bidAskSpreadPercent.toFixed(1)}%).`]
      : []),
    ...(contract.impliedVolatility !== null && contract.impliedVolatility > 0.85
      ? [`High contract IV (${(contract.impliedVolatility * 100).toFixed(1)}%).`]
      : []),
    ...(theta.ratio !== null && theta.ratio > 0.08
      ? [`Theta drag is high (${(theta.ratio * 100).toFixed(1)}% of mid per day).`]
      : []),
    ...(contract.gamma !== null && Math.abs(contract.gamma) > 0.08 ? ["Gamma is high for an automatic idea."] : []),
    ...(dte !== null && dte < 21 ? ["DTE is below the preferred 21-day floor."] : []),
    ...((contract.volume ?? 0) < 25 && (contract.openInterest ?? 0) < 100
      ? ["Contract volume and open interest are both thin."]
      : [])
  ];

  return {
    contract,
    shortContract: null,
    strategy: "long_option",
    score: clamp(score),
    dte,
    netMid: contract.mid,
    netDelta: contract.delta,
    netGamma: contract.gamma,
    netTheta: contract.theta,
    netVega: contract.vega,
    netRho: contract.rho,
    netSpreadPercent: contract.bidAskSpreadPercent,
    width: null,
    thetaRatio: theta.ratio,
    reasons: [
      `Contract selector score ${clamp(score).toFixed(1)}/100.`,
      `Delta fit ${delta.toFixed(0)}/100, DTE fit ${dteScore.toFixed(0)}/100, liquidity ${liquidity.toFixed(0)}/100.`,
      `Spread fit ${spread.toFixed(0)}/100, IV fit ${iv.toFixed(0)}/100, theta fit ${theta.score.toFixed(0)}/100.`
    ],
    warnings
  };
}

function spreadQuotePercent(longContract: AlpacaOptionContract, shortContract: AlpacaOptionContract, netMid: number) {
  if (
    longContract.ask === null ||
    longContract.bid === null ||
    shortContract.ask === null ||
    shortContract.bid === null ||
    netMid <= 0
  ) {
    const longSpread = longContract.bidAskSpreadPercent ?? 8;
    const shortSpread = shortContract.bidAskSpreadPercent ?? 8;
    return longSpread + shortSpread;
  }

  const buyDebit = longContract.ask - shortContract.bid;
  const sellDebit = longContract.bid - shortContract.ask;
  return Math.max(((buyDebit - sellDebit) / netMid) * 100, 0);
}

function netGreek(
  longValue: number | null,
  shortValue: number | null,
  digits = 4
) {
  if (longValue === null && shortValue === null) return null;
  return Number(((longValue ?? 0) - (shortValue ?? 0)).toFixed(digits));
}

function spreadSelection(
  longSelection: OptionContractSelection,
  shortContract: AlpacaOptionContract,
  type: OptionType,
  maxDebit: number | null | undefined
): OptionContractSelection | null {
  const longContract = longSelection.contract;
  if (
    longContract.mid === null ||
    shortContract.mid === null ||
    longContract.strikePrice === null ||
    shortContract.strikePrice === null ||
    longContract.expirationDate !== shortContract.expirationDate
  ) {
    return null;
  }

  if (type === "call" && shortContract.strikePrice <= longContract.strikePrice) return null;
  if (type === "put" && shortContract.strikePrice >= longContract.strikePrice) return null;

  const netMid = Number((longContract.mid - shortContract.mid).toFixed(4));
  const width = Number(Math.abs(shortContract.strikePrice - longContract.strikePrice).toFixed(2));
  if (netMid <= 0 || width <= 0 || netMid >= width) return null;
  if (maxDebit && netMid > maxDebit * 1.15) return null;

  const netDelta = netGreek(longContract.delta, shortContract.delta);
  const netTheta = netGreek(longContract.theta, shortContract.theta);
  const thetaRatio = netTheta !== null ? Math.abs(netTheta) / netMid : null;
  const netSpreadPercent = spreadQuotePercent(longContract, shortContract, netMid);
  if (netSpreadPercent > 25) return null;
  if (netDelta === null || Math.abs(netDelta) < 0.15) return null;
  if ((shortContract.volume ?? 0) < 25 && (shortContract.openInterest ?? 0) < 100) return null;
  if (thetaRatio !== null && thetaRatio > 0.1) return null;

  const shortLiquidity = scoreLiquidity(shortContract.volume, shortContract.openInterest);
  const rewardRisk = (width - netMid) / netMid;
  const rewardRiskScore = clamp((rewardRisk / 2.5) * 100);
  const debitScore = maxDebit ? clamp(100 - Math.max(netMid - maxDebit * 0.75, 0) * (100 / Math.max(maxDebit * 0.4, 0.01))) : 70;
  const thetaScore = thetaRatio === null ? 62 : thetaRatio <= 0.04 ? 100 : thetaRatio <= 0.08 ? 68 : 25;
  const spreadScore = scoreSpread(netSpreadPercent);
  const score =
    0.42 * longSelection.score +
    0.16 * shortLiquidity +
    0.16 * rewardRiskScore +
    0.12 * debitScore +
    0.08 * spreadScore +
    0.06 * thetaScore;
  const warnings = [
    ...longSelection.warnings,
    ...(netSpreadPercent > 12 ? [`Debit spread quoted spread is wide (${netSpreadPercent.toFixed(1)}%).`] : []),
    ...(thetaRatio !== null && thetaRatio > 0.08
      ? [`Net theta drag is high (${(thetaRatio * 100).toFixed(1)}% of debit per day).`]
      : []),
    ...((shortContract.volume ?? 0) < 25 && (shortContract.openInterest ?? 0) < 100
      ? ["Short leg volume and open interest are both thin."]
      : [])
  ];

  return {
    contract: longContract,
    shortContract,
    strategy: "debit_spread",
    score: clamp(score),
    dte: longSelection.dte,
    netMid,
    netDelta,
    netGamma: netGreek(longContract.gamma, shortContract.gamma),
    netTheta,
    netVega: netGreek(longContract.vega, shortContract.vega),
    netRho: netGreek(longContract.rho, shortContract.rho),
    netSpreadPercent,
    width,
    thetaRatio,
    reasons: [
      `Debit spread selector score ${clamp(score).toFixed(1)}/100.`,
      `Long ${longContract.symbol}; short ${shortContract.symbol}; width ${width.toFixed(2)}; net debit ${netMid.toFixed(2)}.`,
      `Reward/risk ${rewardRisk.toFixed(2)}x, short-leg liquidity ${shortLiquidity.toFixed(0)}/100, net-spread fit ${spreadScore.toFixed(0)}/100.`
    ],
    warnings
  };
}

export async function findBestOptionContract(input: SelectionInput): Promise<OptionContractSelection | null> {
  if (!alpacaConfigured()) return null;

  const type = input.direction === "bearish" ? "put" : "call";
  const strikeWindow =
    input.underlyingPrice && input.underlyingPrice > 0
      ? {
          strikePriceGte: Number((input.underlyingPrice * (type === "put" ? 0.82 : 0.9)).toFixed(2)),
          strikePriceLte: Number((input.underlyingPrice * (type === "put" ? 1.08 : 1.18)).toFixed(2))
        }
      : {};

  const result = await fetchAlpacaOptionChain({
    underlyingSymbol: input.symbol,
    type,
    expirationDateGte: dateAfterDays(21),
    expirationDateLte: dateAfterDays(75),
    limit: 500,
    ...strikeWindow
  });
  const scored = result.contracts
    .filter((contract) => contract.optionType === type)
    .filter((contract) => contract.mid !== null && contract.mid > 0)
    .map((contract) => contractScore(contract, type))
    .sort((left, right) => right.score - left.score);
  const spreads = scored
    .slice(0, 24)
    .flatMap((longSelection) =>
      result.contracts.flatMap((shortContract) => {
        const selection = spreadSelection(longSelection, shortContract, type, input.maxDebit);
        return selection ? [selection] : [];
      })
    )
    .sort((left, right) => right.score - left.score);
  const maxDebit = input.maxDebit ?? null;
  const budgetLongs = maxDebit
    ? scored.filter((selection) => selection.netMid !== null && selection.netMid <= maxDebit * 1.15)
    : scored;
  const choices = spreads.length || budgetLongs.length ? [...spreads, ...budgetLongs] : scored;
  const best = choices.sort((left, right) => right.score - left.score)[0];

  return best && best.score >= 48 ? best : null;
}
