export type ContractVariantLike = {
  id?: string;
  symbol: string;
  direction: string;
  strategy: string;
  optionContractSymbol?: string | null;
  optionType?: string | null;
  expirationDate?: Date | string | null;
  strikePrice?: number | null;
  shortStrikePrice?: number | null;
};

export type DirectionEvidenceLike = {
  trend?: string | null;
  priceVs20MA?: string | null;
  priceVs50MA?: string | null;
  spyTrend?: string | null;
  qqqTrend?: string | null;
  marketBreadth?: string | null;
  vixCondition?: string | null;
  macroRisk?: string | null;
};

export type IdeaVariantLike = ContractVariantLike &
  DirectionEvidenceLike & {
    createdAt: Date | string;
    updatedAt?: Date | string;
    totalScore?: number | null;
    optionsQualityScore?: number | null;
    decision?: string | null;
    status?: string | null;
    bidAskSpreadPercent?: number | null;
    optionVolume?: number | null;
    openInterest?: number | null;
  };

export type PreferredDirection = "bullish" | "bearish" | "mixed";

export type DirectionEvidence = {
  preferredDirection: PreferredDirection;
  bullishPoints: number;
  bearishPoints: number;
  bullishArguments: string[];
  bearishArguments: string[];
  margin: number;
};

export type ContractUpdateGroup<T extends IdeaVariantLike> = {
  symbol: string;
  variants: T[];
  preferredVariant: T | null;
  directionEvidence: DirectionEvidence;
  newestAt: Date;
};

export type IdeaDisplayGroup<T extends IdeaVariantLike> = {
  symbol: string;
  variants: T[];
  representative: T;
  directionEvidence: DirectionEvidence;
};

function normalized(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? "";
}

function dateKey(value: Date | string | null | undefined) {
  if (!value) return "NO_EXPIRATION";
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return String(value).slice(0, 10);
  return parsed.toISOString().slice(0, 10);
}

function numberKey(value: number | null | undefined) {
  return value === null || value === undefined || !Number.isFinite(value)
    ? "NA"
    : Number(value.toFixed(3)).toString();
}

function timestamp(value: Date | string | undefined) {
  if (!value) return 0;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}

export function contractVariantFingerprint(idea: ContractVariantLike) {
  const contract = idea.optionContractSymbol?.trim().toUpperCase() || "NO_CONTRACT";
  return [
    idea.symbol.trim().toUpperCase(),
    normalized(idea.direction) || "unknown",
    normalized(idea.strategy) || "unknown",
    contract,
    dateKey(idea.expirationDate),
    numberKey(idea.strikePrice),
    numberKey(idea.shortStrikePrice)
  ].join("|");
}

export function contractVariantLabel(idea: ContractVariantLike) {
  const strategy = normalized(idea.strategy).replaceAll("_", " ") || "option";
  const contract = idea.optionContractSymbol?.trim().toUpperCase();
  const strike = numberKey(idea.strikePrice);
  const shortStrike = numberKey(idea.shortStrikePrice);
  const expiration = dateKey(idea.expirationDate);

  if (contract) {
    return `${contract}${shortStrike !== "NA" ? ` / short ${shortStrike}` : ""}`;
  }

  const strikeLabel = strike === "NA" ? "strike pending" : `strike ${strike}`;
  const expirationLabel = expiration === "NO_EXPIRATION" ? "expiration pending" : `exp ${expiration}`;
  return `${strategy} · ${strikeLabel} · ${expirationLabel}`;
}

