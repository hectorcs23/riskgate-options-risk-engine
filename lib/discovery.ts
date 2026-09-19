import { fetchYahooChart, fetchYahooQuote, summarizeSymbolTechnical, type YahooHistoryPoint } from "@/lib/market-data";

export type DiscoveryCandidate = {
  symbol: string;
  name: string | null;
  price: number | null;
  dayChangePercent: number | null;
  volume: number | null;
  averageVolume: number | null;
  volumeRatio: number | null;
  marketCap: number | null;
  currency: string;
  market: string;
  sources: string[];
  redditMentions: number;
  redditUpvotes: number;
  redditComments: number;
  redditSentiment: number;
  relativeStrengthScore: number;
  unusualVolumeScore: number;
  socialScore: number;
  technicalSetupScore: number;
  volatilityScore: number;
  realizedVolatility20: number | null;
  extensionPenalty: number;
  catalystScore: number;
  optionsLiquidityScore: number;
  riskFilterScore: number;
  discoveryScore: number;
  bias: "bullish" | "bearish" | "mixed";
  directionConfidence: number;
  dataCoverage: number;
  hasHistoricalData: boolean;
  optionsLikely: boolean;
  reasons: string[];
  warnings: string[];
};

export type DiscoveryResult = {
  candidates: DiscoveryCandidate[];
  sourceErrors: string[];
  spyDayChangePercent: number | null;
  sourceStatus: {
    yahoo: "ok" | "partial" | "failed";
    reddit: "ok" | "failed" | "skipped";
  };
  funnel: {
    rawCandidates: number;
    uniqueSymbols: number;
    historyReady: number;
    liquidityPassed: number;
    scorePassed: number;
    returned: number;
  };
};

type RawCandidate = {
  symbol: string;
  name?: string | null;
  price?: number | null;
  dayChangePercent?: number | null;
  volume?: number | null;
  averageVolume?: number | null;
  marketCap?: number | null;
  currency?: string | null;
  market?: string | null;
  source: string;
  redditMentions?: number;
  redditUpvotes?: number;
  redditComments?: number;
  redditSentiment?: number;
  history?: YahooHistoryPoint[];
};

type DiscoverOptions = {
  limit?: number;
  minScore?: number;
  minVolume?: number;
  includeReddit?: boolean;
  profile?: "quality" | "movers";
};

const yahooScreeners = [
  { id: "day_gainers", source: "Yahoo gainers" },
  { id: "day_losers", source: "Yahoo losers" },
  { id: "most_actives", source: "Yahoo most active" }
];

const redditFeeds = [
  { subreddit: "stocks", quality: 0.9 },
  { subreddit: "investing", quality: 0.85 },
  { subreddit: "options", quality: 1 },
  { subreddit: "wallstreetbets", quality: 0.55 }
];

const qualityUniverseSymbols = [
  "AAPL",
  "MSFT",
  "NVDA",
  "AMZN",
  "GOOGL",
  "META",
  "TSLA",
  "AMD",
  "AVGO",
  "NFLX",
  "JPM",
  "V",
  "MA",
  "COST",
  "CRM",
  "ORCL",
  "ADBE",
  "NOW",
  "PANW",
  "QCOM",
  "MU",
  "INTC",
  "TXN",
  "AMAT",
  "LRCX",
  "XOM",
  "LLY",
  "UNH",
  "HD",
  "WMT",
  "DIS",
  "UBER",
  "SHOP",
  "COIN"
];

const tickerStopWords = new Set([
  "A",
  "AI",
  "ALL",
  "AM",
  "API",
  "ARE",
  "ATH",
  "BE",
  "BIG",
  "BTFD",
  "CEO",
  "CFO",
  "CPI",
  "DD",
  "ETF",
  "EPS",
  "EV",
  "FED",
  "FOMC",
  "FOR",
  "GDP",
  "HODL",
  "IMO",
  "IPO",
  "IRA",
  "IT",
  "IV",
  "LOL",
  "MACD",
  "MAY",
  "MOON",
  "NEWS",
  "NYSE",
  "OTM",
  "PE",
  "PM",
  "PUT",
  "QQQ",
  "RH",
  "RSI",
  "SEC",
  "SPY",
  "TA",
  "THE",
  "US",
  "USD",
  "VIX",
  "YOLO"
]);

