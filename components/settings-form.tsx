import type { RiskSettings } from "@prisma/client";
import { updateRiskSettings } from "@/app/actions";

export function SettingsForm({ settings }: { settings: RiskSettings }) {
  return (
    <form action={updateRiskSettings} className="grid gap-5">
      <input type="hidden" name="portfolioId" value={settings.portfolioId} />
      <div className="grid gap-4 md:grid-cols-3">
        <label>
          <span className="field-label">Total portfolio value</span>
          <input className="field-input" name="totalPortfolioValue" type="number" step="1" defaultValue={settings.totalPortfolioValue} />
        </label>
        <label>
          <span className="field-label">Options sleeve %</span>
          <input className="field-input" name="optionsSleevePercent" type="number" step="0.1" defaultValue={settings.optionsSleevePercent} />
        </label>
        <label>
          <span className="field-label">Options sleeve MXN</span>
          <input className="field-input" name="maxOptionsSleeveMXN" type="number" step="1" defaultValue={settings.maxOptionsSleeveMXN} />
        </label>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <label>
          <span className="field-label">Base risk per trade %</span>
          <input className="field-input" name="baseRiskPerTradePercent" type="number" step="0.1" defaultValue={settings.baseRiskPerTradePercent} />
        </label>
        <label>
          <span className="field-label">Base risk per trade MXN</span>
          <input className="field-input" name="baseRiskPerTradeMXN" type="number" step="1" defaultValue={settings.baseRiskPerTradeMXN} />
        </label>
        <label>
          <span className="field-label">Monthly options loss %</span>
          <input className="field-input" name="maxMonthlyOptionsLossPercent" type="number" step="0.1" defaultValue={settings.maxMonthlyOptionsLossPercent} />
        </label>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <label>
          <span className="field-label">Monthly options loss MXN</span>
          <input className="field-input" name="maxMonthlyOptionsLossMXN" type="number" step="1" defaultValue={settings.maxMonthlyOptionsLossMXN} />
        </label>
        <label>
          <span className="field-label">Open options risk %</span>
          <input className="field-input" name="maxOpenOptionsRiskPercent" type="number" step="0.1" defaultValue={settings.maxOpenOptionsRiskPercent} />
        </label>
        <label>
          <span className="field-label">Open options risk MXN</span>
          <input className="field-input" name="maxOpenOptionsRiskMXN" type="number" step="1" defaultValue={settings.maxOpenOptionsRiskMXN} />
        </label>
      </div>

      <div className="grid gap-4 rounded-lg border border-stone-200 bg-stone-50 p-4 md:grid-cols-3">
        <label className="flex items-center gap-2 text-sm font-semibold text-stone-700">
          <input name="enableYahooFinanceSentiment" type="checkbox" defaultChecked={settings.enableYahooFinanceSentiment} />
          Enable Yahoo Finance sentiment
        </label>
        <label className="flex items-center gap-2 text-sm font-semibold text-stone-700">
          <input name="eventRiskEnabled" type="checkbox" defaultChecked={settings.eventRiskEnabled} />
          Enable event risk overlay
        </label>
        <label>
          <span className="field-label">Sentiment lookback days</span>
          <input className="field-input" name="sentimentLookbackDays" type="number" step="1" defaultValue={settings.sentimentLookbackDays} />
        </label>
        <label>
          <span className="field-label">Max news documents</span>
          <input className="field-input" name="sentimentMaxDocuments" type="number" step="1" defaultValue={settings.sentimentMaxDocuments} />
        </label>
      </div>

      <div>
        <button className="btn-primary" type="submit">
          Save risk settings
        </button>
      </div>
    </form>
  );
}
