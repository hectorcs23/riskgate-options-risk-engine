import { prisma } from "../lib/db";
import {
  buildContractUpdateGroups,
  buildNewUnderlyingIdeas,
  chooseDirectionFromEvidence,
  contractVariantFingerprint
} from "../lib/idea-variants";

async function main() {
  const ideas = await prisma.tradeIdea.findMany({
    where: {
      thesis: {
        contains: "Auto-generated discovery idea."
      }
    },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }]
  });
  const byPortfolio = new Map<string, typeof ideas>();
  for (const idea of ideas) {
    byPortfolio.set(idea.portfolioId, [...(byPortfolio.get(idea.portfolioId) ?? []), idea]);
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const portfolios = [...byPortfolio].map(([portfolioId, rows]) => ({
    portfolioId,
    rows: rows.length,
    uniqueFingerprints: new Set(rows.map(contractVariantFingerprint)).size,
    latestContractUpdates: buildContractUpdateGroups(rows, 3).map((group) => ({
      symbol: group.symbol,
      variants: group.variants.length,
      direction: group.directionEvidence.preferredDirection,
      preferredContract: group.preferredVariant?.optionContractSymbol ?? null
    })),
    newUnderlyingsToday: buildNewUnderlyingIdeas(rows, today, 5).map((idea) => idea.symbol)
  }));
  const realContractsToday = ideas
    .filter((idea) => idea.createdAt >= today && Boolean(idea.optionContractSymbol))
    .map((idea) => ({
      id: idea.id,
      portfolioId: idea.portfolioId,
      fingerprint: contractVariantFingerprint(idea),
      symbol: idea.symbol,
      direction: idea.direction,
      strategy: idea.strategy,
      optionContractSymbol: idea.optionContractSymbol,
      expirationDate: idea.expirationDate?.toISOString().slice(0, 10) ?? null,
      strikePrice: idea.strikePrice,
      shortStrikePrice: idea.shortStrikePrice,
      totalScore: idea.totalScore,
      optionsQualityScore: idea.optionsQualityScore,
      decision: idea.decision,
      status: idea.status,
      bidAskSpreadPercent: idea.bidAskSpreadPercent,
      optionVolume: idea.optionVolume,
      openInterest: idea.openInterest,
      evidence: chooseDirectionFromEvidence(idea)
    }));

  console.log(
    JSON.stringify(
      {
        totalTradeIdeas: await prisma.tradeIdea.count(),
        missingLastEvaluatedAt: await prisma.tradeIdea.count({ where: { lastEvaluatedAt: null } }),
        discoverySymbolHistories: await prisma.discoverySymbolHistory.count(),
        autoIdeas: ideas.length,
        portfolios,
        realContractsToday
      },
      null,
      2
    )
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