const bullishWords = [
  "breakout",
  "bull",
  "bullish",
  "buy",
  "calls",
  "growth",
  "momentum",
  "rally",
  "squeeze",
  "upside"
];

const bearishWords = [
  "bear",
  "bearish",
  "crash",
  "downside",
  "fraud",
  "miss",
  "puts",
  "sell",
  "short",
  "warning"
];

function clamp(value: number, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}

function toNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function cleanSymbol(symbol: string) {
  return symbol.replace(/^\$/, "").trim().toUpperCase();
}

function sentimentFor(text: string) {
  const lower = text.toLowerCase();
  const positive = bullishWords.reduce((sum, word) => sum + (lower.includes(word) ? 1 : 0), 0);
  const negative = bearishWords.reduce((sum, word) => sum + (lower.includes(word) ? 1 : 0), 0);
  return positive - negative;
}

function symbolsFromText(text: string) {
  const matches = text.match(/\$?[A-Z]{2,5}\b/g) ?? [];
  return Array.from(
    new Set(
      matches
        .map(cleanSymbol)
        .filter((symbol) => !tickerStopWords.has(symbol))
        .filter((symbol) => /^[A-Z]{2,5}$/.test(symbol))
    )
  );
}

function standardDeviation(values: number[]) {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function realizedVolatility(history?: YahooHistoryPoint[]) {
  if (!history || history.length < 22) return null;
  const closes = history.map((point) => point.close).slice(-22);
  const returns: number[] = [];

  for (let index = 1; index < closes.length; index += 1) {
    const previous = closes[index - 1];
    const current = closes[index];
    if (previous > 0) returns.push((current - previous) / previous);
  }

  const dailyStd = standardDeviation(returns);
  return dailyStd === null ? null : dailyStd * Math.sqrt(252) * 100;
}

function volatilityQuality(volatility: number | null) {
  if (volatility === null) return 60;
  if (volatility < 12) return clamp(45 + volatility * 2);
  if (volatility <= 65) return clamp(100 - Math.abs(volatility - 38) * 1.35);
  return clamp(70 - (volatility - 65) * 1.8);
}

function extensionPenalty(dayChangePercent: number | null | undefined) {
  const absMove = Math.abs(dayChangePercent ?? 0);
  if (absMove >= 15) return 0.1;
  if (absMove >= 10) return 0.25;
  if (absMove >= 7) return 0.45;
  if (absMove >= 5) return 0.65;
  return 1;
}

function unusualVolumeQuality(volumeRatio: number | null) {
  if (volumeRatio === null) return 50;
  if (volumeRatio < 0.7) return 40;
  if (volumeRatio <= 1.2) return 62;
  if (volumeRatio <= 2.5) return clamp(68 + (volumeRatio - 1.2) * 16);
  if (volumeRatio <= 4) return 82;
  return clamp(82 - (volumeRatio - 4) * 8, 45, 82);
}

function boundedRelativeStrengthScore(relativeStrength: number) {
  const bounded = Math.max(-6, Math.min(6, relativeStrength));
  return clamp(50 + bounded * 7);
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function trailingReturn(history: YahooHistoryPoint[] | undefined, periods: number) {
  if (!history || history.length <= periods) return null;
  const recent = history.at(-1)?.close;
  const previous = history.at(-(periods + 1))?.close;
  if (!recent || !previous || previous <= 0) return null;
  return ((recent - previous) / previous) * 100;
}

export function chooseDiscoveryDirection(input: {
  history?: YahooHistoryPoint[];
  dayChangePercent?: number | null;
  relativeStrength?: number | null;
  redditSentiment?: number | null;
}) {
  const closes = input.history?.map((point) => point.close).filter((value) => Number.isFinite(value)) ?? [];
  const last = closes.at(-1) ?? null;
  const sma20 = average(closes.slice(-20));
  const sma50 = average(closes.slice(-50));
  const return20 = trailingReturn(input.history, 20);
  let bullishPoints = 0;
  let bearishPoints = 0;

  if (last !== null && sma20 !== null) {
    if (last >= sma20 * 1.005) bullishPoints += 1.5;
    else if (last <= sma20 * 0.995) bearishPoints += 1.5;
  }
  if (last !== null && sma50 !== null && closes.length >= 50) {
    if (last >= sma50 * 1.01) bullishPoints += 2.5;
    else if (last <= sma50 * 0.99) bearishPoints += 2.5;
  }
  if (return20 !== null) {
    if (return20 >= 2) bullishPoints += 2;
    else if (return20 <= -2) bearishPoints += 2;
  }
  if ((input.relativeStrength ?? 0) >= 1) bullishPoints += 1.5;
  else if ((input.relativeStrength ?? 0) <= -1) bearishPoints += 1.5;
  if ((input.dayChangePercent ?? 0) >= 2) bullishPoints += 0.5;
  else if ((input.dayChangePercent ?? 0) <= -2) bearishPoints += 0.5;
  if ((input.redditSentiment ?? 0) >= 1) bullishPoints += 0.5;
  else if ((input.redditSentiment ?? 0) <= -1) bearishPoints += 0.5;

  const margin = bullishPoints - bearishPoints;
  const evidence = bullishPoints + bearishPoints;
  const directionConfidence = evidence > 0 ? clamp((Math.abs(margin) / Math.max(evidence, 4)) * 100) : 0;
  const bias = Math.abs(margin) < 2.5 ? "mixed" : margin > 0 ? "bullish" : "bearish";

  return {
    bias: bias as "bullish" | "bearish" | "mixed",
    directionConfidence,
    bullishPoints,
    bearishPoints,
    return20
  };
}

type WeightedComponent = {
  value: number | null;
  weight: number;
};

export function normalizedDiscoveryScore(components: WeightedComponent[]) {
  const active = components.filter((component) => component.value !== null && component.weight > 0);
  const activeWeight = active.reduce((sum, component) => sum + component.weight, 0);
  const totalWeight = components.reduce((sum, component) => sum + component.weight, 0);
  const score = activeWeight
    ? active.reduce((sum, component) => sum + (component.value ?? 0) * component.weight, 0) / activeWeight
    : 0;

  return {
    score: clamp(score),
    coverage: totalWeight ? clamp((activeWeight / totalWeight) * 100) : 0
  };
}

function technicalSetupScore(history: YahooHistoryPoint[] | undefined, dayChangePercent: number | null | undefined) {
  if (!history?.length) {
    const absMove = Math.abs(dayChangePercent ?? 0);
    return absMove >= 7 ? 35 : absMove >= 5 ? 50 : 60;
  }

  const summary = summarizeSymbolTechnical(history);
  let score = 50;
  if (summary.trend === "uptrend") score += 18;
  if (summary.trend === "downtrend") score -= 8;
  if (summary.priceVs20MA === "above") score += 8;
  if (summary.priceVs50MA === "above") score += 10;
  if (summary.rsiCondition === "neutral") score += 12;
  if (summary.rsiCondition === "overbought") score -= 18;
  if (summary.rsiCondition === "oversold") score += 4;
  if (summary.volumeCondition === "strong") score += 6;
  if (summary.volumeCondition === "weak") score -= 8;
  if (summary.supportResistanceQuality === "good") score += 8;
  if (summary.supportResistanceQuality === "poor") score -= 12;

  const absMove = Math.abs(dayChangePercent ?? 0);
  if (absMove >= 10) score -= 35;
  else if (absMove >= 7) score -= 24;
  else if (absMove >= 5) score -= 14;
  else if (absMove >= 1 && absMove <= 4) score += 8;
  else if (absMove < 1) score += 3;

  return clamp(score);
}

async function fetchQualityUniverse(): Promise<RawCandidate[]> {
  const results = await Promise.allSettled(
    qualityUniverseSymbols.map(async (symbol) => {
      const chart = await fetchYahooChart(symbol, "6mo", "1d");
      const volumes = chart.history.flatMap((point) => (point.volume === null ? [] : [point.volume]));
      const averageVolume = volumes.length
        ? volumes.slice(-60).reduce((sum, value) => sum + value, 0) / Math.min(volumes.length, 60)
        : null;

      return {
        symbol,
        name: chart.name,
        price: chart.currentPrice,
        dayChangePercent: chart.dayChangePercent,
        volume: chart.history.at(-1)?.volume ?? null,
        averageVolume,
        marketCap: null,
        currency: chart.currency,
        market: chart.market,
        source: "Core liquid universe",
        history: chart.history
      } satisfies RawCandidate;
    })
  );

  return results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
}

async function fetchYahooScreener(scrId: string, source: string, count: number): Promise<RawCandidate[]> {
  const response = await fetch(
    `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=${encodeURIComponent(
      scrId
    )}&count=${count}`,
    {
      cache: "no-store",
      headers: {
        "User-Agent": "RiskGate/0.3"
      }
    }
  );

  if (!response.ok) {
    throw new Error(`${source} failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    finance?: {
      result?: Array<{
        quotes?: Array<Record<string, unknown>>;
      }>;
    };
  };
  const quotes = data.finance?.result?.[0]?.quotes ?? [];

  return quotes.flatMap((quote) => {
    const symbol = typeof quote.symbol === "string" ? cleanSymbol(quote.symbol) : "";
    if (!symbol || symbol.includes(".") || symbol.includes("-")) return [];

    return [
      {
        symbol,
        name:
          (typeof quote.shortName === "string" && quote.shortName) ||
          (typeof quote.longName === "string" && quote.longName) ||
          null,
        price: toNumber(quote.regularMarketPrice),
        dayChangePercent: toNumber(quote.regularMarketChangePercent),
        volume: toNumber(quote.regularMarketVolume),
        averageVolume: toNumber(quote.averageDailyVolume3Month),
        marketCap: toNumber(quote.marketCap),
        currency: typeof quote.currency === "string" ? quote.currency : "USD",
        market: "US",
        source
      }
    ];
  });
}

async function fetchRedditFeed(subreddit: string, quality: number): Promise<RawCandidate[]> {
  const response = await fetch(`https://www.reddit.com/r/${subreddit}/hot.json?limit=70`, {
    cache: "no-store",
    headers: {
      "User-Agent": "RiskGate discovery/0.3"
    }
  });

  if (!response.ok) {
    throw new Error(`Reddit r/${subreddit} failed: ${response.status}`);
  }

  const data = (await response.json()) as {
    data?: {
      children?: Array<{
        data?: {
          title?: string;
          selftext?: string;
          score?: number;
          num_comments?: number;
          created_utc?: number;
        };
      }>;
    };
  };
  const mentions = new Map<string, RawCandidate>();

  for (const child of data.data?.children ?? []) {
    const post = child.data;
    if (!post?.title) continue;

    const text = `${post.title} ${post.selftext ?? ""}`;
    const symbols = symbolsFromText(text);
    const ageHours = post.created_utc ? Math.max((Date.now() / 1000 - post.created_utc) / 3600, 1) : 24;
    const recency = Math.max(0.25, Math.min(1, 24 / ageHours));
    const weightedScore = Math.round((post.score ?? 0) * recency * quality);
    const weightedComments = Math.round((post.num_comments ?? 0) * recency * quality);
    const sentiment = sentimentFor(text) * quality;

    for (const symbol of symbols) {
      const existing = mentions.get(symbol) ?? {
        symbol,
        source: `Reddit r/${subreddit}`,
        redditMentions: 0,
        redditUpvotes: 0,
        redditComments: 0,
        redditSentiment: 0
      };
      existing.redditMentions = (existing.redditMentions ?? 0) + 1;
      existing.redditUpvotes = (existing.redditUpvotes ?? 0) + weightedScore;
      existing.redditComments = (existing.redditComments ?? 0) + weightedComments;
      existing.redditSentiment = (existing.redditSentiment ?? 0) + sentiment;
      mentions.set(symbol, existing);
    }
  }

  return Array.from(mentions.values());
}

function scoreCandidate(
  input: RawCandidate,
  spyDayChangePercent: number | null,
  profile: "quality" | "movers",
  sourceAvailability: { socialRequested: boolean; socialAvailable: boolean }
): DiscoveryCandidate {
  const dayChange = input.dayChangePercent ?? 0;
  const relativeStrength = spyDayChangePercent === null ? null : dayChange - spyDayChangePercent;
  const volumeRatio =
    input.volume !== null &&
    input.volume !== undefined &&
    input.averageVolume !== null &&
    input.averageVolume !== undefined &&
    input.averageVolume > 0
      ? input.volume / input.averageVolume
      : null;
  const relativeStrengthScore = boundedRelativeStrengthScore(relativeStrength ?? 0);
  const unusualVolumeScore = unusualVolumeQuality(volumeRatio);
  const mentionScore = Math.log1p(input.redditMentions ?? 0) * 20;
  const upvoteScore = Math.log1p(Math.max(input.redditUpvotes ?? 0, 0)) * 7;
  const commentScore = Math.log1p(Math.max(input.redditComments ?? 0, 0)) * 5;
  const sentimentBoost = (input.redditSentiment ?? 0) * 8;
  const socialScore = clamp(mentionScore + upvoteScore + commentScore + sentimentBoost);
  const setupScore = technicalSetupScore(input.history, input.dayChangePercent);
  const realizedVol20 = realizedVolatility(input.history);
  const volScore = volatilityQuality(realizedVol20);
  const movePenalty = extensionPenalty(input.dayChangePercent);
  const sources = Array.from(new Set(input.source.split(",").map((source) => source.trim()).filter(Boolean)));
  const sourceCount = sources.length;
  const catalystScore = clamp(
    (input.source.includes("gainers") || input.source.includes("losers") ? 58 : 55) +
      (input.source.includes("Core liquid universe") ? 12 : 0) +
      (input.redditMentions ?? 0) * 6 +
      sourceCount * 4
  );
  const priceOk = input.price === null || input.price === undefined ? true : input.price >= 15;
  const volumeOk = (input.volume ?? 0) >= 1_000_000;
  const marketCapOk = input.marketCap === null || input.marketCap === undefined ? true : input.marketCap >= 1_000_000_000;
  const optionsLiquidityScore = clamp(
    (priceOk ? 30 : 0) +
      (volumeOk ? 35 : Math.min(((input.volume ?? 0) / 1_000_000) * 35, 35)) +
      (marketCapOk ? 25 : Math.min(((input.marketCap ?? 0) / 1_000_000_000) * 25, 25)) +
      (volumeRatio !== null && volumeRatio >= 1 ? 10 : 4)
  );
  const riskFilterScore = clamp((priceOk ? 35 : 5) + (volumeOk ? 35 : 10) + (marketCapOk ? 30 : 10));
  const hasHistoricalData = Boolean(input.history && input.history.length >= 22);
  const socialWeight = sourceAvailability.socialRequested ? (profile === "movers" ? 0.18 : 0.15) : 0;
  const weighted = normalizedDiscoveryScore(
    profile === "movers"
      ? [
          { value: relativeStrength === null ? null : relativeStrengthScore, weight: 0.22 },
          { value: volumeRatio === null ? null : unusualVolumeScore, weight: 0.18 },
          { value: sourceAvailability.socialAvailable ? socialScore : null, weight: socialWeight },
          { value: hasHistoricalData ? setupScore : null, weight: 0.17 },
          { value: realizedVol20 === null ? null : volScore, weight: 0.1 },
          { value: optionsLiquidityScore, weight: 0.1 },
          { value: catalystScore, weight: 0.05 }
        ]
      : [
          { value: hasHistoricalData ? setupScore : null, weight: 0.25 },
          { value: realizedVol20 === null ? null : volScore, weight: 0.2 },
          { value: relativeStrength === null ? null : relativeStrengthScore, weight: 0.15 },
          { value: sourceAvailability.socialAvailable ? socialScore : null, weight: socialWeight },
          { value: volumeRatio === null ? null : unusualVolumeScore, weight: 0.1 },
          { value: optionsLiquidityScore, weight: 0.1 },
          { value: catalystScore, weight: 0.05 }
        ]
  );
  const discoveryScore = clamp(weighted.score * movePenalty);
  const direction = chooseDiscoveryDirection({
    history: input.history,
    dayChangePercent: input.dayChangePercent,
    relativeStrength,
    redditSentiment: sourceAvailability.socialAvailable ? input.redditSentiment : null
  });
  const optionsLikely = priceOk && volumeOk && marketCapOk;
  const reasons = [
    relativeStrength === null
      ? "SPY relative-strength comparison unavailable."
      : `${relativeStrength >= 0 ? "Outperforming" : "underperforming"} SPY by ${relativeStrength.toFixed(1)} percentage points.`,
    volumeRatio !== null ? `Volume is ${volumeRatio.toFixed(1)}x its 3-month average.` : "Average-volume data unavailable.",
    realizedVol20 !== null ? `20-day realized volatility is ${realizedVol20.toFixed(1)}%.` : "Realized volatility unavailable.",
    `Technical setup score ${setupScore.toFixed(0)}/100.`,
    `Direction evidence: ${direction.bullishPoints.toFixed(1)} bullish vs ${direction.bearishPoints.toFixed(1)} bearish; ${direction.bias}.`,
    !sourceAvailability.socialRequested
      ? "Social input was intentionally excluded and its score weight was removed."
      : !sourceAvailability.socialAvailable
        ? "Social input was unavailable and its score weight was removed."
        : (input.redditMentions ?? 0) > 0
          ? `Reddit attention: ${input.redditMentions} mention(s), ${input.redditUpvotes ?? 0} weighted upvotes, ${input.redditComments ?? 0} weighted comments.`
          : "No Reddit signal in the current scan.",
    `Data coverage ${weighted.coverage.toFixed(0)}%; unavailable components were excluded and remaining weights renormalized.`,
    `Source: ${sources.join(", ")}.`
  ];
  const warnings = [
    ...(!priceOk ? ["Price is below the default options-liquidity floor."] : []),
    ...(!volumeOk ? ["Volume is below the 1M liquidity gate."] : []),
    ...(!marketCapOk ? ["Market cap is below the 1B risk gate."] : []),
    ...(movePenalty < 1
      ? [`Extended daily move (${dayChange.toFixed(1)}%); avoid chasing high-IV post-move options.`]
      : []),
    ...(realizedVol20 !== null && realizedVol20 > 75
      ? ["Realized volatility is high; Greeks and spreads may be unstable."]
      : []),
    ...(socialScore > 70 && optionsLiquidityScore < 60
      ? ["Social attention is high, but market liquidity is not strong enough yet."]
      : [])
  ];

  return {
    symbol: input.symbol,
    name: input.name ?? null,
    price: input.price ?? null,
    dayChangePercent: input.dayChangePercent ?? null,
    volume: input.volume ?? null,
    averageVolume: input.averageVolume ?? null,
    volumeRatio,
    marketCap: input.marketCap ?? null,
    currency: input.currency ?? "USD",
    market: input.market ?? "US",
    sources,
    redditMentions: input.redditMentions ?? 0,
    redditUpvotes: input.redditUpvotes ?? 0,
    redditComments: input.redditComments ?? 0,
    redditSentiment: input.redditSentiment ?? 0,
    relativeStrengthScore,
    unusualVolumeScore,
    technicalSetupScore: setupScore,
    volatilityScore: volScore,
    realizedVolatility20: realizedVol20,
    extensionPenalty: movePenalty,
    socialScore,
    catalystScore,
    optionsLiquidityScore,
    riskFilterScore,
    discoveryScore,
    bias: direction.bias,
    directionConfidence: direction.directionConfidence,
    dataCoverage: weighted.coverage,
    hasHistoricalData,
    optionsLikely,
    reasons,
    warnings
  };
}

function mergeRawCandidates(raw: RawCandidate[]) {
  const bySymbol = new Map<string, RawCandidate>();

  for (const candidate of raw) {
    const symbol = cleanSymbol(candidate.symbol);
    if (!symbol || tickerStopWords.has(symbol)) continue;

    const existing = bySymbol.get(symbol);
    if (!existing) {
      bySymbol.set(symbol, { ...candidate, symbol });
      continue;
    }

    bySymbol.set(symbol, {
      ...existing,
      ...Object.fromEntries(
        Object.entries(candidate).filter(([, value]) => value !== null && value !== undefined && value !== "")
      ),
      source: Array.from(new Set([existing.source, candidate.source])).join(", "),
      redditMentions: (existing.redditMentions ?? 0) + (candidate.redditMentions ?? 0),
      redditUpvotes: (existing.redditUpvotes ?? 0) + (candidate.redditUpvotes ?? 0),
      redditComments: (existing.redditComments ?? 0) + (candidate.redditComments ?? 0),
      redditSentiment: (existing.redditSentiment ?? 0) + (candidate.redditSentiment ?? 0)
    });
  }

  return Array.from(bySymbol.values());
}

function preliminaryEnrichmentRank(candidate: RawCandidate) {
  const pricePass = candidate.price === null || candidate.price === undefined || candidate.price >= 15 ? 25 : 0;
  const volumePass = (candidate.volume ?? 0) >= 1_000_000 ? 30 : 0;
  const marketCapPass = candidate.marketCap === null || candidate.marketCap === undefined || candidate.marketCap >= 1_000_000_000 ? 20 : 0;
  const volumeRatio = candidate.averageVolume && candidate.averageVolume > 0 ? (candidate.volume ?? 0) / candidate.averageVolume : 1;
  const volumeInterest = unusualVolumeQuality(volumeRatio) * 0.15;
  const moveQuality = extensionPenalty(candidate.dayChangePercent) * 10;
  return pricePass + volumePass + marketCapPass + volumeInterest + moveQuality;
}

async function enrichCandidateHistories(candidates: RawCandidate[], maximum = 60) {
  const selected = candidates
    .filter((candidate) => !candidate.history || candidate.history.length < 22)
    .sort((left, right) => preliminaryEnrichmentRank(right) - preliminaryEnrichmentRank(left))
    .slice(0, maximum);
  const enrichedBySymbol = new Map<string, RawCandidate>();
  let succeeded = 0;

  for (let offset = 0; offset < selected.length; offset += 8) {
    const batch = selected.slice(offset, offset + 8);
    const results = await Promise.allSettled(
      batch.map(async (candidate) => {
        const chart = await fetchYahooChart(candidate.symbol, "6mo", "1d");
        const volumes = chart.history.flatMap((point) => (point.volume === null ? [] : [point.volume]));
        const averageVolume = volumes.length
          ? volumes.slice(-60).reduce((sum, value) => sum + value, 0) / Math.min(volumes.length, 60)
          : null;

        return {
          ...candidate,
          name: chart.name ?? candidate.name,
          price: chart.currentPrice ?? candidate.price,
          dayChangePercent: chart.dayChangePercent ?? candidate.dayChangePercent,
          volume: chart.history.at(-1)?.volume ?? candidate.volume,
          averageVolume: averageVolume ?? candidate.averageVolume,
          currency: chart.currency ?? candidate.currency,
          market: chart.market ?? candidate.market,
          history: chart.history
        } satisfies RawCandidate;
      })
    );

    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        enrichedBySymbol.set(batch[index].symbol, result.value);
        succeeded += 1;
      }
    });
  }

  return {
    candidates: candidates.map((candidate) => enrichedBySymbol.get(candidate.symbol) ?? candidate),
    attempted: selected.length,
    succeeded
  };
}

