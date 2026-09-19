import { tokenizeRedditText } from "@/lib/sentiment/reddit/cleanRedditText";

export type LocalEmbedding = Map<string, number>;

const stopWords = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "you",
  "are",
  "was",
  "but",
  "not",
  "from",
  "have",
  "has",
  "will",
  "they",
  "their",
  "about",
  "into",
  "just",
  "like"
]);

export function embedRedditText(text: string): LocalEmbedding {
  const counts: LocalEmbedding = new Map();
  for (const token of tokenizeRedditText(text)) {
    if (stopWords.has(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

export function cosineSimilarity(left: LocalEmbedding, right: LocalEmbedding) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (const value of left.values()) leftNorm += value * value;
  for (const value of right.values()) rightNorm += value * value;
  for (const [key, value] of left.entries()) {
    dot += value * (right.get(key) ?? 0);
  }

  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}
