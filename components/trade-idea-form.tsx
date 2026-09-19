import type { OptionLeg, TradeIdea } from "@prisma/client";
import { createTradeIdea, updateTradeIdea } from "@/app/actions";

const directions = ["bullish", "bearish", "neutral"];
const strategies = ["long_call", "long_put", "debit_spread", "bull_call_debit_spread", "bear_put_debit_spread", "protective_put", "collar"];
const statuses = ["draft", "watchlist", "entered"];
const trendChoices = ["bullish", "neutral", "bearish"];
const vixChoices = ["low", "normal", "elevated", "spiking"];
const breadthChoices = ["strong", "neutral", "weak"];
const macroChoices = ["low", "medium", "high"];
const technicalTrendChoices = ["uptrend", "sideways", "downtrend"];
const aboveBelow = ["above", "below"];
const rsiChoices = ["oversold", "neutral", "overbought"];
const volumeChoices = ["strong", "normal", "weak"];
const qualityChoices = ["good", "average", "poor"];

function toDateInput(date?: Date | null) {
  return date ? date.toISOString().slice(0, 10) : "";
}

function SelectField({
  label,
  name,
  choices,
  value
}: {
  label: string;
  name: string;
  choices: string[];
  value?: string | null;
}) {
  return (
    <label>
      <span className="field-label">{label}</span>
      <select className="field-input" name={name} defaultValue={value ?? choices[0]}>
        {choices.map((choice) => (
          <option key={choice} value={choice}>
            {choice.replaceAll("_", " ")}
          </option>
        ))}
      </select>
    </label>
  );
}