export function chooseDirectionFromEvidence(input: DirectionEvidenceLike): DirectionEvidence {
  let bullishPoints = 0;
  let bearishPoints = 0;
  const bullishArguments: string[] = [];
  const bearishArguments: string[] = [];

  const addBull = (points: number, argument: string) => {
    bullishPoints += points;
    bullishArguments.push(argument);
  };
  const addBear = (points: number, argument: string) => {
    bearishPoints += points;
    bearishArguments.push(argument);
  };

  const trend = normalized(input.trend);
  if (trend === "uptrend") addBull(3, "Underlying is in an uptrend");
  if (trend === "downtrend") addBear(3, "Underlying is in a downtrend");

  if (normalized(input.priceVs20MA) === "above") addBull(1.5, "Price is above its 20-day average");
  if (normalized(input.priceVs20MA) === "below") addBear(1.5, "Price is below its 20-day average");
  if (normalized(input.priceVs50MA) === "above") addBull(2, "Price is above its 50-day average");
  if (normalized(input.priceVs50MA) === "below") addBear(2, "Price is below its 50-day average");

  if (normalized(input.spyTrend) === "bullish") addBull(1, "SPY regime is bullish");
  if (normalized(input.spyTrend) === "bearish") addBear(1, "SPY regime is bearish");
  if (normalized(input.qqqTrend) === "bullish") addBull(1, "QQQ regime is bullish");
  if (normalized(input.qqqTrend) === "bearish") addBear(1, "QQQ regime is bearish");
  if (normalized(input.marketBreadth) === "strong") addBull(1, "Market breadth is strong");
  if (normalized(input.marketBreadth) === "weak") addBear(1, "Market breadth is weak");

  if (normalized(input.vixCondition) === "low") addBull(0.5, "VIX is low");
  if (normalized(input.vixCondition) === "elevated") addBear(0.5, "VIX is elevated");
  if (normalized(input.vixCondition) === "spiking") addBear(1, "VIX is spiking");
  if (normalized(input.macroRisk) === "low") addBull(0.5, "Macro risk is low");
  if (normalized(input.macroRisk) === "high") addBear(0.75, "Macro risk is high");

  const margin = Number(Math.abs(bullishPoints - bearishPoints).toFixed(2));
  const preferredDirection: PreferredDirection =
    margin < 2 ? "mixed" : bullishPoints > bearishPoints ? "bullish" : "bearish";

  return {
    preferredDirection,
    bullishPoints: Number(bullishPoints.toFixed(2)),
    bearishPoints: Number(bearishPoints.toFixed(2)),
    bullishArguments,
    bearishArguments,
    margin
  };
}

export function contractQualityRank(idea: IdeaVariantLike) {
  const optionsQuality = idea.optionsQualityScore ?? 0;
  const totalScore = idea.totalScore ?? 0;
  const spread = idea.bidAskSpreadPercent ?? 100;
  const spreadScore = spread <= 8 ? 100 : spread <= 12 ? 80 : spread <= 20 ? 50 : 10;
  const volumeScore = Math.min(Math.max(idea.optionVolume ?? 0, 0) / 10, 100);
  const interestScore = Math.min(Math.max(idea.openInterest ?? 0, 0) / 25, 100);
  const liquidityScore = spreadScore * 0.5 + volumeScore * 0.2 + interestScore * 0.3;
  return Number((optionsQuality * 0.65 + totalScore * 0.25 + liquidityScore * 0.1).toFixed(3));
}

export function isEligibleContractVariant(idea: IdeaVariantLike, now = new Date()) {
  const hasContract = Boolean(
    idea.optionContractSymbol?.trim() ||
      (idea.expirationDate && idea.strikePrice !== null && idea.strikePrice !== undefined)
  );
  if (!hasContract) return false;
  if (normalized(idea.decision) === "reject") return false;
  if (["rejected", "closed", "replaced"].includes(normalized(idea.status))) return false;

  if (idea.expirationDate) {
    const expiration = idea.expirationDate instanceof Date ? idea.expirationDate : new Date(idea.expirationDate);
    if (!Number.isNaN(expiration.getTime()) && expiration.getTime() < now.getTime()) return false;
  }
  return true;
}

function passesRiskGate(idea: IdeaVariantLike) {
  if (normalized(idea.decision) === "reject") return false;
  return !["rejected", "closed", "replaced"].includes(normalized(idea.status));
}

function displayRank(idea: IdeaVariantLike) {
  return isEligibleContractVariant(idea)
    ? contractQualityRank(idea)
    : Number((idea.totalScore ?? 0).toFixed(3));
}

export function collapseContractVariants<T extends IdeaVariantLike>(ideas: T[]) {
  const newestPerVariant = new Map<string, T>();
  for (const idea of ideas) {
    const fingerprint = contractVariantFingerprint(idea);
    const current = newestPerVariant.get(fingerprint);
    if (!current || timestamp(idea.updatedAt ?? idea.createdAt) > timestamp(current.updatedAt ?? current.createdAt)) {
      newestPerVariant.set(fingerprint, idea);
    }
  }
  return [...newestPerVariant.values()];
}

