import staticMacroEvents from "@/data/macro-events.json";
import type { MarketRegimeLabel } from "@/lib/risk/market-regime";

export type EventRiskLevel = "none" | "low" | "medium" | "high";

export type RiskEventType = "earnings" | "fomc" | "cpi" | "pce" | "nfp" | "gdp" | "other";

export type RiskEvent = {
  type: RiskEventType;
  title: string;
  date: Date;
  source: "manual" | "yahoo" | "static_calendar" | "unknown";
  confidence: "high" | "medium" | "low";
  description?: string;
};

export type EventRiskResult = {
  eventRiskLevel: EventRiskLevel;
  crossesEarnings: boolean;
  crossesMacroEvent: boolean;
  events: RiskEvent[];
  eventWarnings: string[];
  hardStops: string[];
  decisionCap?: "watchlist" | "approved_small";
  riskMultiplier: number;
};

type RawRiskEvent = Omit<RiskEvent, "date"> & { date: Date | string };

function parseEvent(event: RawRiskEvent): RiskEvent | null {
  const date = event.date instanceof Date ? event.date : new Date(`${event.date}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;

  return {
    ...event,
    date
  };
}

export function loadStaticMacroEvents(): RiskEvent[] {
  return (staticMacroEvents as RawRiskEvent[]).map(parseEvent).filter((event): event is RiskEvent => event !== null);
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function daysBetween(left: Date, right: Date) {
  const ms = startOfDay(right).getTime() - startOfDay(left).getTime();
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

function expirationDate(value: Date | string | null) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function eventBeforeExpiration(event: RiskEvent, createdAt: Date, expiration: Date) {
  return startOfDay(event.date) >= startOfDay(createdAt) && startOfDay(event.date) <= startOfDay(expiration);
}

function minDecisionCap(
  current: EventRiskResult["decisionCap"],
  next: NonNullable<EventRiskResult["decisionCap"]>
): EventRiskResult["decisionCap"] {
  if (current === "watchlist" || next === "watchlist") return "watchlist";
  return "approved_small";
}

function maxLevel(left: EventRiskLevel, right: EventRiskLevel): EventRiskLevel {
  const rank: Record<EventRiskLevel, number> = { none: 0, low: 1, medium: 2, high: 3 };
  return rank[right] > rank[left] ? right : left;
}

function isDebitSpread(strategy: string) {
  return ["debit_spread", "bull_call_debit_spread", "bear_put_debit_spread"].includes(strategy);
}

function isLongOption(strategy: string) {
  return ["long_call", "long_put", "protective_put"].includes(strategy);
}

function isElevatedVix(vixStatus?: string) {
  return vixStatus === "elevated" || vixStatus === "spiking" || vixStatus === "stress";
}

export const EMPTY_EVENT_RISK: EventRiskResult = {
  eventRiskLevel: "none",
  crossesEarnings: false,
  crossesMacroEvent: false,
  events: [],
  eventWarnings: [],
  hardStops: [],
  riskMultiplier: 1
};

export function evaluateEventRisk(input: {
  symbol: string;
  strategy: string;
  direction: "bullish" | "bearish" | "neutral" | string;
  expiration: Date | string | null;
  createdAt?: Date;
  marketRegimeLabel?: MarketRegimeLabel;
  vixStatus?: string;
  earningsEvents?: RiskEvent[];
  macroEvents?: RiskEvent[];
  hasNakedShortLeg?: boolean;
}): EventRiskResult {
  const expiration = expirationDate(input.expiration);
  if (!expiration) {
    return {
      ...EMPTY_EVENT_RISK,
      eventWarnings: ["Event risk overlay could not evaluate crossings because expiration is missing."]
    };
  }

  const createdAt = input.createdAt ?? new Date();
  const earningsEvents = (input.earningsEvents ?? []).filter((event) => event.type === "earnings");
  const macroEvents = input.macroEvents ?? loadStaticMacroEvents();
  const events = [...earningsEvents, ...macroEvents].filter((event) => eventBeforeExpiration(event, createdAt, expiration));
  const earningsCrossings = events.filter((event) => event.type === "earnings");
  const macroCrossings = events.filter((event) => event.type !== "earnings");
  const eventWarnings: string[] = [];
  const hardStops: string[] = [];
  let decisionCap: EventRiskResult["decisionCap"];
  let riskMultiplier = 1;
  let level: EventRiskLevel = events.length ? "low" : "none";

  for (const event of earningsCrossings) {
    const daysUntil = daysBetween(createdAt, event.date);
    eventWarnings.push(
      `This trade expires after ${event.title}. IV crush and gap risk may materially affect the payoff.`
    );
    level = maxLevel(level, daysUntil <= 3 ? "high" : "medium");

    if (isDebitSpread(input.strategy)) {
      decisionCap = minDecisionCap(decisionCap, "approved_small");
    }

    if (isLongOption(input.strategy)) {
      eventWarnings.push("Long option structure can cross earnings, but sizing should account for IV crush.");
    }

    if (input.hasNakedShortLeg) {
      hardStops.push("Naked short option exposure is not allowed across earnings.");
    }

    if (daysUntil <= 3) {
      riskMultiplier = Math.min(riskMultiplier, 0.5);
    } else {
      riskMultiplier = Math.min(riskMultiplier, 0.75);
    }
  }

  for (const event of macroCrossings) {
    const daysUntil = daysBetween(createdAt, event.date);
    eventWarnings.push(`${event.title} occurs before expiration and may change volatility or gap risk.`);
    level = maxLevel(level, daysUntil <= 3 ? "medium" : "low");

    if (daysUntil <= 3) {
      riskMultiplier = Math.min(riskMultiplier, 0.75);
    }

    if (daysUntil <= 1 && isElevatedVix(input.vixStatus)) {
      level = maxLevel(level, "high");
      riskMultiplier = Math.min(riskMultiplier, 0.5);
      eventWarnings.push(`${event.title} is within one day while volatility is elevated.`);
    }
  }

  if (macroCrossings.length && input.marketRegimeLabel === "stress") {
    decisionCap = minDecisionCap(decisionCap, "watchlist");
    eventWarnings.push("Macro event risk during a stress regime caps the decision at watchlist.");
  }

  if (hardStops.length) {
    level = "high";
  }

  return {
    eventRiskLevel: level,
    crossesEarnings: earningsCrossings.length > 0,
    crossesMacroEvent: macroCrossings.length > 0,
    events,
    eventWarnings,
    hardStops,
    decisionCap,
    riskMultiplier
  };
}
