import type { YahooFinanceNewsDocument } from "@/lib/sentiment/yahoo/types";

type YahooSearchResponse = {
  news?: Array<{
    uuid?: string;
    title?: string;
    publisher?: string;
    link?: string;
    providerPublishTime?: number;
    summary?: string;
  }>;
};

function timeoutSignal(ms: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout)
  };
}

function publishedDate(seconds?: number) {
  if (!seconds || !Number.isFinite(seconds)) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

function insideLookback(date: Date | null, lookbackDays: number) {
  if (!date) return true;
  const ageMs = Date.now() - date.getTime();
  return ageMs <= lookbackDays * 24 * 60 * 60 * 1000;
}

// Yahoo Finance search endpoints are unofficial and may change without notice.
// RiskGate treats this collector as best-effort and returns an empty set on failure.
export async function collectYahooFinanceNews(input: {
  ticker: string;
  maxDocuments?: number;
  lookbackDays?: number;
}): Promise<YahooFinanceNewsDocument[]> {
  const ticker = input.ticker.trim().toUpperCase();
  if (!ticker) return [];

  const maxDocuments = Math.max(1, Math.min(Math.trunc(input.maxDocuments ?? 10), 25));
  const lookbackDays = Math.max(1, Math.trunc(input.lookbackDays ?? 14));
  const timeout = timeoutSignal(7000);

  try {
    const params = new URLSearchParams({
      q: ticker,
      quotesCount: "0",
      newsCount: String(maxDocuments)
    });
    const response = await fetch(`https://query1.finance.yahoo.com/v1/finance/search?${params.toString()}`, {
      cache: "no-store",
      signal: timeout.signal,
      headers: {
        "User-Agent": "RiskGate/0.2"
      }
    });

    if (!response.ok) return [];
    const data = (await response.json()) as YahooSearchResponse;
    const collectedAt = new Date();

    return (data.news ?? [])
      .flatMap((item): YahooFinanceNewsDocument[] => {
        if (!item.title) return [];
        const publishedAt = publishedDate(item.providerPublishTime);
        if (!insideLookback(publishedAt, lookbackDays)) return [];

        return [
          {
            id: item.uuid,
            ticker,
            title: item.title,
            publisher: item.publisher ?? null,
            summary: item.summary ?? null,
            url: item.link ?? null,
            publishedAt,
            collectedAt
          }
        ];
      })
      .slice(0, maxDocuments);
  } catch {
    return [];
  } finally {
    timeout.clear();
  }
}
