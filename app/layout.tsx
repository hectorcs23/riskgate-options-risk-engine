import type { Metadata } from "next";
import "./globals.css";
import { Sidebar } from "@/components/sidebar";
import { getPortfolios } from "@/lib/data";

export const metadata: Metadata = {
  title: "RiskGate",
  description: "Local-first portfolio and options risk management"
};

export const dynamic = "force-dynamic";

export default async function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  const portfolios = await getPortfolios();

  return (
    <html lang="en">
      <body className="font-sans">
        <div className="min-h-screen lg:flex">
          <Sidebar portfolios={portfolios.map((portfolio) => ({
            id: portfolio.id,
            name: portfolio.name,
            institution: portfolio.institution
          }))} />
          <main className="min-w-0 flex-1 px-4 py-5 sm:px-6 lg:px-8">
            <div className="mx-auto max-w-7xl">{children}</div>
          </main>
        </div>
      </body>
    </html>
  );
}
