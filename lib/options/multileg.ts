export type OptionLegInput = {
  symbol?: string | null;
  underlying?: string | null;
  optionType: "call" | "put";
  side: "long" | "short";
  quantity: number;
  strike: number;
  expirationDate: Date;
  bid?: number | null;
  ask?: number | null;
  mid?: number | null;
  spreadPercent?: number | null;
  impliedVol?: number | null;
  ivRank?: number | null;
  delta?: number | null;
  gamma?: number | null;
  theta?: number | null;
  vega?: number | null;
  rho?: number | null;
  openInterest?: number | null;
  volume?: number | null;
  dte?: number | null;
};

export type StockLegInput = {
  side: "long" | "short";
  quantity: number;
  entryPrice: number;
};

export type MultiLegMetrics = {
  netDebit: number;
  netCredit: number;
  maxLoss: number | null;
  maxProfit: number | null;
  breakevens: number[];
  totalDelta: number;
  totalGamma: number;
  totalTheta: number;
  totalVega: number;
  payoffPoints: { underlyingPrice: number; pnl: number }[];
  missingPriceData: boolean;
  warnings: string[];
};

export type StrategyTemplateInput = {
  underlying: string;
  expirationDate: Date;
  longStrike?: number;
  shortStrike?: number;
  quantity?: number;
  stockPrice?: number;
  stockQuantity?: number;
};

function safe(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function round(value: number, digits = 2) {
  return Number(value.toFixed(digits));
}

export function optionLegPremium(leg: Pick<OptionLegInput, "bid" | "ask" | "mid">) {
  const mid = safe(leg.mid);
  if (mid !== null) return mid;
  const bid = safe(leg.bid);
  const ask = safe(leg.ask);
  if (bid !== null && ask !== null && ask >= bid) return (bid + ask) / 2;
  return null;
}

export function optionLegPayoff(leg: Pick<OptionLegInput, "optionType" | "strike">, underlyingPrice: number) {
  if (leg.optionType === "call") return Math.max(underlyingPrice - leg.strike, 0);
  return Math.max(leg.strike - underlyingPrice, 0);
}

export function optionLegPnL(leg: OptionLegInput, underlyingPrice: number) {
  const premium = optionLegPremium(leg) ?? 0;
  const payoff = optionLegPayoff(leg, underlyingPrice);
  const quantity = Math.max(Math.trunc(leg.quantity || 1), 1);
  const multiplier = quantity * 100;

  return leg.side === "long" ? multiplier * (payoff - premium) : multiplier * (premium - payoff);
}

function stockPnL(stockLeg: StockLegInput | null | undefined, underlyingPrice: number) {
  if (!stockLeg) return 0;
  const sideMultiplier = stockLeg.side === "long" ? 1 : -1;
  return sideMultiplier * stockLeg.quantity * (underlyingPrice - stockLeg.entryPrice);
}

function highPriceEndpoint(legs: OptionLegInput[], underlyingPrice?: number | null) {
  const maxStrike = Math.max(...legs.map((leg) => leg.strike).filter(Number.isFinite), 1);
  const anchor = safe(underlyingPrice) ?? maxStrike;
  return Math.max(maxStrike * 2.5, anchor * 2, maxStrike + 50);
}

function highSideSlope(legs: OptionLegInput[], stockLeg?: StockLegInput | null) {
  const optionSlope = legs.reduce((sum, leg) => {
    if (leg.optionType !== "call") return sum;
    const signed = leg.side === "long" ? 1 : -1;
    return sum + signed * Math.max(Math.trunc(leg.quantity || 1), 1) * 100;
  }, 0);
  const stockSlope = stockLeg ? (stockLeg.side === "long" ? stockLeg.quantity : -stockLeg.quantity) : 0;
  return optionSlope + stockSlope;
}

function buildGrid(legs: OptionLegInput[], underlyingPrice?: number | null) {
  if (!legs.length) return [];
  const high = highPriceEndpoint(legs, underlyingPrice);
  const regular = Array.from({ length: 101 }, (_, index) => (high * index) / 100);
  const strikes = legs.map((leg) => leg.strike);
  return Array.from(new Set([...regular, ...strikes, safe(underlyingPrice) ?? 0]))
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
}

function findBreakevens(points: { underlyingPrice: number; pnl: number }[]) {
  const breakevens: number[] = [];

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (previous.pnl === 0) breakevens.push(previous.underlyingPrice);
    if (previous.pnl === current.pnl) continue;
    if ((previous.pnl < 0 && current.pnl > 0) || (previous.pnl > 0 && current.pnl < 0)) {
      const weight = Math.abs(previous.pnl) / (Math.abs(previous.pnl) + Math.abs(current.pnl));
      breakevens.push(previous.underlyingPrice + (current.underlyingPrice - previous.underlyingPrice) * weight);
    }
  }

  const last = points.at(-1);
  if (last?.pnl === 0) breakevens.push(last.underlyingPrice);
  return Array.from(new Set(breakevens.map((value) => round(value, 2))));
}

