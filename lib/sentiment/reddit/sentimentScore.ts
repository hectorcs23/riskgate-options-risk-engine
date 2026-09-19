import type { RedditSentimentResult } from "@/lib/sentiment/reddit/analyzeRedditSentiment";

const severeConcernPattern = /(earnings risk|fraud|dilution|lawsuit|demand collapse|accounting risk|extreme valuation|overvalued)/i;

export function redditSentimentAdjustment(result: RedditSentimentResult | null, direction: string) {
  if (!result) return 0;
  if (result.hypeScore > 0.75) return -5;
  if (result.recurringConcerns.some((concern) => severeConcernPattern.test(concern))) return -5;
  if (result.label === "low_signal" || result.confidence <= 0.65) return 0;

  const bullish = result.label === "bullish" || result.label === "strong_bullish";
  const bearish = result.label === "bearish" || result.label === "strong_bearish";
  if ((direction === "bullish" && bullish) || (direction === "bearish" && bearish)) return 3;
  if ((direction === "bullish" && bearish) || (direction === "bearish" && bullish)) return -3;
  return 0;
}

export function redditSentimentRiskMultiplier(result: RedditSentimentResult | null, direction: string) {
  if (!result) return 1;
  if (result.hypeScore > 0.75) return 0.75;
  if (result.label === "low_signal") return 1;
  const bullish = result.label === "bullish" || result.label === "strong_bullish";
  const bearish = result.label === "bearish" || result.label === "strong_bearish";
  if (result.confidence > 0.65 && ((direction === "bullish" && bearish) || (direction === "bearish" && bullish))) {
    return 0.75;
  }
  return 1;
}
