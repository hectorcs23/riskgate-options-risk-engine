import type { RedditDocument } from "@prisma/client";
import { cosineSimilarity, embedRedditText } from "@/lib/sentiment/reddit/embedRedditDocs";

export type RedditRetrievalResult = RedditDocument & {
  retrievalScore: number;
};

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function recencyScore(date: Date | null) {
  if (!date) return 0.35;
  const ageDays = Math.max((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24), 0);
  return clamp01(Math.exp(-ageDays / 30));
}

function engagementScore(score?: number | null, comments?: number | null) {
  return clamp01(Math.log1p(Math.max(score ?? 0, 0) + Math.max(comments ?? 0, 0)) / Math.log1p(1000));
}

function subredditWeight(subreddit: string) {
  const normalized = subreddit.toLowerCase();
  if (normalized === "options") return 1;
  if (normalized === "investing" || normalized === "stocks" || normalized === "securityanalysis") return 0.9;
  if (normalized === "wallstreetbets") return 0.65;
  return 0.75;
}

export function retrieveRedditContext(input: {
  query: string;
  documents: RedditDocument[];
  topK?: number;
  recencyBoost?: boolean;
}): RedditRetrievalResult[] {
  const queryEmbedding = embedRedditText(input.query);
  const topK = input.topK ?? 10;

  return input.documents
    .map((document) => {
      const similarity = cosineSimilarity(queryEmbedding, embedRedditText(document.cleanedText));
      const score =
        0.65 * similarity +
        0.2 * (input.recencyBoost === false ? 0.5 : recencyScore(document.createdUtc)) +
        0.1 * engagementScore(document.score, document.numComments) +
        0.05 * subredditWeight(document.subreddit);

      return {
        ...document,
        retrievalScore: score
      };
    })
    .sort((left, right) => right.retrievalScore - left.retrievalScore)
    .slice(0, topK);
}
