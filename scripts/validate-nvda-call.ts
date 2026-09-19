/**
 * One-off validation of a current NVDA call through the RiskGate score model.
 * Usage: npx tsx scripts/validate-nvda-call.ts
 * Real inputs: NVDA daily bars (S&P Global via stockanalysis.com, through Jul 15 2026),
 * market regime from the Jul 14 daily report, RiskSettings from the DB backup.
 * ESTIMATED inputs (no live chain access): IV, spread, volume, OI, IV rank.
 * Greeks/premium are derived from the IV estimate via Black-Scholes for consistency.
 */
import { evaluateTradeIdea, type TradeInput, type RiskExposure } from "@/lib/risk";
import { technicalSnapshotFromBars } from "@/lib/indicators";
import type { RiskSettings } from "@prisma/client";

// NVDA daily bars, oldest -> newest (May 4 to Jul 15, 2026)
const bars = [
  [199.5, 201.73, 194.74, 198.48, 125368092], [199.3, 200.24, 196.03, 196.5, 113406620],
  [199.89, 208.27, 198.61, 207.83, 188362812], [208.34, 214.2, 206.5, 211.5, 168307873],
  [213.03, 217.8, 212.89, 215.2, 136421361], [214.04, 222.3, 213.89, 219.44, 160685774],
  [218.55, 223.75, 214.92, 220.78, 159176619], [224.93, 227.84, 221.57, 225.83, 150405386],
  [229.85, 236.54, 229.3, 235.74, 180782857], [229.76, 231.5, 224.24, 225.32, 180977639],
  [229.87, 230.0, 218.37, 222.32, 146280896], [219.62, 224.48, 217.91, 220.61, 140948207],
  [223.18, 226.13, 220.5, 223.47, 184201587], [222.29, 227.4, 217.93, 219.51, 203381760],
  [220.9, 221.01, 214.8, 215.33, 169275710], [216.54, 218.18, 212.0, 214.86, 187202576],
  [214.12, 214.15, 208.78, 212.6, 167601172], [211.28, 215.52, 211.22, 214.25, 143996048],
  [214.58, 217.86, 211.13, 211.14, 289410623], [215.73, 224.87, 215.7, 224.36, 212850685],
  [227.18, 232.28, 221.35, 222.82, 193362903], [221.72, 222.82, 214.51, 214.75, 160907001],
  [213.91, 221.6, 210.97, 218.66, 169022152], [214.53, 214.87, 204.33, 205.1, 219655531],
  [210.18, 210.47, 206.0, 208.64, 138372837], [210.62, 211.4, 199.34, 208.19, 180962450],
  [204.43, 207.22, 199.92, 200.42, 161746587], [201.49, 205.66, 199.54, 204.87, 158643204],
  [204.86, 207.07, 203.44, 205.19, 112345314], [208.92, 212.71, 208.34, 212.45, 149936688],
  [211.18, 211.49, 207.29, 207.41, 125694100], [208.53, 209.21, 203.08, 204.65, 128363473],
  [207.33, 211.39, 206.5, 210.69, 241272013], [211.44, 213.99, 207.72, 208.65, 122041419],
  [202.17, 203.77, 200.0, 200.04, 153496196], [200.12, 201.67, 196.58, 199.0, 151810704],
  [200.08, 200.8, 192.13, 195.74, 150205647], [193.12, 195.55, 191.22, 192.53, 179304147],
  [193.85, 196.18, 189.8, 194.97, 148835724], [197.24, 200.63, 195.11, 200.09, 166476665],
  [196.2, 199.85, 193.45, 197.58, 146147597], [197.14, 200.06, 192.35, 194.83, 142385548],
  [194.42, 197.55, 193.99, 195.55, 108999015], [192.37, 198.41, 191.14, 196.93, 124154574],
  [195.18, 205.16, 195.06, 204.12, 147419133], [204.46, 204.59, 198.96, 202.78, 132037359],
  [202.0, 211.0, 201.92, 210.96, 148421001], [208.54, 210.57, 203.0, 203.53, 121019603],
  [208.2, 212.55, 203.8, 211.8, 122954282], [211.96, 213.81, 211.16, 210.66, 16987813]
].map(([open, high, low, close, volume]) => ({ open, high, low, close, volume }));

// Contract under validation: NVDA 21 Aug 2026 $220 call
const S = 210.66; // NVDA Jul 15 intraday
const K = 220;
const DTE = 37;
const IV = 0.38; // ESTIMATE
const r = 0.04;

