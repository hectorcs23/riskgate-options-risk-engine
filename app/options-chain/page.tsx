import Link from "next/link";
import { ExternalLink, Search } from "lucide-react";
import { alpacaConfigured, fetchAlpacaOptionChain, type AlpacaOptionContract, type OptionType } from "@/lib/alpaca-options";
import { getSelectedPortfolio } from "@/lib/data";
import { formatCurrency, formatNumber } from "@/lib/format";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<Record<string, string | undefined>>;
};

function numberParam(value?: string) {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function contractDte(contract: AlpacaOptionContract) {
  if (!contract.expirationDate) return null;
  const expiration = new Date(`${contract.expirationDate}T00:00:00`);
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.max(Math.ceil((expiration.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)), 0);
}

function dateAtLeastDte(days: number) {
  const today = new Date();
  const target = new Date(today.getFullYear(), today.getMonth(), today.getDate() + Math.max(days, 0));
  const year = target.getFullYear();
  const month = String(target.getMonth() + 1).padStart(2, "0");
  const day = String(target.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function cleanNumber(value: number | null | undefined, digits = 4) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  return Number(value.toFixed(digits)).toString();
}

function prefillHref(contract: AlpacaOptionContract, portfolioId: string) {
  const params = new URLSearchParams({
    portfolio: portfolioId,
    contract: contract.symbol,
    symbol: contract.underlyingSymbol,
    type: contract.optionType,
    expiration: contract.expirationDate ?? "",
    strike: cleanNumber(contract.strikePrice, 2),
    bid: cleanNumber(contract.bid, 4),
    ask: cleanNumber(contract.ask, 4),
    mid: cleanNumber(contract.mid, 4),
    spread: cleanNumber(contract.bidAskSpreadPercent, 2),
    volume: cleanNumber(contract.volume, 0),
    openInterest: cleanNumber(contract.openInterest, 0),
    dte: cleanNumber(contractDte(contract), 0),
    delta: cleanNumber(contract.delta, 4),
    gamma: cleanNumber(contract.gamma, 4),
    theta: cleanNumber(contract.theta, 4),
    vega: cleanNumber(contract.vega, 4),
    rho: cleanNumber(contract.rho, 4),
    iv: cleanNumber(contract.impliedVolatility, 4),
    underlyingPrice: cleanNumber(contract.underlyingPrice, 4),
    breakEven: cleanNumber(contract.breakEvenPrice, 4)
  });

  return `/trade-ideas?${params.toString()}`;
}

export default async function OptionsChainPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const { selectedPortfolio } = await getSelectedPortfolio(params?.portfolio);
  const symbol = (params?.symbol ?? "AAPL").toUpperCase();
  const type = ((params?.type ?? "call") === "put" ? "put" : "call") as OptionType;
  const expirationDate = params?.expirationDate || undefined;
  const strikePriceGte = numberParam(params?.strikeMin);
  const strikePriceLte = numberParam(params?.strikeMax);
  const minDte = numberParam(params?.minDte) ?? 7;
  const limit = numberParam(params?.limit) ?? 100;
  const portfolioQuery = `portfolio=${encodeURIComponent(selectedPortfolio.id)}`;
  let contracts: AlpacaOptionContract[] = [];
  let error: string | null = null;
  let feed = process.env.ALPACA_DATA_FEED ?? "indicative";

  if (alpacaConfigured()) {
    try {
      const result = await fetchAlpacaOptionChain({
        underlyingSymbol: symbol,
        type,
        expirationDate,
        expirationDateGte: expirationDate ? undefined : dateAtLeastDte(minDte),
        strikePriceGte,
        strikePriceLte,
        limit
      });
      feed = result.feed;
      contracts = result.contracts
        .filter((contract) => contract.optionType === type)
        .filter((contract) => {
          const dte = contractDte(contract);
          return dte === null || dte >= minDte;
        })
        .sort((left, right) => {
          const leftDte = contractDte(left) ?? 99999;
          const rightDte = contractDte(right) ?? 99999;
          if (leftDte !== rightDte) return leftDte - rightDte;
          return (left.strikePrice ?? 0) - (right.strikePrice ?? 0);
        });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : "Alpaca option chain request failed.";
    }
  } else {
    error = "Alpaca credentials are not configured in .env.local.";
  }

  return (
    <div className="grid gap-6">
      <header>
        <p className="field-label">Read-only Alpaca data</p>
        <h1 className="mt-2 text-3xl font-bold text-ink">Options Chain Analyzer</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-600">
          Pull bid/ask, open interest, IV, and Greeks from Alpaca. Use a contract to prefill a trade idea, then keep approval manual.
        </p>
      </header>

      <section className="panel-pad">
        <h2 className="text-lg font-bold text-ink">Chain Search</h2>
        <form className="mt-4 grid gap-4 md:grid-cols-8" action="/options-chain">
          <input type="hidden" name="portfolio" value={selectedPortfolio.id} />
          <label>
            <span className="field-label">Underlying</span>
            <input className="field-input" name="symbol" defaultValue={symbol} placeholder="AAPL" />
          </label>
          <label>
            <span className="field-label">Type</span>
            <select className="field-input" name="type" defaultValue={type}>
              <option value="call">Call</option>
              <option value="put">Put</option>
            </select>
          </label>
          <label>
            <span className="field-label">Expiration</span>
            <input className="field-input" name="expirationDate" type="date" defaultValue={expirationDate ?? ""} />
          </label>
          <label>
            <span className="field-label">Strike min</span>
            <input className="field-input" name="strikeMin" type="number" step="0.01" defaultValue={params?.strikeMin ?? ""} />
          </label>
          <label>
            <span className="field-label">Strike max</span>
            <input className="field-input" name="strikeMax" type="number" step="0.01" defaultValue={params?.strikeMax ?? ""} />
          </label>
          <label>
            <span className="field-label">Limit</span>
            <input className="field-input" name="limit" type="number" step="1" defaultValue={String(limit)} />
          </label>
          <label>
            <span className="field-label">Min DTE</span>
            <input className="field-input" name="minDte" type="number" min="0" step="1" defaultValue={String(minDte)} />
          </label>
          <div className="flex items-end">
            <button className="btn-primary w-full" type="submit">
              <Search className="h-4 w-4" aria-hidden="true" />
              Search
            </button>
          </div>
        </form>
      </section>

      <section className="rounded-lg border border-sky-200 bg-sky-50 p-5 text-sm leading-6 text-sky-950">
        <p className="font-bold">Provider status</p>
        <p className="mt-1">
          Provider: Alpaca. Feed: {feed}. This page is read-only and does not place trades.
        </p>
      </section>

      {error ? (
        <section className="rounded-lg border border-red-200 bg-red-50 p-5 text-sm leading-6 text-red-950">
          <p className="font-bold">Alpaca request failed</p>
          <p className="mt-1">{error}</p>
        </section>
      ) : null}

      <section className="panel overflow-hidden">
        <div className="flex flex-col gap-2 p-5 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-lg font-bold text-ink">{symbol} {type}s</h2>
            <p className="text-sm text-stone-500">
              {contracts.length} contracts returned. Showing DTE {minDte}+ by default to avoid same-day expirations.
            </p>
          </div>
          <a
            className="btn-secondary"
            href="https://docs.alpaca.markets/reference/optionchain"
            rel="noreferrer"
            target="_blank"
          >
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
            Alpaca docs
          </a>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1320px]">
            <thead className="table-head">
              <tr>
                <th className="px-4 py-3">Contract</th>
                <th className="px-4 py-3">Action</th>
                <th className="px-4 py-3 text-right">Strike</th>
                <th className="px-4 py-3">Exp</th>
                <th className="px-4 py-3 text-right">DTE</th>
                <th className="px-4 py-3 text-right">Bid</th>
                <th className="px-4 py-3 text-right">Ask</th>
                <th className="px-4 py-3 text-right">Spread</th>
                <th className="px-4 py-3 text-right">Vol</th>
                <th className="px-4 py-3 text-right">OI</th>
                <th className="px-4 py-3 text-right">IV</th>
                <th className="px-4 py-3 text-right">Delta</th>
                <th className="px-4 py-3 text-right">Theta</th>
                <th className="px-4 py-3 text-right">Vega</th>
              </tr>
            </thead>
            <tbody>
              {contracts.map((contract) => (
                <tr key={contract.symbol}>
                  <td className="table-cell font-bold text-ink">{contract.symbol}</td>
                  <td className="table-cell">
                    <Link className="btn-secondary" href={prefillHref(contract, selectedPortfolio.id)}>
                      Use in idea
                    </Link>
                  </td>
                  <td className="table-cell text-right">{formatNumber(contract.strikePrice, 2)}</td>
                  <td className="table-cell">{contract.expirationDate ?? "-"}</td>
                  <td className="table-cell text-right">{contractDte(contract) ?? "-"}</td>
                  <td className="table-cell text-right">{contract.bid === null ? "-" : formatCurrency(contract.bid, "USD")}</td>
                  <td className="table-cell text-right">{contract.ask === null ? "-" : formatCurrency(contract.ask, "USD")}</td>
                  <td className="table-cell text-right">{contract.bidAskSpreadPercent === null ? "-" : `${formatNumber(contract.bidAskSpreadPercent, 2)}%`}</td>
                  <td className="table-cell text-right">{formatNumber(contract.volume, 0)}</td>
                  <td className="table-cell text-right">{formatNumber(contract.openInterest, 0)}</td>
                  <td className="table-cell text-right">{contract.impliedVolatility === null ? "-" : `${formatNumber(contract.impliedVolatility * 100, 1)}%`}</td>
                  <td className="table-cell text-right">{formatNumber(contract.delta, 3)}</td>
                  <td className="table-cell text-right">{formatNumber(contract.theta, 3)}</td>
                  <td className="table-cell text-right">{formatNumber(contract.vega, 3)}</td>
                </tr>
              ))}
              {!contracts.length ? (
                <tr>
                  <td className="table-cell text-stone-500" colSpan={14}>
                    No contracts returned. Try a wider strike range, lower Min DTE, remove expiration, or check Alpaca data permissions.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
