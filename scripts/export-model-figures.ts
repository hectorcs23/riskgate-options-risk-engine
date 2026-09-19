// Exports the scoring curves and two worked examples used in the README figures.
// Usage: npx tsx scripts/export-model-figures.ts > docs/img/model-data.json
import { evaluateTradeIdea, getConfidenceMultiplier, getLiquidityMultiplier, getVolatilityMultiplier } from "../lib/risk";
import { spreadQuality, dteQuality, volumeQuality, openInterestQuality, ivRankQuality, premiumSizeQuality } from "../lib/risk/optionsQuality";

const empty = { optionContractSymbol: null, optionType: null, strikePrice: null, shortStrikePrice: null, contractBid: null, contractAsk: null,
  contractMid: null, contractDelta: null, contractGamma: null, contractTheta: null, contractVega: null, contractRho: null,
  contractImpliedVolatility: null, contractUnderlyingPrice: null, contractBreakEvenPrice: null, contractSnapshotAt: null };

const settings: any = { id: "demo", portfolioId: "demo", totalPortfolioValue: 100000, optionsSleevePercent: 3, maxOptionsSleeveMXN: 3000,
  baseRiskPerTradePercent: 0.5, baseRiskPerTradeMXN: 500, maxMonthlyOptionsLossPercent: 1, maxMonthlyOptionsLossMXN: 1000,
  maxOpenOptionsRiskPercent: 2, maxOpenOptionsRiskMXN: 2000 };
const exposure = { optionsRiskUsed: 0, monthlyLossUsed: 0, openOptionsRiskUsed: 0 };

const rejected: any = { symbol: "TSLA", direction: "bullish", strategy: "long_call", thesis: "Momentum entry after a fast move.", catalyst: null,
  invalidationLevel: null, ...empty, targetPrice: 240, expirationDate: new Date("2026-06-05"), premiumCost: 650, maxLoss: 650, expectedReward: 900,
  exitPlan: null, spyTrend: "neutral", qqqTrend: "neutral", vixCondition: "spiking", marketBreadth: "weak", macroRisk: "high", trend: "uptrend",
  priceVs20MA: "above", priceVs50MA: "above", rsiCondition: "overbought", volumeCondition: "weak", supportResistanceQuality: "poor",
  bidAskSpreadPercent: 18, optionVolume: 12, openInterest: 45, daysToExpiration: 5, impliedVolatilityRank: 84, premiumAsPercentOfPortfolio: 1.2, isChasing: true };
const approved: any = { symbol: "AAPL", direction: "bullish", strategy: "debit_spread",
  thesis: "Holding above the 20MA after a clean consolidation; a debit spread limits premium while keeping upside into the next catalyst.",
  catalyst: "Product event and sector strength.", invalidationLevel: 188, ...empty, targetPrice: 205, expirationDate: new Date("2026-07-17"),
  premiumCost: 260, maxLoss: 300, expectedReward: 600, exitPlan: "Take 80% of max gain, close below 188, or two weeks before expiry if the thesis stalls.",
  spyTrend: "bullish", qqqTrend: "bullish", vixCondition: "low", marketBreadth: "strong", macroRisk: "low", trend: "uptrend", priceVs20MA: "above",
  priceVs50MA: "above", rsiCondition: "neutral", volumeCondition: "normal", supportResistanceQuality: "good", bidAskSpreadPercent: 4, optionVolume: 140,
  openInterest: 620, daysToExpiration: 44, impliedVolatilityRank: 42, premiumAsPercentOfPortfolio: 0.49, isChasing: false,
  optionType: "call", strikePrice: 195, contractUnderlyingPrice: 196, contractImpliedVolatility: 0.28, contractDelta: 0.3, contractMid: 2.6, contractTheta: -0.04,
  optionLegs: [
    { symbol: "AAPL", underlying: "AAPL", optionType: "call", side: "long", quantity: 1, strike: 195, expirationDate: new Date(Date.now() + 44 * 864e5),
      bid: 4.95, ask: 5.25, mid: 5.1, impliedVol: 0.28, ivRank: 42, delta: 0.52, theta: -0.07, volume: 140, openInterest: 620, dte: 44 },
    { symbol: "AAPL", underlying: "AAPL", optionType: "call", side: "short", quantity: 1, strike: 205, expirationDate: new Date(Date.now() + 44 * 864e5),
      bid: 2.4, ask: 2.6, mid: 2.5, impliedVol: 0.27, ivRank: 42, delta: 0.27, theta: -0.05, volume: 180, openInterest: 900, dte: 44 },
  ] };

const pick = (r: any) => ({ market: r.marketRegimeScore, technical: r.technicalScore, options: r.optionsQualityScore, process: r.tradeQualityScore,
  total: r.totalScore, decision: r.decision, risk: r.suggestedRiskMXN, reasons: r.reasons, warnings: r.warnings, hardStops: r.hardStops });
const range = (a: number, b: number, n: number) => Array.from({ length: n }, (_, i) => a + (b - a) * i / (n - 1));

const out = {
  examples: { TSLA: pick(evaluateTradeIdea(rejected, settings, exposure)), AAPL: pick(evaluateTradeIdea(approved, settings, exposure)) },
  curves: {
    spread: range(0, 25, 101).map(x => [x, spreadQuality(x)]),
    dte: range(0, 240, 241).map(x => [x, dteQuality(x)]),
    volume: range(0, 1000, 101).map(x => [x, volumeQuality(x)]),
    openInterest: range(0, 2000, 101).map(x => [x, openInterestQuality(x)]),
    ivRank: range(0, 100, 101).map(x => [x, ivRankQuality(x)]),
    premiumPct: range(0, 3, 121).map(x => [x, premiumSizeQuality({ premium: x / 100 * 100000, portfolioValue: 100000 })]),
    confidence: range(50, 100, 501).map(x => [x, getConfidenceMultiplier(x)]),
    liquidity: range(0, 25, 251).map(x => [x, getLiquidityMultiplier(x)]),
    volatility: range(0, 100, 101).map(x => [x, getVolatilityMultiplier(x)]),
  },
};
console.log(JSON.stringify(out));
