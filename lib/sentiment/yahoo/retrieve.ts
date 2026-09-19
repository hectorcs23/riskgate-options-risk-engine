import { scoreYahooNewsRelevance } from "@/lib/sentiment/yahoo/classify";
import type { YahooFinanceNewsDocument } from "@/lib/sentiment/yahoo/types";

export function retrieveRelevantYahooNews(input: {
  ticker: string;
  documents: YahooFinanceNewsDocument[];
  catalyst?: string | null;
  limit?: number;
}) {
  const limit = Math.max(1, Math.trunc(input.limit ?? 10));

  return input.documents
    .map((document) => ({
      document,
      relevance: scoreYahooNewsRelevance({
        ticker: input.ticker,
        title: document.title,
        summary: document.summary,
        catalyst: input.catalyst,
        publisher: document.publisher,
        publishedAt: document.publishedAt
      })
    }))
    .sort((left, right) => right.relevance - left.relevance)
    .slice(0, limit);
}