export async function discoverStocks(options: DiscoverOptions = {}): Promise<DiscoveryResult> {
  const limit = options.limit ?? 35;
  const minScore = options.minScore ?? 0;
  const minVolume = options.minVolume ?? 0;
  const includeReddit = options.includeReddit ?? true;
  const profile = options.profile ?? "quality";
  const sourceErrors: string[] = [];
  const raw: RawCandidate[] = [];
  let yahooOk = 0;
  let redditOk = 0;

  for (const screener of yahooScreeners) {
    try {
      raw.push(...(await fetchYahooScreener(screener.id, screener.source, 45)));
      yahooOk += 1;
    } catch (error) {
      sourceErrors.push(error instanceof Error ? error.message : `${screener.source} failed.`);
    }
  }

  try {
    const qualityUniverse = await fetchQualityUniverse();
    raw.push(...qualityUniverse);
    if (qualityUniverse.length < qualityUniverseSymbols.length) {
      sourceErrors.push(
        `Core liquid universe loaded ${qualityUniverse.length}/${qualityUniverseSymbols.length} symbols.`
      );
    }
  } catch (error) {
    sourceErrors.push(error instanceof Error ? error.message : "Core liquid universe failed.");
  }

  if (includeReddit) {
    for (const feed of redditFeeds) {
      try {
        raw.push(...(await fetchRedditFeed(feed.subreddit, feed.quality)));
        redditOk += 1;
      } catch (error) {
        sourceErrors.push(error instanceof Error ? error.message : `Reddit r/${feed.subreddit} failed.`);
      }
    }
  }

  let spyDayChangePercent: number | null = null;
  try {
    const spy = await fetchYahooQuote("SPY");
    spyDayChangePercent = spy.dayChangePercent;
  } catch {
    sourceErrors.push("SPY relative-strength benchmark failed.");
  }

  const merged = mergeRawCandidates(raw);
  const enrichment = await enrichCandidateHistories(merged);
  if (enrichment.attempted > enrichment.succeeded) {
    sourceErrors.push(`Historical enrichment loaded ${enrichment.succeeded}/${enrichment.attempted} shortlisted symbols.`);
  }
  const scored = enrichment.candidates.map((candidate) =>
    scoreCandidate(candidate, spyDayChangePercent, profile, {
      socialRequested: includeReddit,
      socialAvailable: includeReddit && redditOk > 0
    })
  );
  const scorePassed = scored.filter((candidate) => candidate.discoveryScore >= minScore);
  const candidates = scorePassed
    .filter((candidate) => (candidate.volume ?? 0) >= minVolume)
    .sort((left, right) => right.discoveryScore - left.discoveryScore)
    .slice(0, limit);

  return {
    candidates,
    sourceErrors,
    spyDayChangePercent,
    sourceStatus: {
      yahoo: yahooOk === yahooScreeners.length ? "ok" : yahooOk > 0 ? "partial" : "failed",
      reddit: includeReddit ? (redditOk > 0 ? "ok" : "failed") : "skipped"
    },
    funnel: {
      rawCandidates: raw.length,
      uniqueSymbols: merged.length,
      historyReady: enrichment.candidates.filter((candidate) => candidate.history && candidate.history.length >= 22).length,
      liquidityPassed: scored.filter((candidate) => candidate.optionsLikely).length,
      scorePassed: scorePassed.length,
      returned: candidates.length
    }
  };
}
