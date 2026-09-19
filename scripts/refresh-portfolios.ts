import { prisma } from "../lib/db";
import { refreshPortfolioMarketPrices } from "../lib/portfolio-prices";

async function main() {
  const portfolios = await prisma.portfolio.findMany({
    orderBy: { createdAt: "asc" }
  });

  for (const portfolio of portfolios) {
    const result = await refreshPortfolioMarketPrices(portfolio.id, { force: true });
    console.log(
      `${portfolio.name}: updated ${result.updated}, failed ${result.failed}, skipped ${result.skipped}, USD/MXN ${result.usdMxnRate ?? "n/a"}`
    );
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
