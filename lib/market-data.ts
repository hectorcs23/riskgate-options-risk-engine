import { computeCompositeMarketRegime, type CompositeMarketRegime } from "@/lib/risk/market-regime";

export type DefaultWatchlistSymbol = {
  symbol: string;
  name: string | null;
  market: string;
  currency: string;
  notes: string;
};

export type YahooHistoryPoint = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
};

export type YahooChart = {
  symbol: string;
  name: string | null;
  market: string;
  currency: string;
  currentPrice: number | null;
  previousClose: number | null;
  dayChange: number | null;
  dayChangePercent: number | null;
  history: YahooHistoryPoint[];
};

export type SymbolTechnicalSummary = {
  trend: "uptrend" | "sideways" | "downtrend";
  priceVs20MA: "above" | "below";
  priceVs50MA: "above" | "below";
  rsiCondition: "oversold" | "neutral" | "overbought";
  volumeCondition: "strong" | "normal" | "weak";
  supportResistanceQuality: "good" | "average" | "poor";
  lastPrice: number | null;
  sma20: number | null;
  sma50: number | null;
  twentyDayChangePercent: number | null;
  rsi14: number | null;
  lastVolume: number | null;
  averageVolume20: number | null;
};

export type MarketContext = {
  spyTrend: "bullish" | "neutral" | "bearish";
  qqqTrend: "bullish" | "neutral" | "bearish";
  vixCondition: "low" | "normal" | "elevated" | "spiking";
  marketBreadth: "strong" | "neutral" | "weak";
  macroRisk: "low" | "medium" | "high";
  compositeRegime: CompositeMarketRegime;
  notes: string[];
};

export const defaultWatchlistSymbols: DefaultWatchlistSymbol[] = [
  { symbol: "SPY", name: "SPDR S&P 500 ETF", market: "US", currency: "USD", notes: "Core market regime proxy." },
  { symbol: "QQQ", name: "Invesco QQQ Trust", market: "US", currency: "USD", notes: "Growth and Nasdaq regime proxy." },
  { symbol: "DIA", name: "SPDR Dow Jones Industrial Average ETF", market: "US", currency: "USD", notes: "Large-cap industrial proxy." },
  { symbol: "IWM", name: "iShares Russell 2000 ETF", market: "US", currency: "USD", notes: "Small-cap breadth proxy." },
  { symbol: "VOO", name: "Vanguard S&P 500 ETF", market: "US", currency: "USD", notes: "Long-term S&P 500 ETF reference." },
  { symbol: "VTI", name: "Vanguard Total Stock Market ETF", market: "US", currency: "USD", notes: "Whole-market reference." },
  { symbol: "^VIX", name: "CBOE Volatility Index", market: "INDEX", currency: "USD", notes: "Volatility and stress proxy." },
  { symbol: "AAPL", name: "Apple Inc.", market: "US", currency: "USD", notes: "Mega-cap technology watchlist ticker." },
  { symbol: "MSFT", name: "Microsoft Corporation", market: "US", currency: "USD", notes: "Mega-cap technology watchlist ticker." },
  { symbol: "NVDA", name: "NVIDIA Corporation", market: "US", currency: "USD", notes: "Semiconductor momentum watchlist ticker." },
  { symbol: "META", name: "Meta Platforms, Inc.", market: "US", currency: "USD", notes: "Mega-cap technology watchlist ticker." },
  { symbol: "AMZN", name: "Amazon.com, Inc.", market: "US", currency: "USD", notes: "Consumer and cloud watchlist ticker." },
  { symbol: "GOOGL", name: "Alphabet Inc.", market: "US", currency: "USD", notes: "Mega-cap technology watchlist ticker." },
  { symbol: "TSLA", name: "Tesla, Inc.", market: "US", currency: "USD", notes: "High-beta watchlist ticker." },
  { symbol: "AMD", name: "Advanced Micro Devices, Inc.", market: "US", currency: "USD", notes: "Semiconductor watchlist ticker." },
  { symbol: "AVGO", name: "Broadcom Inc.", market: "US", currency: "USD", notes: "Semiconductor watchlist ticker." },
  { symbol: "NFLX", name: "Netflix, Inc.", market: "US", currency: "USD", notes: "Growth watchlist ticker." },
  { symbol: "JPM", name: "JPMorgan Chase & Co.", market: "US", currency: "USD", notes: "Financial sector reference." },
  { symbol: "XLF", name: "Financial Select Sector SPDR Fund", market: "US", currency: "USD", notes: "Financial sector ETF." },
  { symbol: "XLK", name: "Technology Select Sector SPDR Fund", market: "US", currency: "USD", notes: "Technology sector ETF." },
  { symbol: "XLV", name: "Health Care Select Sector SPDR Fund", market: "US", currency: "USD", notes: "Healthcare sector ETF." },
  { symbol: "XLE", name: "Energy Select Sector SPDR Fund", market: "US", currency: "USD", notes: "Energy sector ETF." }
];

