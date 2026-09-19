import type { TradeIdea, TradeJournal } from "@prisma/client";
import { createJournalEntry, updateJournalEntry } from "@/app/actions";

function toDateInput(date?: Date | null) {
  return date ? date.toISOString().slice(0, 10) : "";
}

export function JournalForm({
  entry,
  tradeIdeas
}: {
  entry?: TradeJournal;
  tradeIdeas: TradeIdea[];
}) {
  const action = entry ? updateJournalEntry : createJournalEntry;

  return (
    <form action={action} className="grid gap-4">
      {entry ? <input type="hidden" name="id" value={entry.id} /> : null}
      <div className="grid gap-4 md:grid-cols-4">
        <label>
          <span className="field-label">Trade idea</span>
          <select className="field-input" name="tradeIdeaId" defaultValue={entry?.tradeIdeaId ?? tradeIdeas[0]?.id}>
            {tradeIdeas.map((idea) => (
              <option key={idea.id} value={idea.id}>
                {idea.symbol} - {idea.strategy.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="field-label">Entry date</span>
          <input className="field-input" name="entryDate" type="date" required defaultValue={toDateInput(entry?.entryDate) || new Date().toISOString().slice(0, 10)} />
        </label>
        <label>
          <span className="field-label">Exit date</span>
          <input className="field-input" name="exitDate" type="date" defaultValue={toDateInput(entry?.exitDate)} />
        </label>
        <label>
          <span className="field-label">Result</span>
          <select className="field-input" name="result" defaultValue={entry?.result ?? ""}>
            <option value="">open</option>
            <option value="win">win</option>
            <option value="loss">loss</option>
            <option value="breakeven">breakeven</option>
          </select>
        </label>
      </div>
      <div className="grid gap-4 md:grid-cols-4">
        <label>
          <span className="field-label">Entry price</span>
          <input className="field-input" name="entryPrice" type="number" step="0.01" required defaultValue={entry?.entryPrice ?? ""} />
        </label>
        <label>
          <span className="field-label">Exit price</span>
          <input className="field-input" name="exitPrice" type="number" step="0.01" defaultValue={entry?.exitPrice ?? ""} />
        </label>
        <label>
          <span className="field-label">Realized P&L</span>
          <input className="field-input" name="realizedPnL" type="number" step="0.01" defaultValue={entry?.realizedPnL ?? ""} />
        </label>
        <label>
          <span className="field-label">Mistake tags</span>
          <input className="field-input" name="mistakeTags" defaultValue={entry?.mistakeTags ?? ""} placeholder="late_entry, oversized" />
        </label>
      </div>
      <label>
        <span className="field-label">Notes</span>
        <textarea className="field-input min-h-20" name="notes" defaultValue={entry?.notes ?? ""} />
      </label>
      <div>
        <button className="btn-primary" type="submit">
          {entry ? "Save journal entry" : "Add journal entry"}
        </button>
      </div>
    </form>
  );
}