export function calculateMultiLegMetrics(input: {
  legs: OptionLegInput[];
  underlyingPrice?: number | null;
  stockLeg?: StockLegInput | null;
}): MultiLegMetrics {
  const legs = input.legs.filter((leg) => leg.quantity > 0 && leg.strike > 0);
  const missingPriceData = legs.some((leg) => optionLegPremium(leg) === null);
  const signedPremium = legs.reduce((sum, leg) => {
    const premium = optionLegPremium(leg) ?? 0;
    const quantity = Math.max(Math.trunc(leg.quantity || 1), 1);
    const cashFlow = premium * quantity * 100;
    return sum + (leg.side === "long" ? cashFlow : -cashFlow);
  }, 0);
  const netDebit = Math.max(signedPremium, 0);
  const netCredit = Math.max(-signedPremium, 0);
  const payoffPoints = buildGrid(legs, input.underlyingPrice).map((underlyingPrice) => ({
    underlyingPrice: round(underlyingPrice, 2),
    pnl: round(legs.reduce((sum, leg) => sum + optionLegPnL(leg, underlyingPrice), 0) + stockPnL(input.stockLeg, underlyingPrice), 2)
  }));
  const highSlope = highSideSlope(legs, input.stockLeg);
  const finiteLosses = payoffPoints.map((point) => point.pnl);
  const minPnL = finiteLosses.length ? Math.min(...finiteLosses) : 0;
  const maxPnL = finiteLosses.length ? Math.max(...finiteLosses) : 0;
  const maxLoss = highSlope < 0 ? null : round(Math.max(-minPnL, 0), 2);
  const maxProfit = highSlope > 0 ? null : round(Math.max(maxPnL, 0), 2);
  const greek = (key: "delta" | "gamma" | "theta" | "vega") =>
    legs.reduce((sum, leg) => {
      const value = safe(leg[key]) ?? 0;
      const signed = leg.side === "long" ? 1 : -1;
      return sum + signed * value * Math.max(Math.trunc(leg.quantity || 1), 1) * 100;
    }, 0);

  return {
    netDebit: round(netDebit, 2),
    netCredit: round(netCredit, 2),
    maxLoss,
    maxProfit,
    breakevens: findBreakevens(payoffPoints),
    totalDelta: round(greek("delta"), 4),
    totalGamma: round(greek("gamma"), 4),
    totalTheta: round(greek("theta"), 4),
    totalVega: round(greek("vega"), 4),
    payoffPoints,
    missingPriceData,
    warnings: [
      ...(missingPriceData ? ["One or more option legs is missing bid/ask/mid price data."] : []),
      ...(highSlope < 0 ? ["Payoff has undefined upside loss from net short call exposure."] : [])
    ]
  };
}

export function virtualLegsFromLegacyTrade(input: {
  symbol: string;
  optionType?: string | null;
  strikePrice?: number | null;
  expirationDate?: Date | null;
  daysToExpiration?: number | null;
  contractBid?: number | null;
  contractAsk?: number | null;
  contractMid?: number | null;
  contractImpliedVolatility?: number | null;
  impliedVolatilityRank?: number | null;
  contractDelta?: number | null;
  contractGamma?: number | null;
  contractTheta?: number | null;
  contractVega?: number | null;
  contractRho?: number | null;
  optionVolume?: number | null;
  openInterest?: number | null;
}): OptionLegInput[] {
  const strike = safe(input.strikePrice);
  const optionType: OptionLegInput["optionType"] | null =
    input.optionType === "put" ? "put" : input.optionType === "call" ? "call" : null;
  if (!strike || !optionType) return [];

  const expirationDate =
    input.expirationDate ??
    new Date(Date.now() + Math.max(Math.trunc(input.daysToExpiration ?? 30), 1) * 24 * 60 * 60 * 1000);

  return [
    {
      symbol: input.symbol,
      underlying: input.symbol,
      optionType,
      side: "long" as const,
      quantity: 1,
      strike,
      expirationDate,
      bid: input.contractBid,
      ask: input.contractAsk,
      mid: input.contractMid,
      impliedVol: input.contractImpliedVolatility,
      ivRank: input.impliedVolatilityRank,
      delta: input.contractDelta,
      gamma: input.contractGamma,
      theta: input.contractTheta,
      vega: input.contractVega,
      rho: input.contractRho,
      volume: input.optionVolume,
      openInterest: input.openInterest,
      dte: input.daysToExpiration
    }
  ];
}