// Black-Scholes for internally consistent premium and greeks
const T = DTE / 365;
const sq = IV * Math.sqrt(T);
const d1 = (Math.log(S / K) + (r + (IV * IV) / 2) * T) / sq;
const d2 = d1 - sq;
const N = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));
const n = (x: number) => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
function erf(x: number) {
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
const mid = S * N(d1) - K * Math.exp(-r * T) * N(d2);
const delta = N(d1);
const gamma = n(d1) / (S * sq);
const theta = (-(S * n(d1) * IV) / (2 * Math.sqrt(T)) - r * K * Math.exp(-r * T) * N(d2)) / 365;
const vega = (S * n(d1) * Math.sqrt(T)) / 100;
const spreadPct = 3; // ESTIMATE, liquid ATM monthly
const bid = mid * (1 - spreadPct / 200);
const ask = mid * (1 + spreadPct / 200);
const premium = mid * 100;

const settings = {
  totalPortfolioValue: 100000, optionsSleevePercent: 3, maxOptionsSleeveMXN: 3000,
  baseRiskPerTradePercent: 0.5, baseRiskPerTradeMXN: 500,
  maxMonthlyOptionsLossPercent: 1, maxMonthlyOptionsLossMXN: 1000,
  maxOpenOptionsRiskPercent: 2, maxOpenOptionsRiskMXN: 2000,
  eventRiskEnabled: true, enableYahooFinanceSentiment: false,
  redditSentimentEnabled: false, redditUseInFinalScore: false
} as unknown as RiskSettings;

const exposure: RiskExposure = { optionsRiskUsed: 0, monthlyLossUsed: 0, openOptionsRiskUsed: 0 };

const snapshot = technicalSnapshotFromBars(bars);
const expiration = new Date("2026-08-21T20:00:00Z");

const input = {
  symbol: "NVDA", direction: "bullish", strategy: "long_call",
  thesis: "Uptrend resumption after Jul 10-14 momentum; AI chip demand, UAE export opening, and analyst average target ~$310 support continuation above the 50-day.",
  catalyst: "Q2 FY2027 earnings expected late Aug; UAE AI chip export approvals; Intel 18A supply headlines.",
  invalidationLevel: 200.13, // -5% from spot, consistent with model convention
  expirationDate: expiration,
  optionContractSymbol: "NVDA260821C00220000", optionType: "call",
  strikePrice: K, shortStrikePrice: null,
  contractBid: bid, contractAsk: ask, contractMid: mid,
  contractDelta: delta, contractGamma: gamma, contractTheta: theta,
  contractVega: vega, contractRho: null,
  contractImpliedVolatility: IV, contractUnderlyingPrice: S,
  contractBreakEvenPrice: K + mid, contractSnapshotAt: new Date(),
  premiumCost: premium, maxLoss: premium, expectedReward: premium * 2,
  exitPlan: "Take profit at 100% gain or underlying target 227.5 (+8%); exit on close below 200.13 or at 21 DTE, whichever first.",
  spyTrend: "bullish", qqqTrend: "bullish", vixCondition: "normal",
  marketBreadth: "neutral", macroRisk: "medium",
  trend: snapshot.trendLabel, priceVs20MA: "above", priceVs50MA: "above",
  rsiCondition: "neutral", volumeCondition: "normal",
  supportResistanceQuality: "average",
  bidAskSpreadPercent: spreadPct,
  optionVolume: 5000, // ESTIMATE
  openInterest: 15000, // ESTIMATE
  daysToExpiration: DTE,
  impliedVolatilityRank: 30, // ESTIMATE
  premiumAsPercentOfPortfolio: (premium / 100000) * 100,
  isChasing: false,
  technicalSnapshot: snapshot,
  optionLegs: [{
    symbol: "NVDA260821C00220000", underlying: "NVDA", optionType: "call" as const,
    side: "long" as const, quantity: 1, strike: K, expirationDate: expiration,
    bid, ask, mid, spreadPercent: spreadPct, impliedVol: IV, ivRank: 30,
    delta, gamma, theta, vega, rho: null, openInterest: 15000, volume: 5000, dte: DTE
  }]
} as unknown as TradeInput;

console.log("=== Contract (BS-derived from IV estimate) ===");
console.log({ mid: mid.toFixed(2), delta: delta.toFixed(3), gamma: gamma.toFixed(4), theta: theta.toFixed(3), vega: vega.toFixed(3), breakeven: (K + mid).toFixed(2), premiumUSDx100: premium.toFixed(0), premiumPctPortfolio: ((premium / 100000) * 100).toFixed(2) + "%" });
console.log("=== Technical snapshot (from real bars) ===");
console.log(snapshot);
const result = evaluateTradeIdea(input, settings, exposure);
console.log("=== RiskGate evaluation ===");
console.log(JSON.stringify(result, (k, v) => (typeof v === "number" ? Number(v.toFixed(3)) : v), 2));
