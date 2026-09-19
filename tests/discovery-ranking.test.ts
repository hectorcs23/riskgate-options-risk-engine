import assert from "node:assert/strict";
import test from "node:test";
import { chooseDiscoveryDirection, normalizedDiscoveryScore } from "../lib/discovery";

function historyFromCloses(closes: number[]) {
  return closes.map((close, index) => ({
    timestamp: 1_700_000_000 + index * 86_400,
    open: close - 0.5,
    high: close + 1,
    low: close - 1,
    close,
    volume: 2_000_000
  }));
}

test("multi-week trend outweighs a single negative day", () => {
  const history = historyFromCloses(Array.from({ length: 60 }, (_, index) => 100 + index * 0.8));
  const result = chooseDiscoveryDirection({
    history,
    dayChangePercent: -4,
    relativeStrength: 2.5,
    redditSentiment: 0
  });

  assert.equal(result.bias, "bullish");
  assert.ok(result.bullishPoints > result.bearishPoints);
});

test("close directional evidence remains mixed instead of being forced", () => {
  const closes = Array.from({ length: 60 }, () => 100);
  const result = chooseDiscoveryDirection({
    history: historyFromCloses(closes),
    dayChangePercent: 0.3,
    relativeStrength: 0.2,
    redditSentiment: 0
  });

  assert.equal(result.bias, "mixed");
});

test("missing score inputs are removed and remaining weights are renormalized", () => {
  const result = normalizedDiscoveryScore([
    { value: 80, weight: 0.25 },
    { value: null, weight: 0.15 },
    { value: 60, weight: 0.1 }
  ]);

  assert.equal(Number(result.score.toFixed(2)), 74.29);
  assert.equal(Number(result.coverage.toFixed(0)), 70);
});
