import { cleanYahooText } from "@/lib/sentiment/yahoo/clean";
import type {
  YahooFinanceNewsDocument,
  YahooSentimentOverlay,
  YahooSentimentResult
} from "@/lib/sentiment/yahoo/types";

const bullishKeywords = [
  "beats",
  "beat expectations",
  "raises guidance",
  "upgrade",
  "upgraded",
  "outperform",
  "strong demand",
  "record revenue",
  "margin expansion",
  "buy rating",
  "price target raised",
  "growth accelerates",
  "positive outlook",
  "approval",
  "partnership",
  "acquisition",
  "contract win",
  "earnings beat"
];

const bearishKeywords = [
  "misses",
  "missed expectations",
  "cuts guidance",
  "downgrade",
  "downgraded",
  "underperform",
  "weak demand",
  "margin pressure",
  "lawsuit",
  "investigation",
  "probe",
  "antitrust",
  "regulatory risk",
  "sec",
  "fraud",
  "accounting issue",
  "layoffs",
  "bankruptcy",
  "recall",
  "earnings miss",
  "price target cut"
];

const hypeKeywords = [
  "surges",
  "skyrockets",
  "explodes",
  "meme",
  "viral",
  "short squeeze",
  "massive rally",
  "moon",
  "frenzy",
  "speculation"
];

const fearKeywords = [
  "crashes",
  "plunges",
  "collapse",
  "panic",
  "selloff",
  "recession fears",
  "warning",
  "default",
  "crisis",
  "fraud",
  "investigation"
];

const actionWords = [
  "earnings",
  "guidance",
  "upgrade",
  "downgrade",
  "lawsuit",
  "investigation",
  "acquisition",
  "merger",
  "revenue",
  "profit",
  "margin",
  "forecast",
  "analyst",
  "sec",
  "fda",
  "antitrust",
  "regulation"
];

const legalConcernWords = ["lawsuit", "investigation", "sec", "antitrust", "fraud", "regulatory"];

function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function daysOld(date?: Date | null) {
  if (!date) return 30;
  return Math.max(0, (Date.now() - date.getTime()) / (24 * 60 * 60 * 1000));
}

function keywordHits(text: string, keywords: string[]) {
  return keywords.filter((keyword) => text.includes(keyword));
}

function words(text: string) {
  return cleanYahooText(text)
    .split(/\s+/)
    .filter((word) => word.length >= 4);
}

function unique(items: string[]) {
  return Array.from(new Set(items));
}

export function scoreYahooNewsRelevance(input: {
  ticker: string;
  title: string;
  summary?: string | null;
  catalyst?: string | null;
  publisher?: string | null;
  publishedAt?: Date | null;
}) {
  const text = cleanYahooText(`${input.title} ${input.summary ?? ""}`);
  const ticker = input.ticker.toLowerCase();
  const catalystTerms = input.catalyst ? words(input.catalyst) : [];
  const catalystMatches = catalystTerms.filter((term) => text.includes(term)).length;
  const recency = clamp(1 - daysOld(input.publishedAt) / 30);
  const actionHits = keywordHits(text, actionWords).length;
  const score =
    (text.includes(ticker) ? 0.35 : 0) +
    (catalystTerms.length ? Math.min(catalystMatches / catalystTerms.length, 1) * 0.25 : 0) +
    recency * 0.2 +
    (input.publisher ? 0.1 : 0) +
    Math.min(actionHits / 2, 1) * 0.1;

  return clamp(Number(score.toFixed(3)));
}

function labelFromScore(confidence: number, relevance: number, sentimentScore: number): YahooSentimentResult["label"] {
  if (confidence < 0.25 || relevance < 0.25) return "low_signal";
  if (sentimentScore >= 0.55) return "strong_bullish";
  if (sentimentScore >= 0.2) return "bullish";
  if (sentimentScore <= -0.55) return "strong_bearish";
  if (sentimentScore <= -0.2) return "bearish";
  return "mixed";
}