export function detectNakedShortOptionLegs(legs: OptionLegInput[], stockLeg?: StockLegInput | null) {
  const warnings: string[] = [];

  for (const shortLeg of legs.filter((leg) => leg.side === "short")) {
    const shortQuantity = Math.max(Math.trunc(shortLeg.quantity || 1), 1);
    const matchingLongQuantity = legs
      .filter((leg) => {
        if (leg.side !== "long" || leg.optionType !== shortLeg.optionType) return false;
        if (leg.expirationDate.toISOString().slice(0, 10) !== shortLeg.expirationDate.toISOString().slice(0, 10)) {
          return false;
        }
        if (shortLeg.optionType === "call") return leg.strike <= shortLeg.strike;
        return leg.strike >= shortLeg.strike;
      })
      .reduce((sum, leg) => sum + Math.max(Math.trunc(leg.quantity || 1), 1), 0);
    const coveredByStock =
      shortLeg.optionType === "call" && stockLeg?.side === "long" && stockLeg.quantity >= shortQuantity * 100;

    if (matchingLongQuantity < shortQuantity && !coveredByStock) {
      warnings.push(`Short ${shortLeg.optionType} ${shortLeg.strike} is not covered by a defined-risk long leg.`);
    }
  }

  return warnings;
}

export function strategyTemplate(
  strategy:
    | "long_call"
    | "long_put"
    | "bull_call_debit_spread"
    | "bear_put_debit_spread"
    | "protective_put"
    | "collar",
  input: StrategyTemplateInput
) {
  const quantity = input.quantity ?? 1;
  const longStrike = input.longStrike ?? input.shortStrike;
  const shortStrike = input.shortStrike ?? input.longStrike;
  const optionLegs: OptionLegInput[] = [];
  let stockLeg: StockLegInput | null = null;

  if ((strategy === "long_call" || strategy === "bull_call_debit_spread") && longStrike) {
    optionLegs.push({
      underlying: input.underlying,
      optionType: "call",
      side: "long",
      quantity,
      strike: longStrike,
      expirationDate: input.expirationDate
    });
  }

  if ((strategy === "long_put" || strategy === "bear_put_debit_spread" || strategy === "protective_put" || strategy === "collar") && longStrike) {
    optionLegs.push({
      underlying: input.underlying,
      optionType: "put",
      side: "long",
      quantity,
      strike: longStrike,
      expirationDate: input.expirationDate
    });
  }

  if (strategy === "bull_call_debit_spread" && shortStrike) {
    optionLegs.push({
      underlying: input.underlying,
      optionType: "call",
      side: "short",
      quantity,
      strike: shortStrike,
      expirationDate: input.expirationDate
    });
  }

  if (strategy === "bear_put_debit_spread" && shortStrike) {
    optionLegs.push({
      underlying: input.underlying,
      optionType: "put",
      side: "short",
      quantity,
      strike: shortStrike,
      expirationDate: input.expirationDate
    });
  }

  if ((strategy === "protective_put" || strategy === "collar") && input.stockPrice) {
    stockLeg = {
      side: "long",
      quantity: input.stockQuantity ?? quantity * 100,
      entryPrice: input.stockPrice
    };
  }

  if (strategy === "collar" && shortStrike) {
    optionLegs.push({
      underlying: input.underlying,
      optionType: "call",
      side: "short",
      quantity,
      strike: shortStrike,
      expirationDate: input.expirationDate
    });
  }

  return { optionLegs, stockLeg };
}
