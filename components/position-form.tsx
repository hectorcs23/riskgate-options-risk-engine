import type { Position } from "@prisma/client";
import { createPosition, updatePosition } from "@/app/actions";

const assetTypes = ["stock", "etf", "option", "cash"];
const markets = ["MX", "US"];
const currencies = ["MXN", "USD"];
const accounts = ["GBM", "Manual", "Other"];

export function PositionForm({
  portfolioId,
  position
}: {
  portfolioId: string;
  position?: Position;
}) {
  const action = position ? updatePosition : createPosition;

  return (
    <form action={action} className="grid gap-4">
      {position ? <input type="hidden" name="id" value={position.id} /> : null}
      <input type="hidden" name="portfolioId" value={portfolioId} />
      <div className="grid gap-4 md:grid-cols-4">
        <label>
          <span className="field-label">Symbol</span>
          <input className="field-input" name="symbol" required defaultValue={position?.symbol ?? ""} placeholder="AAPL" />
        </label>
        <label>
          <span className="field-label">Asset type</span>
          <select className="field-input" name="assetType" defaultValue={position?.assetType ?? "stock"}>
            {assetTypes.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="field-label">Market</span>
          <select className="field-input" name="market" defaultValue={position?.market ?? "US"}>
            {markets.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="field-label">Account</span>
          <select className="field-input" name="account" defaultValue={position?.account ?? "Manual"}>
            {accounts.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <label>
          <span className="field-label">Quantity</span>
          <input className="field-input" name="quantity" type="number" step="0.0001" required defaultValue={position?.quantity ?? ""} />
        </label>
        <label>
          <span className="field-label">Average cost</span>
          <input className="field-input" name="averageCost" type="number" step="0.01" required defaultValue={position?.averageCost ?? ""} />
        </label>
        <label>
          <span className="field-label">Current price</span>
          <input className="field-input" name="currentPrice" type="number" step="0.01" required defaultValue={position?.currentPrice ?? ""} />
        </label>
        <label>
          <span className="field-label">Currency</span>
          <select className="field-input" name="currency" defaultValue={position?.currency ?? "MXN"}>
            {currencies.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label>
        <span className="field-label">Notes</span>
        <textarea className="field-input min-h-20" name="notes" defaultValue={position?.notes ?? ""} />
      </label>

      <div>
        <button className="btn-primary" type="submit">
          {position ? "Save position" : "Add position"}
        </button>
      </div>
    </form>
  );
}