export function classifyYahooSentiment(input: {
  ticker: string;
  documents: YahooFinanceNewsDocument[];
  catalyst?: string | null;
  tradeDirection?: "bullish" | "bearish" | "neutral" | string;
}): YahooSentimentResult {
  const warnings: string[] = [];
  if (!input.documents.length) {
    return {
      label: "low_signal",
      confidence: 0,
      relevance: 0,
      sentimentScore: 0,
      hypeScore: 0,
      fearScore: 0,
      catalystMentions: [],
      concernMentions: [],
      summary: "Yahoo Finance sentiment unavailable or too weak for this ticker/catalyst.",
      documentsUsed: [],
      warnings: ["Yahoo Finance sentiment has low signal because no news documents are available."]
    };
  }

  const scored = input.documents
    .map((document) => {
      const text = cleanYahooText(`${document.title} ${document.summary ?? ""}`);
      const bullish = keywordHits(text, bullishKeywords);
      const bearish = keywordHits(text, bearishKeywords);
      const hype = keywordHits(text, hypeKeywords);
      const fear = keywordHits(text, fearKeywords);
      const relevance = scoreYahooNewsRelevance({
        ticker: input.ticker,
        title: document.title,
        summary: document.summary,
        catalyst: input.catalyst,
        publisher: document.publisher,
        publishedAt: document.publishedAt
      });
      const recencyWeight = clamp(1 - daysOld(document.publishedAt) / 30, 0.25, 1);
      const signalCount = bullish.length + bearish.length;
      const docSentiment = signalCount ? (bullish.length - bearish.length) / signalCount : 0;

      return {
        document,
        text,
        bullish,
        bearish,
        hype,
        fear,
        relevance,
        recencyWeight,
        weightedSentiment: docSentiment * relevance * recencyWeight
      };
    })
    .sort((left, right) => right.relevance - left.relevance);

  const relevant = scored.filter((item) => item.relevance >= 0.2);
  const used = relevant.length ? relevant.slice(0, 10) : scored.slice(0, 5);
  const totalWeight = used.reduce((sum, item) => sum + item.relevance * item.recencyWeight, 0);
  const sentimentScore =
    totalWeight > 0 ? used.reduce((sum, item) => sum + item.weightedSentiment, 0) / totalWeight : 0;
  const relevance = used.length ? used.reduce((sum, item) => sum + item.relevance, 0) / used.length : 0;
  const confidence = clamp(Math.min(1, used.length / 5) * relevance);
  const hypeScore = clamp(used.reduce((sum, item) => sum + Math.min(item.hype.length / 2, 1) * item.relevance, 0) / Math.max(used.length, 1));
  const fearScore = clamp(used.reduce((sum, item) => sum + Math.min(item.fear.length / 2, 1) * item.relevance, 0) / Math.max(used.length, 1));
  const concernMentions = unique(used.flatMap((item) => keywordHits(item.text, legalConcernWords)));
  const catalystTerms = input.catalyst ? words(input.catalyst) : [];
  const catalystMentions = unique(used.flatMap((item) => catalystTerms.filter((term) => item.text.includes(term))));
  const label = labelFromScore(confidence, relevance, sentimentScore);

  if (label === "low_signal") warnings.push("Yahoo Finance sentiment has low signal.");
  if (concernMentions.length) warnings.push("Yahoo Finance news includes legal/regulatory concern.");

  return {
    label,
    confidence: Number(confidence.toFixed(3)),
    relevance: Number(relevance.toFixed(3)),
    sentimentScore: Number(Math.max(-1, Math.min(1, sentimentScore)).toFixed(3)),
    hypeScore: Number(hypeScore.toFixed(3)),
    fearScore: Number(fearScore.toFixed(3)),
    catalystMentions,
    concernMentions,
    summary:
      label === "low_signal"
        ? "Yahoo Finance news signal is too weak to affect scoring."
        : `Yahoo Finance news is ${label.replaceAll("_", " ")} from ${used.length} relevant document(s).`,
    documentsUsed: used.map((item) => item.document),
    warnings
  };
}

function isBullish(label: YahooSentimentResult["label"]) {
  return label === "bullish" || label === "strong_bullish";
}

function isBearish(label: YahooSentimentResult["label"]) {
  return label === "bearish" || label === "strong_bearish";
}

function minCap(
  current: YahooSentimentOverlay["decisionCap"],
  next: NonNullable<YahooSentimentOverlay["decisionCap"]>
) {
  if (current === "watchlist" || next === "watchlist") return "watchlist";
  return "approved_small";
}

export function applyYahooSentimentOverlay(input: {
  baseScore: number;
  direction: "bullish" | "bearish" | "neutral" | string;
  sentiment: YahooSentimentResult;
}): YahooSentimentOverlay {
  const warnings = [...input.sentiment.warnings];
  let scoreAdjustment = 0;
  let riskMultiplier = 1;
  let decisionCap: YahooSentimentOverlay["decisionCap"];

  if (input.sentiment.label === "low_signal") {
    warnings.push("Yahoo Finance sentiment has low signal.");
  } else if (input.sentiment.confidence > 0.65) {
    if ((isBullish(input.sentiment.label) && input.direction === "bullish") || (isBearish(input.sentiment.label) && input.direction === "bearish")) {
      scoreAdjustment += 3;
    }
    if ((isBullish(input.sentiment.label) && input.direction === "bearish") || (isBearish(input.sentiment.label) && input.direction === "bullish")) {
      scoreAdjustment -= 3;
    }
  }

  if (input.sentiment.label === "strong_bearish" && input.sentiment.confidence > 0.7 && input.sentiment.fearScore > 0.6) {
    decisionCap = minCap(decisionCap, "watchlist");
    riskMultiplier = 0.75;
  }

  if (input.sentiment.concernMentions.some((item) => legalConcernWords.includes(item))) {
    warnings.push("Yahoo Finance news includes legal/regulatory concern.");
    decisionCap = minCap(decisionCap, "watchlist");
  }

  return {
    scoreAdjustment,
    riskMultiplier,
    warnings,
    decisionCap
  };
}
