export type OptionType = "call" | "put";

export type AlpacaOptionContract = {
  symbol: string;
  underlyingSymbol: string;
  optionType: OptionType;
  expirationDate: string | null;
  strikePrice: number | null;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  bidAskSpreadPercent: number | null;
  openInterest: number | null;
  volume: number | null;
  impliedVolatility: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  rho: number | null;
  breakEvenPrice: number | null;
  underlyingPrice: number | null;
  updatedAt: string | null;
};

type OptionChainFilters = {
  underlyingSymbol: string;
  type?: OptionType;
  expirationDate?: string;
  expirationDateGte?: string;
  expirationDateLte?: string;
  strikePriceGte?: number;
  strikePriceLte?: number;
  limit?: number;
};

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Add it to .env.local.`);
  return value;
}

function alpacaHeaders() {
  return {
    Accept: "application/json",
    "APCA-API-KEY-ID": requiredEnv("APCA_API_KEY_ID"),
    "APCA-API-SECRET-KEY": requiredEnv("APCA_API_SECRET_KEY")
  };
}

function toNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function pickNumber(source: Record<string, unknown> | undefined | null, keys: string[]) {
  if (!source) return null;
  for (const key of keys) {
    const value = toNumber(source[key]);
    if (value !== null) return value;
  }
  return null;
}

function pickString(source: Record<string, unknown> | undefined | null, keys: string[]) {
  if (!source) return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function parseContractSymbol(symbol: string) {
  const match = symbol.match(/^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!match) {
    return {
      underlyingSymbol: symbol.replace(/\d.*$/, ""),
      optionType: "call" as OptionType,
      expirationDate: null,
      strikePrice: null
    };
  }

  const [, root, year, month, day, side, strikeRaw] = match;
  return {
    underlyingSymbol: root,
    optionType: side === "C" ? ("call" as OptionType) : ("put" as OptionType),
    expirationDate: `20${year}-${month}-${day}`,
    strikePrice: Number(strikeRaw) / 1000
  };
}

function normalizeContract(symbol: string, raw: Record<string, unknown>): AlpacaOptionContract {
  const parsed = parseContractSymbol(symbol);
  const greeks = (raw.greeks ?? raw.Greeks ?? {}) as Record<string, unknown>;
  const latestQuote = (raw.latest_quote ?? raw.latestQuote ?? raw.quote ?? {}) as Record<string, unknown>;
  const latestTrade = (raw.latest_trade ?? raw.latestTrade ?? {}) as Record<string, unknown>;
  const dailyBar = (raw.daily_bar ?? raw.dailyBar ?? raw.day ?? {}) as Record<string, unknown>;
  const details = (raw.details ?? {}) as Record<string, unknown>;
  const bid = pickNumber(latestQuote, ["bp", "bid_price", "bidPrice", "bid"]);
  const ask = pickNumber(latestQuote, ["ap", "ask_price", "askPrice", "ask"]);
  const mid = bid !== null && ask !== null && ask > 0 ? (bid + ask) / 2 : null;
  const bidAskSpreadPercent = bid !== null && ask !== null && mid && mid > 0 ? ((ask - bid) / mid) * 100 : null;
  const strikePrice =
    pickNumber(details, ["strike_price", "strikePrice", "strike"]) ??
    toNumber(raw.strike_price) ??
    parsed.strikePrice;
  const underlying = (raw.underlying_asset ?? raw.underlyingAsset ?? {}) as Record<string, unknown>;
  const underlyingPrice =
    pickNumber(underlying, ["price", "last_price", "lastPrice"]) ??
    pickNumber(raw as Record<string, unknown>, ["underlying_price", "underlyingPrice"]);

  return {
    symbol,
    underlyingSymbol:
      pickString(details, ["underlying_symbol", "underlyingSymbol", "root_symbol", "rootSymbol"]) ??
      parsed.underlyingSymbol,
    optionType:
      (pickString(details, ["type", "contract_type", "contractType"]) as OptionType | null) ?? parsed.optionType,
    expirationDate:
      pickString(details, ["expiration_date", "expirationDate"]) ??
      pickString(raw as Record<string, unknown>, ["expiration_date", "expirationDate"]) ??
      parsed.expirationDate,
    strikePrice,
    bid,
    ask,
    mid,
    bidAskSpreadPercent,
    openInterest: pickNumber(raw as Record<string, unknown>, ["open_interest", "openInterest"]),
    volume: pickNumber(dailyBar, ["v", "volume"]),
    impliedVolatility: pickNumber(raw as Record<string, unknown>, ["implied_volatility", "impliedVolatility"]),
    delta: pickNumber(greeks, ["delta"]),
    gamma: pickNumber(greeks, ["gamma"]),
    theta: pickNumber(greeks, ["theta"]),
    vega: pickNumber(greeks, ["vega"]),
    rho: pickNumber(greeks, ["rho"]),
    breakEvenPrice: pickNumber(raw as Record<string, unknown>, ["break_even_price", "breakEvenPrice"]),
    underlyingPrice,
    updatedAt:
      pickString(latestQuote, ["t", "timestamp"]) ??
      pickString(latestTrade, ["t", "timestamp"]) ??
      null
  };
}

export function alpacaConfigured() {
  return Boolean(process.env.APCA_API_KEY_ID && process.env.APCA_API_SECRET_KEY);
}

export async function fetchAlpacaOptionChain(filters: OptionChainFilters) {
  const feed = process.env.ALPACA_DATA_FEED ?? "indicative";
  const params = new URLSearchParams({
    feed,
    limit: String(filters.limit ?? 100)
  });

  if (filters.type) params.set("type", filters.type);
  if (filters.expirationDate) params.set("expiration_date", filters.expirationDate);
  if (filters.expirationDateGte) params.set("expiration_date_gte", filters.expirationDateGte);
  if (filters.expirationDateLte) params.set("expiration_date_lte", filters.expirationDateLte);
  if (filters.strikePriceGte !== undefined) params.set("strike_price_gte", String(filters.strikePriceGte));
  if (filters.strikePriceLte !== undefined) params.set("strike_price_lte", String(filters.strikePriceLte));

  const url = `https://data.alpaca.markets/v1beta1/options/snapshots/${encodeURIComponent(
    filters.underlyingSymbol.toUpperCase()
  )}?${params.toString()}`;
  const response = await fetch(url, {
    cache: "no-store",
    headers: alpacaHeaders()
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Alpaca option chain failed: ${response.status} ${body.slice(0, 240)}`);
  }

  const data = (await response.json()) as {
    snapshots?: Record<string, Record<string, unknown>>;
    next_page_token?: string;
  };
  const snapshots = data.snapshots ?? {};
  const contracts = Object.entries(snapshots).map(([symbol, snapshot]) => normalizeContract(symbol, snapshot));

  return {
    feed,
    contracts,
    nextPageToken: data.next_page_token ?? null
  };
}

export async function fetchAlpacaOptionSnapshot(contractSymbol: string) {
  const feed = process.env.ALPACA_DATA_FEED ?? "indicative";
  const params = new URLSearchParams({
    symbols: contractSymbol.toUpperCase(),
    feed,
    limit: "1"
  });
  const response = await fetch(`https://data.alpaca.markets/v1beta1/options/snapshots?${params.toString()}`, {
    cache: "no-store",
    headers: alpacaHeaders()
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Alpaca option snapshot failed: ${response.status} ${body.slice(0, 240)}`);
  }

  const data = (await response.json()) as {
    snapshots?: Record<string, Record<string, unknown>>;
  };
  const snapshot = data.snapshots?.[contractSymbol.toUpperCase()];
  return snapshot ? normalizeContract(contractSymbol.toUpperCase(), snapshot) : null;
}
