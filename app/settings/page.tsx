import { createPortfolio, deletePortfolio, updatePortfolio } from "@/app/actions";
import { SettingsForm } from "@/components/settings-form";
import { alpacaConfigured } from "@/lib/alpaca-options";
import { getRiskSettings, getSelectedPortfolio } from "@/lib/data";
import { formatMXN, formatNumber } from "@/lib/format";
import { redditConfigured } from "@/lib/sentiment/reddit/fetchRedditPosts";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams?: Promise<{ portfolio?: string }>;
};

function FeatureStatusCard({
  label,
  active,
  detail
}: {
  label: string;
  active: boolean;
  detail: string;
}) {
  return (
    <div
      className={`rounded-lg border p-4 ${
        active ? "border-emerald-200 bg-emerald-50 text-emerald-950" : "border-amber-200 bg-amber-50 text-amber-950"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="font-bold text-ink">{label}</p>
        <span
          className={`rounded-full px-2 py-1 text-xs font-bold uppercase tracking-wide ${
            active ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"
          }`}
        >
          {active ? "Active" : "Needs setup"}
        </span>
      </div>
      <p className="mt-2 text-sm leading-6">{detail}</p>
    </div>
  );
}

export default async function SettingsPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const { portfolios, selectedPortfolio } = await getSelectedPortfolio(params?.portfolio);
  const settings = await getRiskSettings(selectedPortfolio.id);
  const alpacaIsConfigured = alpacaConfigured();
  const redditIsConfigured = redditConfigured();

  return (
    <div className="grid gap-6">
      <header>
        <p className="field-label">Account-level guardrails</p>
        <h1 className="mt-2 text-3xl font-bold text-ink">Risk Settings</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-600">
          Viewing {selectedPortfolio.name}. Settings are account-specific, so each portfolio can keep its own value, sleeve, and loss caps.
        </p>
      </header>

      <section className="grid gap-4 md:grid-cols-4">
        <div className="panel-pad">
          <p className="field-label">Portfolio</p>
          <p className="mt-2 text-2xl font-bold text-ink">{formatMXN(settings.totalPortfolioValue)}</p>
        </div>
        <div className="panel-pad">
          <p className="field-label">Options sleeve</p>
          <p className="mt-2 text-2xl font-bold text-ink">{formatMXN(settings.maxOptionsSleeveMXN)}</p>
          <p className="mt-2 text-sm text-stone-500">{formatNumber(settings.optionsSleevePercent)}%</p>
        </div>
        <div className="panel-pad">
          <p className="field-label">Base risk</p>
          <p className="mt-2 text-2xl font-bold text-ink">{formatMXN(settings.baseRiskPerTradeMXN)}</p>
          <p className="mt-2 text-sm text-stone-500">{formatNumber(settings.baseRiskPerTradePercent)}%</p>
        </div>
        <div className="panel-pad">
          <p className="field-label">Monthly stop</p>
          <p className="mt-2 text-2xl font-bold text-ink">{formatMXN(settings.maxMonthlyOptionsLossMXN)}</p>
          <p className="mt-2 text-sm text-stone-500">{formatNumber(settings.maxMonthlyOptionsLossPercent)}%</p>
        </div>
      </section>

      <section className="panel-pad">
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="field-label">Feature availability</p>
            <h2 className="mt-2 text-lg font-bold text-ink">Live data and overlays</h2>
          </div>
          <p className="max-w-2xl text-sm leading-6 text-stone-600">
            These checks explain why a RiskGate feature is active, disabled by portfolio settings, or waiting for external credentials.
          </p>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <FeatureStatusCard
            active={alpacaIsConfigured}
            label="Alpaca options chain"
            detail={
              alpacaIsConfigured
                ? `Configured for read-only option snapshots using the ${process.env.ALPACA_DATA_FEED ?? "indicative"} feed.`
                : "Add APCA_API_KEY_ID and APCA_API_SECRET_KEY to .env.local to activate option-chain quotes."
            }
          />
          <FeatureStatusCard
            active={settings.enableYahooFinanceSentiment}
            label="Yahoo Finance sentiment"
            detail={
              settings.enableYahooFinanceSentiment
                ? "Enabled for trade-idea scoring and the Refresh Yahoo controls."
                : "Turn on Enable Yahoo Finance sentiment below to activate the public-news overlay."
            }
          />
          <FeatureStatusCard
            active={settings.eventRiskEnabled}
            label="Event-risk overlay"
            detail={
              settings.eventRiskEnabled
                ? "Enabled in this portfolio's risk model."
                : "Turn on Enable event risk overlay below to include event-risk penalties in scoring."
            }
          />
          <FeatureStatusCard
            active={redditIsConfigured}
            label="Credentialed Reddit sentiment"
            detail={
              redditIsConfigured
                ? "Configured for authenticated Reddit searches in the sentiment pipeline."
                : "Optional: add REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, and REDDIT_USER_AGENT to enable authenticated Reddit sentiment. Discover still uses public Reddit hot feeds."
            }
          />
        </div>
      </section>

      <section className="panel-pad">
        <h2 className="text-lg font-bold text-ink">Portfolio Accounts</h2>
        <p className="mt-2 text-sm leading-6 text-stone-600">
          Rename your accounts here, or add another portfolio when you open a new account.
        </p>

        <form action={createPortfolio} className="mt-4 grid gap-4 rounded-lg border border-stone-200 bg-stone-50 p-4 md:grid-cols-5">
          <label>
            <span className="field-label">Name</span>
            <input className="field-input" name="name" required placeholder="GBM+ Growth" />
          </label>
          <label>
            <span className="field-label">Institution</span>
            <input className="field-input" name="institution" placeholder="GBM" />
          </label>
          <label>
            <span className="field-label">Currency</span>
            <select className="field-input" name="baseCurrency" defaultValue="MXN">
              <option value="MXN">MXN</option>
              <option value="USD">USD</option>
            </select>
          </label>
          <label>
            <span className="field-label">Starting value</span>
            <input className="field-input" name="totalPortfolioValue" type="number" step="1" defaultValue={100000} />
          </label>
          <div className="flex items-end">
            <button className="btn-primary w-full" type="submit">
              Add account
            </button>
          </div>
        </form>

        <div className="mt-4 grid gap-3">
          {portfolios.map((portfolio) => (
            <div className="rounded-lg border border-stone-200 bg-white p-4" key={portfolio.id}>
              <form action={updatePortfolio} className="grid gap-4 md:grid-cols-5">
                <input type="hidden" name="id" value={portfolio.id} />
                <label>
                  <span className="field-label">Name</span>
                  <input className="field-input" name="name" required defaultValue={portfolio.name} />
                </label>
                <label>
                  <span className="field-label">Institution</span>
                  <input className="field-input" name="institution" defaultValue={portfolio.institution ?? ""} />
                </label>
                <label>
                  <span className="field-label">Currency</span>
                  <select className="field-input" name="baseCurrency" defaultValue={portfolio.baseCurrency}>
                    <option value="MXN">MXN</option>
                    <option value="USD">USD</option>
                  </select>
                </label>
                <label>
                  <span className="field-label">Notes</span>
                  <input className="field-input" name="notes" defaultValue={portfolio.notes ?? ""} />
                </label>
                <div className="flex items-end gap-2">
                  <button className="btn-secondary flex-1" type="submit">
                    Save
                  </button>
                </div>
              </form>
              <form action={deletePortfolio} className="mt-3">
                <input type="hidden" name="id" value={portfolio.id} />
                <button className="btn-danger" disabled={portfolios.length <= 1} type="submit">
                  Delete account
                </button>
              </form>
            </div>
          ))}
        </div>
      </section>

      <section className="panel-pad">
        <h2 className="text-lg font-bold text-ink">Edit Settings</h2>
        <div className="mt-4">
          <SettingsForm settings={settings} />
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-soft">
          <h2 className="font-bold text-ink">MVP deployment</h2>
          <p className="mt-2 text-sm leading-6 text-stone-600">
            Run locally as a Next app while the workflow is changing quickly. It keeps the database on your machine and makes iteration fast.
          </p>
        </div>
        <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-soft">
          <h2 className="font-bold text-ink">Windows .exe later</h2>
          <p className="mt-2 text-sm leading-6 text-stone-600">
            Wrap the same app with Tauri when the screens stabilize. Tauri gives a smaller installer than Electron and can keep SQLite local.
          </p>
        </div>
        <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-soft">
          <h2 className="font-bold text-ink">Cloud later</h2>
          <p className="mt-2 text-sm leading-6 text-stone-600">
            Add cloud sync only after import, backup, and privacy rules are clear. Read-only integrations should come before trading automation.
          </p>
        </div>
      </section>
    </div>
  );
}