function roundMarketNumber(value: number | null | undefined, digits = 4) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function average(values: number[]) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sma(values: number[], length: number) {
  if (values.length < length) return null;
  return average(values.slice(-length));
}

function percentChange(current: number | null, previous: number | null) {
  if (current === null || previous === null || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function rsi(values: number[], length = 14) {
  if (values.length <= length) return null;
  const slice = values.slice(-(length + 1));
  let gains = 0;
  let losses = 0;

  for (let index = 1; index < slice.length; index += 1) {
    const diff = slice[index] - slice[index - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  const averageGain = gains / length;
  const averageLoss = losses / length;
  if (averageLoss === 0) return 100;
  const rs = averageGain / averageLoss;
  return 100 - 100 / (1 + rs);
}

export async function fetchYahooChart(symbol: string, range = "6mo", interval = "1d"): Promise<YahooChart> {
  const response = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`,
    {
      cache: "no-store",
      headers: {
        "User-Agent": "RiskGate/0.2"
      }
    }
  );

  if (!response.ok) {
    throw new Error(`Quote request failed for ${symbol}: ${response.status}`);
  }

  const data = (await response.json()) as {
    chart?: {
      result?: Array<{
        timestamp?: number[];
        meta?: {
          currency?: string;
          instrumentType?: string;
          longName?: string;
          regularMarketPrice?: number;
          chartPreviousClose?: number;
          previousClose?: number;
        };
        indicators?: {
          quote?: Array<{
          close?: Array<number | null>;
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          volume?: Array<number | null>;
        }>;
      };
      }>;
    };
  };

  const result = data.chart?.result?.[0];
  const meta = result?.meta;
  const timestamps = result?.timestamp ?? [];
  const quote = result?.indicators?.quote?.[0];
  const closes = quote?.close ?? [];
  const opens = quote?.open ?? [];
  const highs = quote?.high ?? [];
  const lows = quote?.low ?? [];
  const volumes = quote?.volume ?? [];
  const history = timestamps.flatMap((timestamp, index) => {
    const close = closes[index];
    if (typeof close !== "number" || !Number.isFinite(close)) return [];

    return [
      {
        timestamp,
        open: typeof opens[index] === "number" && Number.isFinite(opens[index]) ? opens[index]! : close,
        high: typeof highs[index] === "number" && Number.isFinite(highs[index]) ? highs[index]! : close,
        low: typeof lows[index] === "number" && Number.isFinite(lows[index]) ? lows[index]! : close,
        close,
        volume: typeof volumes[index] === "number" && Number.isFinite(volumes[index]) ? volumes[index] : null
      }
    ];
  });
  const closeValues = history.map((point) => point.close);
  const currentPrice = meta?.regularMarketPrice ?? closeValues.at(-1) ?? null;
  const previousClose = meta?.chartPreviousClose ?? meta?.previousClose ?? closeValues.at(-2) ?? null;
  const dayChange =
    currentPrice !== null && previousClose !== null ? roundMarketNumber(currentPrice - previousClose) : null;
  const dayChangePercent =
    dayChange !== null && previousClose ? roundMarketNumber((dayChange / previousClose) * 100, 2) : null;

  return {
    symbol,
    name: meta?.longName ?? null,
    market: meta?.instrumentType === "INDEX" ? "INDEX" : "US",
    currency: meta?.currency ?? "USD",
    currentPrice: roundMarketNumber(currentPrice),
    previousClose: roundMarketNumber(previousClose),
    dayChange,
    dayChangePercent,
    history
  };
}

export async function fetchYahooQuote(symbol: string) {
  const chart = await fetchYahooChart(symbol, "5d", "1d");

  return {
    currentPrice: chart.currentPrice,
    previousClose: chart.previousClose,
    dayChange: chart.dayChange,
    dayChangePercent: chart.dayChangePercent,
    currency: chart.currency,
    market: chart.market,
    name: chart.name
  };
}

export function summarizeSymbolTechnical(history: YahooHistoryPoint[]): SymbolTechnicalSummary {
  const closes = history.map((point) => point.close);
  const volumes = history.flatMap((point) => (point.volume === null ? [] : [point.volume]));
  const lastPrice = closes.at(-1) ?? null;
  const lastVolume = history.at(-1)?.volume ?? null;
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const rsi14 = rsi(closes, 14);
  const averageVolume20 = average(volumes.slice(-20));
  const twentyDayAgo = closes.length >= 21 ? closes.at(-21) ?? null : null;
  const twentyDayChange = percentChange(lastPrice, twentyDayAgo);

  let trend: SymbolTechnicalSummary["trend"] = "sideways";
  if (lastPrice !== null && sma20 !== null && sma50 !== null && twentyDayChange !== null) {
    if (lastPrice > sma20 && sma20 > sma50 && twentyDayChange > 2) trend = "uptrend";
    else if (lastPrice < sma20 && sma20 < sma50 && twentyDayChange < -2) trend = "downtrend";
  }

  let rsiCondition: SymbolTechnicalSummary["rsiCondition"] = "neutral";
  if (rsi14 !== null && rsi14 < 35) rsiCondition = "oversold";
  if (rsi14 !== null && rsi14 > 70) rsiCondition = "overbought";

  let volumeCondition: SymbolTechnicalSummary["volumeCondition"] = "normal";
  if (lastVolume !== null && averageVolume20 !== null && averageVolume20 > 0) {
    if (lastVolume > averageVolume20 * 1.25) volumeCondition = "strong";
    if (lastVolume < averageVolume20 * 0.7) volumeCondition = "weak";
  }

  let supportResistanceQuality: SymbolTechnicalSummary["supportResistanceQuality"] = "average";
  if (lastPrice !== null && sma20 !== null && sma50 !== null) {
    const distanceTo20 = Math.abs((lastPrice - sma20) / lastPrice);
    const distanceTo50 = Math.abs((lastPrice - sma50) / lastPrice);
    if (distanceTo20 <= 0.02 || distanceTo50 <= 0.03) supportResistanceQuality = "good";
    if (distanceTo20 > 0.08 && distanceTo50 > 0.1) supportResistanceQuality = "poor";
  }

  return {
    trend,
    priceVs20MA: lastPrice !== null && sma20 !== null && lastPrice >= sma20 ? "above" : "below",
    priceVs50MA: lastPrice !== null && sma50 !== null && lastPrice >= sma50 ? "above" : "below",
    rsiCondition,
    volumeCondition,
    supportResistanceQuality,
    lastPrice: roundMarketNumber(lastPrice),
    sma20: roundMarketNumber(sma20),
    sma50: roundMarketNumber(sma50),
    twentyDayChangePercent: roundMarketNumber(twentyDayChange, 2),
    rsi14: roundMarketNumber(rsi14, 2),
    lastVolume,
    averageVolume20: roundMarketNumber(averageVolume20, 0)
  };
}

export function classifyRegimeTrend(history: YahooHistoryPoint[]): MarketContext["spyTrend"] {
  const summary = summarizeSymbolTechnical(history);
  if (summary.trend === "uptrend") return "bullish";
  if (summary.trend === "downtrend") return "bearish";
  return "neutral";
}

export function classifyVixCondition(history: YahooHistoryPoint[]): MarketContext["vixCondition"] {
  const closes = history.map((point) => point.close);
  const last = closes.at(-1) ?? null;
  const previous = closes.at(-2) ?? null;
  const dailyChange = percentChange(last, previous);

  if (last === null) return "normal";
  if (last >= 30 || (dailyChange !== null && dailyChange >= 15)) return "spiking";
  if (last >= 22) return "elevated";
  if (last <= 15) return "low";
  return "normal";
}

export function buildMarketContext(input: {
  spy?: YahooHistoryPoint[];
  qqq?: YahooHistoryPoint[];
  vix?: YahooHistoryPoint[];
  breadthHistories?: YahooHistoryPoint[][];
}): MarketContext {
  const spySummary = input.spy ? summarizeSymbolTechnical(input.spy) : null;
  const qqqSummary = input.qqq ? summarizeSymbolTechnical(input.qqq) : null;
  const spyTrend = spySummary ? classifyRegimeTrend(input.spy ?? []) : "neutral";
  const qqqTrend = qqqSummary ? classifyRegimeTrend(input.qqq ?? []) : "neutral";
  const vixCondition = input.vix ? classifyVixCondition(input.vix) : "normal";
  const summaries = (input.breadthHistories ?? []).map(summarizeSymbolTechnical);
  const above50Count = summaries.filter((summary) => summary.lastPrice !== null && summary.sma50 !== null && summary.lastPrice >= summary.sma50).length;
  const breadthRatio = summaries.length ? above50Count / summaries.length : 0.5;
  const marketBreadth = breadthRatio >= 0.65 ? "strong" : breadthRatio <= 0.4 ? "weak" : "neutral";
  const macroRisk = vixCondition === "spiking" ? "high" : vixCondition === "low" && marketBreadth === "strong" ? "low" : "medium";
  const vixCloses = input.vix?.map((point) => point.close) ?? [];
  const vixValue = vixCloses.at(-1) ?? null;
  const vixPrevious = vixCloses.at(-2) ?? null;
  const compositeRegime = computeCompositeMarketRegime({
    spy: spySummary
      ? {
          price: spySummary.lastPrice,
          sma20: spySummary.sma20,
          sma50: spySummary.sma50,
          change20d: spySummary.twentyDayChangePercent,
          trend: spyTrend
        }
      : { trend: spyTrend },
    qqq: qqqSummary
      ? {
          price: qqqSummary.lastPrice,
          sma20: qqqSummary.sma20,
          sma50: qqqSummary.sma50,
          change20d: qqqSummary.twentyDayChangePercent,
          trend: qqqTrend
        }
      : { trend: qqqTrend },
    breadth: { ratio: breadthRatio, status: marketBreadth },
    vix: {
      value: vixValue,
      dailyChangePercent: percentChange(vixValue, vixPrevious),
      condition: vixCondition
    }
  });

  return {
    spyTrend,
    qqqTrend,
    vixCondition,
    marketBreadth,
    macroRisk,
    compositeRegime,
    notes: [
      `SPY ${spyTrend}`,
      `QQQ ${qqqTrend}`,
      `VIX ${vixCondition}`,
      `breadth ${(breadthRatio * 100).toFixed(0)}% above 50MA`,
      `composite regime ${compositeRegime.label.replaceAll("_", " ")} (${compositeRegime.compositeScore})`
    ]
  };
}

export function sameLocalDate(left: Date, right = new Date()) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

export function startOfLocalDay(date = new Date()) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}
