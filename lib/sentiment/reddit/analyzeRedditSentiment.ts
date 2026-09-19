import { cleanRedditText, tokenizeRedditText } from "@/lib/sentiment/reddit/cleanRedditText";

export type RedditSentimentLabel =
  | "strong_bullish"
  | "bullish"
  | "mixed"
  | "bearish"
  | "strong_bearish"
  | "hype"
  | "fear"
  | "low_signal";

export type RedditContextSource = {
  title?: string | null;
  body?: string | null;
  cleanedText?: string | null;
  subreddit: string;
  url?: string | null;
  createdUtc?: Date | string | null;
  score?: number | null;
  numComments?: number | null;
};

export type RedditSentimentResult = {
  label: RedditSentimentLabel;
  sentimentScore: number;
  confidence: number;
  hypeScore: number;
  fearScore: number;
  summary: string;
  bullishArguments: string[];
  bearishArguments: string[];
  recurringConcerns: string[];
  catalystsMentioned: string[];
  representativeSources: {
    title?: string;
    subreddit: string;
    url?: string;
    createdUtc?: string;
  }[];
  warnings: string[];
};

const bullishTerms = new Set([
  "bull",
  "bullish",
  "buy",
  "calls",
  "breakout",
  "beat",
  "growth",
  "demand",
  "guidance",
  "upgrade",
  "margin",
  "moat",
  "undervalued",
  "strong"
]);

const bearishTerms = new Set([
  "bear",
  "bearish",
  "puts",
  "short",
  "miss",
  "downgrade",
  "weak",
  "overvalued",
  "lawsuit",
  "fraud",
  "dilution",
  "collapse",
  "accounting",
  "margin",
  "risk"
]);

const hypeTerms = new Set(["moon", "mooning", "rocket", "yolo", "squeeze", "gamma", "lambo", "diamond", "ape", "bagger"]);
const fearTerms = new Set(["crash", "panic", "fear", "bankrupt", "fraud", "lawsuit", "collapse", "rug", "disaster"]);
const concernTerms = ["earnings risk", "fraud", "dilution", "lawsuit", "demand collapse", "accounting risk", "extreme valuation", "overvalued", "margin pressure"];
const catalystTerms = ["earnings", "guidance", "upgrade", "downgrade", "lawsuit", "ai", "margins", "demand", "robotaxi", "blackwell", "iphone", "capex"];

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function shortReason(text: string, terms: Set<string>) {
  const cleaned = cleanRedditText(text);
  const sentences = cleaned.split(/[.!?\n]+/).map((item) => item.trim()).filter(Boolean);
  return sentences.find((sentence) => tokenizeRedditText(sentence).some((token) => terms.has(token)))?.slice(0, 180);
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

export function analyzeRedditSentiment(input: {
  symbol: string;
  direction?: string | null;
  thesis?: string | null;
  catalyst?: string | null;
  contexts: RedditContextSource[];
}): RedditSentimentResult {
  const contexts = input.contexts.filter((context) => cleanRedditText(context.cleanedText ?? context.body ?? "").length > 20);
  if (!contexts.length) {
    return {
      label: "low_signal",
      sentimentScore: 0,
      confidence: 0,
      hypeScore: 0,
      fearScore: 0,
      summary: "Reddit sentiment unavailable or too weak for this ticker/catalyst.",
      bullishArguments: [],
      bearishArguments: [],
      recurringConcerns: [],
      catalystsMentioned: [],
      representativeSources: [],
      warnings: ["Reddit signal is low quality or unavailable."]
    };
  }

  const combined = contexts.map((context) => `${context.title ?? ""} ${context.cleanedText ?? context.body ?? ""}`).join("\n");
  const tokens = tokenizeRedditText(combined);
  const bullishCount = tokens.filter((token) => bullishTerms.has(token)).length;
  const bearishCount = tokens.filter((token) => bearishTerms.has(token)).length;
  const hypeCount = tokens.filter((token) => hypeTerms.has(token)).length;
  const fearCount = tokens.filter((token) => fearTerms.has(token)).length;
  const signalCount = bullishCount + bearishCount;
  const sentimentScore = signalCount ? clamp((bullishCount - bearishCount) / signalCount, -1, 1) : 0;
  const confidence = clamp(Math.min(contexts.length / 8, 1) * Math.min(signalCount / 16, 1), 0, 1);
  const hypeScore = clamp(hypeCount / Math.max(tokens.length / 120, 1), 0, 1);
  const fearScore = clamp(fearCount / Math.max(tokens.length / 120, 1), 0, 1);
  const recurringConcerns = concernTerms.filter((term) => combined.toLowerCase().includes(term));
  const catalystsMentioned = catalystTerms.filter((term) => tokens.includes(term));

  let label: RedditSentimentLabel = "mixed";
  if (confidence < 0.2) label = "low_signal";
  else if (hypeScore > 0.75) label = "hype";
  else if (fearScore > 0.75) label = "fear";
  else if (sentimentScore >= 0.55) label = "strong_bullish";
  else if (sentimentScore >= 0.2) label = "bullish";
  else if (sentimentScore <= -0.55) label = "strong_bearish";
  else if (sentimentScore <= -0.2) label = "bearish";

  const bullishArguments = unique(contexts.flatMap((context) => shortReason(`${context.title ?? ""}. ${context.cleanedText ?? context.body ?? ""}`, bullishTerms) ?? []));
  const bearishArguments = unique(contexts.flatMap((context) => shortReason(`${context.title ?? ""}. ${context.cleanedText ?? context.body ?? ""}`, bearishTerms) ?? []));
  const staleCount = contexts.filter((context) => {
    if (!context.createdUtc) return false;
    const created = new Date(context.createdUtc);
    if (Number.isNaN(created.getTime())) return false;
    return Date.now() - created.getTime() > 1000 * 60 * 60 * 24 * 45;
  }).length;
  const warnings = [
    "Reddit sentiment is a qualitative market narrative signal, not a prediction or approval signal.",
    ...(label === "low_signal" ? ["Reddit signal is low quality or unavailable."] : []),
    ...(hypeScore > 0.75 ? ["Reddit hype score is high."] : []),
    ...(fearScore > 0.75 ? ["Reddit fear score is high."] : []),
    ...(staleCount > contexts.length / 2 ? ["Reddit context is stale."] : []),
    ...recurringConcerns.map((concern) => `Recurring Reddit concern: ${concern}.`)
  ];

  return {
    label,
    sentimentScore: Number(sentimentScore.toFixed(2)),
    confidence: Number(confidence.toFixed(2)),
    hypeScore: Number(hypeScore.toFixed(2)),
    fearScore: Number(fearScore.toFixed(2)),
    summary: `${input.symbol.toUpperCase()} Reddit context is ${label.replaceAll("_", " ")} with ${contexts.length} source chunk(s). Treat it as crowd narrative, not truth.`,
    bullishArguments: bullishArguments.slice(0, 5),
    bearishArguments: bearishArguments.slice(0, 5),
    recurringConcerns,
    catalystsMentioned,
    representativeSources: contexts.slice(0, 5).map((context) => ({
      title: context.title ?? undefined,
      subreddit: context.subreddit,
      url: context.url ?? undefined,
      createdUtc: context.createdUtc ? new Date(context.createdUtc).toISOString() : undefined
    })),
    warnings
  };
}
