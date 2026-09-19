export function formatMXN(value: number | null | undefined) {
  return new Intl.NumberFormat("es-MX", {
    style: "currency",
    currency: "MXN",
    maximumFractionDigits: 0
  }).format(value ?? 0);
}

export function formatCurrency(value: number | null | undefined, currency = "USD") {
  return new Intl.NumberFormat(currency === "MXN" ? "es-MX" : "en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: currency === "MXN" ? 0 : 2
  }).format(value ?? 0);
}

export function formatPercent(value: number | null | undefined) {
  return new Intl.NumberFormat("es-MX", {
    style: "percent",
    maximumFractionDigits: 1
  }).format((value ?? 0) / 100);
}

export function formatNumber(value: number | null | undefined, digits = 1) {
  return new Intl.NumberFormat("es-MX", {
    maximumFractionDigits: digits
  }).format(value ?? 0);
}

export function decisionLabel(decision?: string | null) {
  if (!decision) return "Draft";
  return decision
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function decisionTone(decision?: string | null) {
  switch (decision) {
    case "approved_normal":
      return "border-emerald-200 bg-emerald-50 text-emerald-800";
    case "approved_small":
      return "border-lime-200 bg-lime-50 text-lime-800";
    case "watchlist":
      return "border-amber-200 bg-amber-50 text-amber-900";
    case "reject":
    case "rejected":
      return "border-red-200 bg-red-50 text-red-800";
    default:
      return "border-stone-200 bg-stone-50 text-stone-700";
  }
}
