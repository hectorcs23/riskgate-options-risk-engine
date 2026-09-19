export type YahooSentimentLabel =
  | "strong_bullish"
  | "bullish"
  | "mixed"
  | "bearish"
  | "strong_bearish"
  | "low_signal";

export type YahooFinanceNewsDocument = {
  id?: string;
  ticker: string;
  title: string;
  publisher?: string | null;
  summary?: string | null;
  url?: string | null;
  publishedAt?: Date | null;
  collectedAt?: Date;
};

export type YahooSentimentResult = {
  label: YahooSentimentLabel;
  confidence: number;
  relevance: number;
  sentimentScore: number;
  hypeScore: number;
  fearScore: number;
  catalystMentions: string[];
  concernMentions: string[];
  summary: string;
  documentsUsed: YahooFinanceNewsDocument[];
  warnings: string[];
};

export type YahooSentimentOverlay = {
  scoreAdjustment: number;
  riskMultiplier: number;
  warnings: string[];
  decisionCap?: "watchlist" | "approved_small";
};
