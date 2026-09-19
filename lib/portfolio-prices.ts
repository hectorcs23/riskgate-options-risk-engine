import { prisma } from "@/lib/db";
import { fetchYahooQuote } from "@/lib/market-data";
import { createPortfolioSnapshot } from "@/lib/performance";
import { summarizePositions } from "@/lib/calculations";
import { getRiskSettings } from "@/lib/data";

type RefreshOptions = {
  force?: boolean;
  staleMinutes?: number;
};

function minutesSince(date: Date) {
  return (Date.now() - date.getTime()) / (1000 * 60);
}

function yahooSymbol(symbol: string, market: string) {
  const upper = symbol.trim().toUpperCase();
  if (!upper || upper === "CASH") return null;
  if (upper.startsWith("^")) return upper;
  if (market === "MX" && !upper.endsWith(".MX")) return `${upper}.MX`;
  return upper;
}

async function getUsdMxnRate() {
  const quote = await fetchYahooQuote("USDMXN=X");
  return quote.currentPrice && quote.currentPrice > 0 ? quote.currentPrice : null;
}

function convertQuoteToPositionCurrency(input: {
  quotePrice: number;
  quoteCurrency: string;
  positionCurrency: string;
  usdMxnRate: number | null;
}) {
  if (input.quoteCurrency === input.positionCurrency) return input.quotePrice;
  if (input.quoteCurrency === "USD" && input.positionCurrency === "MXN" && input.usdMxnRate) {
    return input.quotePrice * input.usdMxnRate;
  }
  if (input.quoteCurrency === "MXN" && input.positionCurrency === "USD" && input.usdMxnRate) {
    return input.quotePrice / input.usdMxnRate;
  }
  return input.quotePrice;
}

export async function refreshPortfolioMarketPrices(portfolioId: string, options: RefreshOptions = {}) {
  const force = options.force ?? false;
  const staleMinutes = options.staleMinutes ?? 15;
  const positions = await prisma.position.findMany({
    where: { portfolioId },
    orderBy: { symbol: "asc" }
  });
  const candidates = positions.filter((position) => position.assetType !== "cash");
  const staleCandidates = force
    ? candidates
    : candidates.filter((position) => minutesSince(position.updatedAt) >= staleMinutes);

  if (!staleCandidates.length) {
    return {
      updated: 0,
      failed: 0,
      skipped: candidates.length,
      usdMxnRate: null
    };
  }

  let usdMxnRate: number | null = null;
  if (staleCandidates.some((position) => position.currency === "MXN" && position.market === "US")) {
    try {
      usdMxnRate = await getUsdMxnRate();
    } catch {
      usdMxnRate = null;
    }
  }

  let updated = 0;
  let failed = 0;

  for (const position of staleCandidates) {
    const symbol = yahooSymbol(position.symbol, position.market);
    if (!symbol) continue;

    try {
      const quote = await fetchYahooQuote(symbol);
      if (!quote.currentPrice || quote.currentPrice <= 0) {
        failed += 1;
        continue;
      }

      const nextPrice = convertQuoteToPositionCurrency({
        quotePrice: quote.currentPrice,
        quoteCurrency: quote.currency,
        positionCurrency: position.currency,
        usdMxnRate
      });

      await prisma.position.update({
        where: { id: position.id },
        data: {
          currentPrice: Number(nextPrice.toFixed(4))
        }
      });
      updated += 1;
    } catch {
      failed += 1;
    }
  }

  if (updated > 0) {
    const [settings, refreshedPositions] = await Promise.all([
      getRiskSettings(portfolioId),
      prisma.position.findMany({ where: { portfolioId } })
    ]);
    const summary = summarizePositions(refreshedPositions, settings);

    await createPortfolioSnapshot({
      portfolioId,
      totalValue: summary.totalValue,
      cashValue: summary.cash,
      stockValue: summary.stocks,
      optionValue: summary.options,
      source: force ? "manual_price_refresh" : "auto_price_refresh"
    });
  }

  return {
    updated,
    failed,
    skipped: candidates.length - staleCandidates.length,
    usdMxnRate
  };
}