export function buildIdeaDisplayGroups<T extends IdeaVariantLike>(ideas: T[]): IdeaDisplayGroup<T>[] {
  const bySymbol = new Map<string, T[]>();
  for (const idea of ideas) {
    const symbol = idea.symbol.trim().toUpperCase();
    bySymbol.set(symbol, [...(bySymbol.get(symbol) ?? []), idea]);
  }

  const groups = [...bySymbol].map(([symbol, symbolIdeas]) => {
    const variants = collapseContractVariants(symbolIdeas);
    const evidenceAnchor = [...variants].sort(
      (left, right) => timestamp(right.updatedAt ?? right.createdAt) - timestamp(left.updatedAt ?? left.createdAt)
    )[0];
    const directionEvidence = chooseDirectionFromEvidence(evidenceAnchor);
    const directionalVariants =
      directionEvidence.preferredDirection === "mixed"
        ? variants
        : variants.filter((variant) => normalized(variant.direction) === directionEvidence.preferredDirection);
    const candidatePool = directionalVariants.length ? directionalVariants : variants;
    const passingCandidates = candidatePool.filter(passesRiskGate);
    const rankedCandidates = (passingCandidates.length ? passingCandidates : candidatePool).sort((left, right) => {
      const rankDifference = displayRank(right) - displayRank(left);
      return rankDifference || timestamp(right.updatedAt ?? right.createdAt) - timestamp(left.updatedAt ?? left.createdAt);
    });
    const representative = rankedCandidates[0];

    variants.sort((left, right) => {
      if (left === representative) return -1;
      if (right === representative) return 1;
      return timestamp(right.createdAt) - timestamp(left.createdAt);
    });

    return {
      symbol,
      variants,
      representative,
      directionEvidence
    };
  });

  return groups.sort((left, right) => {
    const scoreDifference = (right.representative.totalScore ?? 0) - (left.representative.totalScore ?? 0);
    return scoreDifference || timestamp(right.representative.updatedAt) - timestamp(left.representative.updatedAt);
  });
}

export function buildContractUpdateGroups<T extends IdeaVariantLike>(ideas: T[], limit = 3): ContractUpdateGroup<T>[] {
  const bySymbol = new Map<string, T[]>();
  for (const idea of ideas) {
    const symbol = idea.symbol.trim().toUpperCase();
    bySymbol.set(symbol, [...(bySymbol.get(symbol) ?? []), idea]);
  }

  const groups: ContractUpdateGroup<T>[] = [];
  for (const [symbol, symbolIdeas] of bySymbol) {
    const variants = collapseContractVariants(symbolIdeas).sort(
      (left, right) => timestamp(right.createdAt) - timestamp(left.createdAt)
    );
    if (variants.length < 2) continue;

    const evidenceAnchor = [...variants].sort(
      (left, right) => timestamp(right.updatedAt ?? right.createdAt) - timestamp(left.updatedAt ?? left.createdAt)
    )[0];
    const directionEvidence = chooseDirectionFromEvidence(evidenceAnchor);
    const matchingDirection =
      directionEvidence.preferredDirection === "mixed"
        ? []
        : variants.filter(
            (variant) =>
              normalized(variant.direction) === directionEvidence.preferredDirection &&
              isEligibleContractVariant(variant)
          );
    const preferredVariant =
      matchingDirection.sort((left, right) => contractQualityRank(right) - contractQualityRank(left))[0] ?? null;

    if (preferredVariant) {
      variants.sort((left, right) => {
        if (left === preferredVariant) return -1;
        if (right === preferredVariant) return 1;
        return timestamp(right.createdAt) - timestamp(left.createdAt);
      });
    }

    groups.push({
      symbol,
      variants,
      preferredVariant,
      directionEvidence,
      newestAt: new Date(Math.max(...variants.map((variant) => timestamp(variant.createdAt))))
    });
  }

  return groups.sort((left, right) => right.newestAt.getTime() - left.newestAt.getTime()).slice(0, limit);
}

export function buildNewUnderlyingIdeas<T extends IdeaVariantLike>(ideas: T[], since: Date, limit = 5) {
  const sinceTime = since.getTime();
  const bySymbol = new Map<string, T[]>();
  for (const idea of ideas) {
    const symbol = idea.symbol.trim().toUpperCase();
    bySymbol.set(symbol, [...(bySymbol.get(symbol) ?? []), idea]);
  }

  return [...bySymbol.values()]
    .filter((symbolIdeas) => Math.min(...symbolIdeas.map((idea) => timestamp(idea.createdAt))) >= sinceTime)
    .map((symbolIdeas) =>
      [...symbolIdeas].sort((left, right) => timestamp(right.createdAt) - timestamp(left.createdAt))[0]
    )
    .sort((left, right) => timestamp(right.createdAt) - timestamp(left.createdAt))
    .slice(0, limit);
}
