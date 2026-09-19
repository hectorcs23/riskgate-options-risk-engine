import { Upload } from "lucide-react";
import { importGbmPortfolioExcel } from "@/app/actions";

export function GbmImportForm({ portfolioId }: { portfolioId: string }) {
  return (
    <form action={importGbmPortfolioExcel} className="grid gap-4">
      <input type="hidden" name="portfolioId" value={portfolioId} />
      <div className="grid gap-4 md:grid-cols-4">
        <label className="md:col-span-2">
          <span className="field-label">GBM Excel file</span>
          <input className="field-input" name="gbmFile" type="file" accept=".xlsx,.xls" required />
        </label>
        <label>
          <span className="field-label">File currency</span>
          <select className="field-input" name="sourceCurrency" defaultValue="USD">
            <option value="USD">USD</option>
            <option value="MXN">MXN</option>
          </select>
        </label>
        <label>
          <span className="field-label">USD/MXN rate</span>
          <input className="field-input" name="usdMxnRate" type="number" step="0.0001" defaultValue={17.25} />
        </label>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <label className="flex items-center gap-2 text-sm font-semibold text-stone-700">
          <input name="replaceExisting" type="checkbox" defaultChecked />
          Replace current positions in this portfolio
        </label>
        <button className="btn-primary" type="submit">
          <Upload className="h-4 w-4" aria-hidden="true" />
          Import GBM file
        </button>
      </div>
    </form>
  );
}
