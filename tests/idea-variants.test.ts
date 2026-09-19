import test from "node:test";
import assert from "node:assert/strict";
import {
  buildContractUpdateGroups,
  buildIdeaDisplayGroups,
  buildNewUnderlyingIdeas,
  chooseDirectionFromEvidence,
  contractVariantFingerprint,
  type IdeaVariantLike
} from "../lib/idea-variants";

function variant(overrides: Partial<IdeaVariantLike> = {}): IdeaVariantLike {
  return {
    id: "idea-1",
    symbol: "AAPL",
    direction: "bullish",
    strategy: "long_call",
    optionContractSymbol: "AAPL260918C00200000",
    optionType: "call",
    expirationDate: new Date("2026-09-18T00:00:00Z"),
    strikePrice: 200,
    shortStrikePrice: null,
    totalScore: 70,
    optionsQualityScore: 75,
    bidAskSpreadPercent: 7,
    optionVolume: 500,
    openInterest: 2500,
    trend: "uptrend",
    priceVs20MA: "above",
    priceVs50MA: "above",
    spyTrend: "bullish",
    qqqTrend: "bullish",
    marketBreadth: "strong",
    vixCondition: "normal",
    macroRisk: "medium",
    createdAt: new Date("2026-07-27T12:00:00Z"),
    updatedAt: new Date("2026-07-27T12:00:00Z"),
    ...overrides
  };
}

test("contract identity is stable for the same option and changes for material variants", () => {
  const base = variant();
  assert.equal(contractVariantFingerprint(base), contractVariantFingerprint({ ...base }));
  assert.notEqual(
    contractVariantFingerprint(base),
    contractVariantFingerprint(variant({ optionContractSymbol: "AAPL261218C00200000", expirationDate: new Date("2026-12-18") }))
  );
  assert.notEqual(
    contractVariantFingerprint(base),
    contractVariantFingerprint(variant({ strategy: "debit_spread", shortStrikePrice: 210 }))
  );
  assert.notEqual(
    contractVariantFingerprint(base),
    contractVariantFingerprint(variant({ direction: "bearish", strategy: "long_put" }))
  );
});

test("direction uses underlying and market evidence rather than contract score", () => {
  const result = chooseDirectionFromEvidence({
    trend: "downtrend",
    priceVs20MA: "below",
    priceVs50MA: "below",
    spyTrend: "bearish",
    qqqTrend: "neutral",
    marketBreadth: "weak",
    vixCondition: "elevated",
    macroRisk: "medium"
  });

  assert.equal(result.preferredDirection, "bearish");
  assert.ok(result.bearishPoints > result.bullishPoints);
  assert.ok(result.bearishArguments.some((argument) => argument.includes("downtrend")));
});

test("close directional evidence produces mixed and skips contract selection", () => {
  const result = chooseDirectionFromEvidence({
    trend: "sideways",
    priceVs20MA: "above",
    priceVs50MA: "below",
    spyTrend: "bullish",
    qqqTrend: "bearish",
    marketBreadth: "neutral",
    vixCondition: "normal"
  });

  assert.equal(result.preferredDirection, "mixed");
});

test("contract update groups preserve variants and rank the vehicle only inside the preferred direction", () => {
  const lowerQualityBull = variant({
    id: "bull-low",
    optionContractSymbol: "AAPL260918C00200000",
    optionsQualityScore: 55,
    totalScore: 90,
    createdAt: new Date("2026-07-26T12:00:00Z")
  });
  const higherQualityBull = variant({
    id: "bull-high",
    optionContractSymbol: "AAPL261218C00210000",
    expirationDate: new Date("2026-12-18T00:00:00Z"),
    strikePrice: 210,
    optionsQualityScore: 88,
    totalScore: 72
  });
  const highScoringBear = variant({
    id: "bear-high-score",
    direction: "bearish",
    strategy: "long_put",
    optionContractSymbol: "AAPL260918P00190000",
    optionType: "put",
    strikePrice: 190,
    totalScore: 99,
    optionsQualityScore: 99
  });

  const groups = buildContractUpdateGroups([lowerQualityBull, higherQualityBull, highScoringBear]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].variants.length, 3);
  assert.equal(groups[0].directionEvidence.preferredDirection, "bullish");
  assert.equal(groups[0].preferredVariant?.id, "bull-high");
});

test("rejected and contractless variants remain visible but cannot become preferred", () => {
  const rejected = variant({ id: "rejected", decision: "reject", status: "rejected" });
  const contractless = variant({
    id: "contractless",
    optionContractSymbol: null,
    expirationDate: null,
    strikePrice: null,
    createdAt: new Date("2026-07-26T12:00:00Z")
  });

  const groups = buildContractUpdateGroups([rejected, contractless]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].variants.length, 2);
  assert.equal(groups[0].preferredVariant, null);
});

test("detailed ideas render one ticker group and choose direction before contract score", () => {
  const bullishCall = variant({
    id: "meta-call",
    symbol: "META",
    direction: "bullish",
    strategy: "long_call",
    optionContractSymbol: "META260717C00640000",
    strikePrice: 640,
    totalScore: 90,
    decision: "reject",
    status: "rejected",
    trend: "downtrend",
    priceVs20MA: "below",
    priceVs50MA: "below",
    spyTrend: "bearish",
    qqqTrend: "bearish",
    marketBreadth: "weak",
    createdAt: new Date("2026-05-28T12:00:00Z"),
    updatedAt: new Date("2026-07-26T12:00:00Z")
  });
  const bearishPut = variant({
    id: "meta-put",
    symbol: "META",
    direction: "bearish",
    strategy: "long_put",
    optionContractSymbol: "META260717P00620000",
    optionType: "put",
    strikePrice: 620,
    totalScore: 70,
    decision: "reject",
    status: "rejected",
    trend: "downtrend",
    priceVs20MA: "below",
    priceVs50MA: "below",
    spyTrend: "bearish",
    qqqTrend: "bearish",
    marketBreadth: "weak",
    createdAt: new Date("2026-05-29T12:00:00Z"),
    updatedAt: new Date("2026-07-27T12:00:00Z")
  });
  const duplicatePutRow = variant({
    ...bearishPut,
    id: "meta-put-duplicate",
    createdAt: new Date("2026-05-20T12:00:00Z"),
    updatedAt: new Date("2026-07-20T12:00:00Z")
  });

  const groups = buildIdeaDisplayGroups([bullishCall, bearishPut, duplicatePutRow]);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].symbol, "META");
  assert.equal(groups[0].variants.length, 2);
  assert.equal(groups[0].directionEvidence.preferredDirection, "bearish");
  assert.equal(groups[0].representative.id, "meta-put");
});

test("new underlying list excludes a ticker with any prior saved history", () => {
  const since = new Date("2026-07-27T00:00:00Z");
  const oldAapl = variant({ id: "old-aapl", createdAt: new Date("2026-07-26T12:00:00Z") });
  const updatedAapl = variant({
    id: "new-aapl-contract",
    optionContractSymbol: "AAPL261218C00210000",
    createdAt: new Date("2026-07-27T12:00:00Z")
  });
  const firstMsft = variant({
    id: "first-msft",
    symbol: "MSFT",
    optionContractSymbol: "MSFT260918C00550000",
    createdAt: new Date("2026-07-27T13:00:00Z")
  });

  const ideas = buildNewUnderlyingIdeas([oldAapl, updatedAapl, firstMsft], since);
  assert.deepEqual(ideas.map((idea) => idea.symbol), ["MSFT"]);
});