export function TradeIdeaForm({
  portfolioId,
  idea,
  defaults
}: {
  portfolioId: string;
  idea?: TradeIdea & { optionLegs?: OptionLeg[] };
  defaults?: Partial<TradeIdea> & { optionLegs?: Partial<OptionLeg>[] };
}) {
  const action = idea ? updateTradeIdea : createTradeIdea;
  const values = idea ?? defaults;
  const legacyLeg =
    values?.strikePrice || values?.optionContractSymbol
      ? [
          {
            symbol: values.optionContractSymbol,
            underlying: values.symbol,
            optionType: values.optionType ?? "call",
            side: "long",
            quantity: 1,
            expirationDate: values.expirationDate,
            strike: values.strikePrice,
            bid: values.contractBid,
            ask: values.contractAsk,
            mid: values.contractMid,
            spreadPercent: values.bidAskSpreadPercent,
            impliedVol: values.contractImpliedVolatility,
            ivRank: values.impliedVolatilityRank,
            delta: values.contractDelta,
            gamma: values.contractGamma,
            theta: values.contractTheta,
            vega: values.contractVega,
            rho: values.contractRho,
            openInterest: values.openInterest,
            volume: values.optionVolume,
            dte: values.daysToExpiration
          }
        ]
      : [];
  const optionLegs = [...(values?.optionLegs?.length ? values.optionLegs : legacyLeg), {}, {}, {}, {}].slice(0, 4);

  return (
    <form action={action} className="grid gap-6">
      {idea ? <input type="hidden" name="id" value={idea.id} /> : null}
      <input type="hidden" name="portfolioId" value={portfolioId} />

      <section className="grid gap-4">
        <div>
          <h3 className="text-sm font-bold text-ink">Trade plan</h3>
          <p className="text-sm text-stone-500">
            Approval requires a thesis, invalidation level, max loss, and exit plan.
          </p>
        </div>
        <div className="grid gap-4 md:grid-cols-4">
          <label>
            <span className="field-label">Symbol</span>
            <input className="field-input" name="symbol" required defaultValue={values?.symbol ?? ""} placeholder="NVDA" />
          </label>
          <SelectField label="Direction" name="direction" choices={directions} value={values?.direction} />
          <SelectField label="Strategy" name="strategy" choices={strategies} value={values?.strategy} />
          <SelectField label="Status intent" name="status" choices={statuses} value={idea?.status === "entered" ? "entered" : idea?.status ?? "watchlist"} />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <label>
            <span className="field-label">Thesis</span>
            <textarea className="field-input min-h-24" name="thesis" defaultValue={values?.thesis ?? ""} placeholder="Why this trade and why options?" />
          </label>
          <label>
            <span className="field-label">Exit plan</span>
            <textarea className="field-input min-h-24" name="exitPlan" defaultValue={values?.exitPlan ?? ""} placeholder="Profit target, stop, time stop, and what invalidates the setup." />
          </label>
        </div>
        <div className="grid gap-4 md:grid-cols-4">
          <label>
            <span className="field-label">Catalyst</span>
            <input className="field-input" name="catalyst" defaultValue={values?.catalyst ?? ""} placeholder="Earnings, breakout, macro event" />
          </label>
          <label>
            <span className="field-label">Invalidation level</span>
            <input className="field-input" name="invalidationLevel" type="number" step="0.01" defaultValue={values?.invalidationLevel ?? ""} />
          </label>
          <label>
            <span className="field-label">Target price</span>
            <input className="field-input" name="targetPrice" type="number" step="0.01" defaultValue={values?.targetPrice ?? ""} />
          </label>
          <label>
            <span className="field-label">Expiration</span>
            <input className="field-input" name="expirationDate" type="date" defaultValue={toDateInput(values?.expirationDate)} />
          </label>
        </div>
        <div className="grid gap-4 md:grid-cols-4">
          <label>
            <span className="field-label">Premium cost</span>
            <input className="field-input" name="premiumCost" type="number" step="0.01" defaultValue={values?.premiumCost ?? ""} />
          </label>
          <label>
            <span className="field-label">Max loss</span>
            <input className="field-input" name="maxLoss" type="number" step="0.01" defaultValue={values?.maxLoss ?? ""} />
          </label>
          <label>
            <span className="field-label">Expected reward</span>
            <input className="field-input" name="expectedReward" type="number" step="0.01" defaultValue={values?.expectedReward ?? ""} />
          </label>
          <label className="mt-6 flex items-center gap-2 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-sm font-semibold text-stone-700">
            <input name="isChasing" type="checkbox" defaultChecked={values?.isChasing ?? false} />
            Chasing setup
          </label>
        </div>
      </section>

      <section className="grid gap-4">
        <h3 className="text-sm font-bold text-ink">Alpaca contract data</h3>
        <div className="grid gap-4 md:grid-cols-4">
          <label>
            <span className="field-label">Contract symbol</span>
            <input className="field-input" name="optionContractSymbol" defaultValue={values?.optionContractSymbol ?? ""} placeholder="AAPL260619C00200000" />
          </label>
          <SelectField label="Option type" name="optionType" choices={["call", "put"]} value={values?.optionType} />
          <label>
            <span className="field-label">Long strike</span>
            <input className="field-input" name="strikePrice" type="number" step="0.01" defaultValue={values?.strikePrice ?? ""} />
          </label>
          <label>
            <span className="field-label">Short strike</span>
            <input className="field-input" name="shortStrikePrice" type="number" step="0.01" defaultValue={values?.shortStrikePrice ?? ""} />
          </label>
        </div>
        <div className="grid gap-4 md:grid-cols-5">
          <label>
            <span className="field-label">Bid</span>
            <input className="field-input" name="contractBid" type="number" step="0.01" defaultValue={values?.contractBid ?? ""} />
          </label>
          <label>
            <span className="field-label">Ask</span>
            <input className="field-input" name="contractAsk" type="number" step="0.01" defaultValue={values?.contractAsk ?? ""} />
          </label>
          <label>
            <span className="field-label">Mid</span>
            <input className="field-input" name="contractMid" type="number" step="0.01" defaultValue={values?.contractMid ?? ""} />
          </label>
          <label>
            <span className="field-label">Underlying</span>
            <input className="field-input" name="contractUnderlyingPrice" type="number" step="0.01" defaultValue={values?.contractUnderlyingPrice ?? ""} />
          </label>
          <label>
            <span className="field-label">Break even</span>
            <input className="field-input" name="contractBreakEvenPrice" type="number" step="0.01" defaultValue={values?.contractBreakEvenPrice ?? ""} />
          </label>
        </div>
        <div className="grid gap-4 md:grid-cols-6">
          <label>
            <span className="field-label">Delta</span>
            <input className="field-input" name="contractDelta" type="number" step="0.0001" defaultValue={values?.contractDelta ?? ""} />
          </label>
          <label>
            <span className="field-label">Gamma</span>
            <input className="field-input" name="contractGamma" type="number" step="0.0001" defaultValue={values?.contractGamma ?? ""} />
          </label>
          <label>
            <span className="field-label">Theta</span>
            <input className="field-input" name="contractTheta" type="number" step="0.0001" defaultValue={values?.contractTheta ?? ""} />
          </label>
          <label>
            <span className="field-label">Vega</span>
            <input className="field-input" name="contractVega" type="number" step="0.0001" defaultValue={values?.contractVega ?? ""} />
          </label>
          <label>
            <span className="field-label">Rho</span>
            <input className="field-input" name="contractRho" type="number" step="0.0001" defaultValue={values?.contractRho ?? ""} />
          </label>
          <label>
            <span className="field-label">IV</span>
            <input className="field-input" name="contractImpliedVolatility" type="number" step="0.0001" defaultValue={values?.contractImpliedVolatility ?? ""} />
          </label>
        </div>
        <input type="hidden" name="contractSnapshotAt" value={values?.contractSnapshotAt?.toISOString() ?? ""} />
      </section>

      <section className="grid gap-4">
        <div>
          <h3 className="text-sm font-bold text-ink">Option legs</h3>
          <p className="text-sm text-stone-500">
            Use one row for long calls/puts, two rows for debit spreads, and long/short side to model strategy-level payoff.
          </p>
        </div>
        <div className="grid gap-3">
          {optionLegs.map((leg, index) => (
            <div className="rounded-lg border border-stone-200 bg-stone-50 p-3" key={index}>
              <div className="mb-3 flex items-center justify-between gap-3">
                <p className="text-sm font-bold text-ink">Leg {index + 1}</p>
                <label className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-stone-600">
                  <input
                    name={`leg${index}Enabled`}
                    type="checkbox"
                    defaultChecked={Boolean((leg as Partial<OptionLeg>).strike || (leg as Partial<OptionLeg>).symbol)}
                  />
                  Use leg
                </label>
              </div>
              <div className="grid gap-3 md:grid-cols-6">
                <label>
                  <span className="field-label">Contract</span>
                  <input className="field-input" name={`leg${index}Symbol`} defaultValue={(leg as Partial<OptionLeg>).symbol ?? ""} />
                </label>
                <label>
                  <span className="field-label">Underlying</span>
                  <input className="field-input" name={`leg${index}Underlying`} defaultValue={(leg as Partial<OptionLeg>).underlying ?? values?.symbol ?? ""} />
                </label>
                <label>
                  <span className="field-label">Type</span>
                  <select className="field-input" name={`leg${index}OptionType`} defaultValue={(leg as Partial<OptionLeg>).optionType ?? values?.optionType ?? "call"}>
                    <option value="call">call</option>
                    <option value="put">put</option>
                  </select>
                </label>
                <label>
                  <span className="field-label">Side</span>
                  <select className="field-input" name={`leg${index}Side`} defaultValue={(leg as Partial<OptionLeg>).side ?? "long"}>
                    <option value="long">long</option>
                    <option value="short">short</option>
                  </select>
                </label>
                <label>
                  <span className="field-label">Qty</span>
                  <input className="field-input" name={`leg${index}Quantity`} type="number" step="1" defaultValue={(leg as Partial<OptionLeg>).quantity ?? 1} />
                </label>
                <label>
                  <span className="field-label">Exp</span>
                  <input className="field-input" name={`leg${index}ExpirationDate`} type="date" defaultValue={toDateInput((leg as Partial<OptionLeg>).expirationDate ?? values?.expirationDate)} />
                </label>
              </div>
              <div className="mt-3 grid gap-3 md:grid-cols-8">
                <label>
                  <span className="field-label">Strike</span>
                  <input className="field-input" name={`leg${index}Strike`} type="number" step="0.01" defaultValue={(leg as Partial<OptionLeg>).strike ?? ""} />
                </label>
                <label>
                  <span className="field-label">Bid</span>
                  <input className="field-input" name={`leg${index}Bid`} type="number" step="0.01" defaultValue={(leg as Partial<OptionLeg>).bid ?? ""} />
                </label>
                <label>
                  <span className="field-label">Ask</span>
                  <input className="field-input" name={`leg${index}Ask`} type="number" step="0.01" defaultValue={(leg as Partial<OptionLeg>).ask ?? ""} />
                </label>
                <label>
                  <span className="field-label">Mid</span>
                  <input className="field-input" name={`leg${index}Mid`} type="number" step="0.01" defaultValue={(leg as Partial<OptionLeg>).mid ?? ""} />
                </label>
                <label>
                  <span className="field-label">Spread %</span>
                  <input className="field-input" name={`leg${index}SpreadPercent`} type="number" step="0.1" defaultValue={(leg as Partial<OptionLeg>).spreadPercent ?? ""} />
                </label>
                <label>
                  <span className="field-label">IV</span>
                  <input className="field-input" name={`leg${index}ImpliedVol`} type="number" step="0.0001" defaultValue={(leg as Partial<OptionLeg>).impliedVol ?? ""} />
                </label>
                <label>
                  <span className="field-label">Vol</span>
                  <input className="field-input" name={`leg${index}Volume`} type="number" step="1" defaultValue={(leg as Partial<OptionLeg>).volume ?? ""} />
                </label>
                <label>
                  <span className="field-label">OI</span>
                  <input className="field-input" name={`leg${index}OpenInterest`} type="number" step="1" defaultValue={(leg as Partial<OptionLeg>).openInterest ?? ""} />
                </label>
              </div>
              <div className="mt-3 grid gap-3 md:grid-cols-6">
                <label>
                  <span className="field-label">Delta</span>
                  <input className="field-input" name={`leg${index}Delta`} type="number" step="0.0001" defaultValue={(leg as Partial<OptionLeg>).delta ?? ""} />
                </label>
                <label>
                  <span className="field-label">Gamma</span>
                  <input className="field-input" name={`leg${index}Gamma`} type="number" step="0.0001" defaultValue={(leg as Partial<OptionLeg>).gamma ?? ""} />
                </label>
                <label>
                  <span className="field-label">Theta</span>
                  <input className="field-input" name={`leg${index}Theta`} type="number" step="0.0001" defaultValue={(leg as Partial<OptionLeg>).theta ?? ""} />
                </label>
                <label>
                  <span className="field-label">Vega</span>
                  <input className="field-input" name={`leg${index}Vega`} type="number" step="0.0001" defaultValue={(leg as Partial<OptionLeg>).vega ?? ""} />
                </label>
                <label>
                  <span className="field-label">Rho</span>
                  <input className="field-input" name={`leg${index}Rho`} type="number" step="0.0001" defaultValue={(leg as Partial<OptionLeg>).rho ?? ""} />
                </label>
                <label>
                  <span className="field-label">DTE</span>
                  <input className="field-input" name={`leg${index}Dte`} type="number" step="1" defaultValue={(leg as Partial<OptionLeg>).dte ?? ""} />
                </label>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="grid gap-4">
        <h3 className="text-sm font-bold text-ink">Market regime</h3>
        <div className="grid gap-4 md:grid-cols-5">
          <SelectField label="SPY trend" name="spyTrend" choices={trendChoices} value={values?.spyTrend} />
          <SelectField label="QQQ trend" name="qqqTrend" choices={trendChoices} value={values?.qqqTrend} />
          <SelectField label="VIX" name="vixCondition" choices={vixChoices} value={values?.vixCondition} />
          <SelectField label="Breadth" name="marketBreadth" choices={breadthChoices} value={values?.marketBreadth} />
          <SelectField label="Macro risk" name="macroRisk" choices={macroChoices} value={values?.macroRisk} />
        </div>
      </section>

      <section className="grid gap-4">
        <h3 className="text-sm font-bold text-ink">Technical setup</h3>
        <div className="grid gap-4 md:grid-cols-6">
          <SelectField label="Trend" name="trend" choices={technicalTrendChoices} value={values?.trend} />
          <SelectField label="Vs 20MA" name="priceVs20MA" choices={aboveBelow} value={values?.priceVs20MA} />
          <SelectField label="Vs 50MA" name="priceVs50MA" choices={aboveBelow} value={values?.priceVs50MA} />
          <SelectField label="RSI" name="rsiCondition" choices={rsiChoices} value={values?.rsiCondition} />
          <SelectField label="Volume" name="volumeCondition" choices={volumeChoices} value={values?.volumeCondition} />
          <SelectField label="S/R quality" name="supportResistanceQuality" choices={qualityChoices} value={values?.supportResistanceQuality} />
        </div>
      </section>

      <section className="grid gap-4">
        <h3 className="text-sm font-bold text-ink">Options quality</h3>
        <div className="grid gap-4 md:grid-cols-5">
          <label>
            <span className="field-label">Bid/ask spread %</span>
            <input className="field-input" name="bidAskSpreadPercent" type="number" step="0.1" defaultValue={values?.bidAskSpreadPercent ?? 8} />
          </label>
          <label>
            <span className="field-label">Volume</span>
            <input className="field-input" name="optionVolume" type="number" step="1" defaultValue={values?.optionVolume ?? 100} />
          </label>
          <label>
            <span className="field-label">Open interest</span>
            <input className="field-input" name="openInterest" type="number" step="1" defaultValue={values?.openInterest ?? 500} />
          </label>
          <label>
            <span className="field-label">DTE</span>
            <input className="field-input" name="daysToExpiration" type="number" step="1" defaultValue={values?.daysToExpiration ?? 30} />
          </label>
          <label>
            <span className="field-label">IV rank</span>
            <input className="field-input" name="impliedVolatilityRank" type="number" step="1" defaultValue={values?.impliedVolatilityRank ?? ""} />
          </label>
        </div>
        <label className="max-w-sm">
          <span className="field-label">Premium as % of portfolio</span>
          <input className="field-input" name="premiumAsPercentOfPortfolio" type="number" step="0.01" defaultValue={values?.premiumAsPercentOfPortfolio ?? 0.5} />
        </label>
      </section>

      <div>
        <button className="btn-primary" type="submit">
          {idea ? "Re-score trade idea" : "Create and score idea"}
        </button>
      </div>
    </form>
  );
}
