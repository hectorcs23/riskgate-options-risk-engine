"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  BarChart3,
  BookOpenCheck,
  Brain,
  FileText,
  LayoutDashboard,
  ListChecks,
  Radar,
  Search,
  Settings,
  Telescope,
  WalletCards
} from "lucide-react";
import { clsx } from "clsx";

const navItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/portfolio", label: "Portfolio", icon: WalletCards },
  { href: "/discover", label: "Discover", icon: Radar },
  { href: "/watchlist", label: "Watchlist", icon: Telescope },
  { href: "/options-chain", label: "Options Chain", icon: Search },
  { href: "/trade-ideas", label: "Trade Ideas", icon: ListChecks },
  { href: "/risk-model", label: "Risk Model", icon: Brain },
  { href: "/model-guide", label: "Model Guide", icon: FileText },
  { href: "/journal", label: "Journal", icon: BookOpenCheck },
  { href: "/settings", label: "Settings", icon: Settings }
];

type PortfolioNavItem = {
  id: string;
  name: string;
  institution: string | null;
};

export function Sidebar({ portfolios }: { portfolios: PortfolioNavItem[] }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedPortfolio = searchParams.get("portfolio");
  const selectedPortfolio =
    portfolios.find((portfolio) => portfolio.id === requestedPortfolio)?.id ?? portfolios[0]?.id ?? "";

  function hrefFor(path: string) {
    if (!selectedPortfolio) return path;
    return `${path}?portfolio=${encodeURIComponent(selectedPortfolio)}`;
  }

  function changePortfolio(portfolioId: string) {
    const next = new URLSearchParams(searchParams.toString());
    next.set("portfolio", portfolioId);
    router.push(`${pathname}?${next.toString()}`);
  }

  return (
    <aside className="border-b border-stone-200 bg-white/90 px-4 py-4 backdrop-blur lg:sticky lg:top-0 lg:h-screen lg:w-72 lg:border-b-0 lg:border-r lg:px-5">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-md bg-ink text-white">
          <BarChart3 className="h-5 w-5" aria-hidden="true" />
        </div>
        <div>
          <p className="text-lg font-bold text-ink">RiskGate</p>
          <p className="text-xs font-medium text-stone-500">Options approval console</p>
        </div>
      </div>

      <label className="mt-5 block">
        <span className="field-label">Portfolio</span>
        <select
          className="field-input"
          value={selectedPortfolio}
          onChange={(event) => changePortfolio(event.target.value)}
        >
          {portfolios.map((portfolio) => (
            <option key={portfolio.id} value={portfolio.id}>
              {portfolio.name}
              {portfolio.institution ? ` - ${portfolio.institution}` : ""}
            </option>
          ))}
        </select>
      </label>

      <nav className="mt-5 grid grid-cols-2 gap-2 lg:grid-cols-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = pathname === item.href;

          return (
            <Link
              className={clsx(
                "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-semibold transition",
                isActive ? "bg-ink text-white" : "text-stone-600 hover:bg-mist hover:text-ink"
              )}
              href={hrefFor(item.href)}
              key={item.href}
            >
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="truncate">{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className="mt-6 hidden rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950 lg:block">
        <p className="font-semibold">Safety rail</p>
        <p className="mt-1 text-xs leading-5">
          Options can expire worthless. This tool supports decisions; it does not provide
          financial advice or broker automation.
        </p>
      </div>
    </aside>
  );
}
