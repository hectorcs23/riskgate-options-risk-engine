"use client";

import { useEffect, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { formatMXN } from "@/lib/format";

const palette = ["#4f6f52", "#b98223", "#ad4c32", "#41698a", "#7c5f9e"];

function useMounted() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  return mounted;
}

export function AllocationChart({
  data
}: {
  data: { name: string; value: number }[];
}) {
  const mounted = useMounted();
  const chartData = data.filter((item) => item.value > 0);

  if (!mounted || !chartData.length) {
    return <div className="flex h-64 items-center justify-center text-sm text-stone-500">No allocation data yet.</div>;
  }

  return (
    <div className="h-64 w-full min-w-0">
      <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
        <PieChart>
          <Pie data={chartData} dataKey="value" nameKey="name" innerRadius={58} outerRadius={86} paddingAngle={3}>
            {chartData.map((entry, index) => (
              <Cell key={entry.name} fill={palette[index % palette.length]} />
            ))}
          </Pie>
          <Tooltip formatter={(value) => formatMXN(Number(value))} />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

export function EquityCurve({
  data
}: {
  data: { label: string; value: number }[];
}) {
  const mounted = useMounted();

  if (!mounted) {
    return <div className="flex h-64 items-center justify-center text-sm text-stone-500">Loading chart...</div>;
  }

  return (
    <div className="h-64 w-full min-w-0">
      <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
        <AreaChart data={data}>
          <defs>
            <linearGradient id="equityFill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="5%" stopColor="#4f6f52" stopOpacity={0.35} />
              <stop offset="95%" stopColor="#4f6f52" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#e7e2d8" />
          <XAxis dataKey="label" tick={{ fontSize: 12 }} />
          <YAxis tick={{ fontSize: 12 }} width={72} tickFormatter={(value) => `${Math.round(Number(value) / 1000)}k`} />
          <Tooltip formatter={(value) => formatMXN(Number(value))} />
          <Area type="monotone" dataKey="value" stroke="#4f6f52" fill="url(#equityFill)" strokeWidth={2} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function IntradayPerformanceChart({
  data
}: {
  data: { label: string; value: number }[];
}) {
  const mounted = useMounted();

  if (!mounted || data.length < 2) {
    return <div className="flex h-64 items-center justify-center text-sm text-stone-500">Record at least two snapshots to see an intraday line.</div>;
  }

  return (
    <div className="h-64 w-full min-w-0">
      <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e7e2d8" />
          <XAxis dataKey="label" tick={{ fontSize: 12 }} />
          <YAxis tick={{ fontSize: 12 }} width={72} tickFormatter={(value) => `${Math.round(Number(value) / 1000)}k`} />
          <Tooltip formatter={(value) => formatMXN(Number(value))} />
          <Line type="monotone" dataKey="value" stroke="#b98223" strokeWidth={2} dot={{ r: 3 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function RiskBarChart({
  data
}: {
  data: { name: string; used: number; limit: number }[];
}) {
  const mounted = useMounted();

  if (!mounted) {
    return <div className="flex h-64 items-center justify-center text-sm text-stone-500">Loading chart...</div>;
  }

  return (
    <div className="h-64 w-full min-w-0">
      <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e7e2d8" />
          <XAxis dataKey="name" tick={{ fontSize: 12 }} />
          <YAxis tick={{ fontSize: 12 }} width={72} tickFormatter={(value) => `${Math.round(Number(value))}`} />
          <Tooltip formatter={(value) => formatMXN(Number(value))} />
          <Bar dataKey="limit" fill="#d9dfcf" radius={[4, 4, 0, 0]} />
          <Bar dataKey="used" fill="#ad4c32" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ScoreLineChart({
  data
}: {
  data: { symbol: string; score: number }[];
}) {
  const mounted = useMounted();

  if (!mounted) {
    return <div className="flex h-64 items-center justify-center text-sm text-stone-500">Loading chart...</div>;
  }

  return (
    <div className="h-64 w-full min-w-0">
      <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e7e2d8" />
          <XAxis dataKey="symbol" tick={{ fontSize: 12 }} />
          <YAxis domain={[0, 100]} tick={{ fontSize: 12 }} width={40} />
          <Tooltip />
          <Line type="monotone" dataKey="score" stroke="#41698a" strokeWidth={2} dot={{ r: 4 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function PayoffChart({
  data
}: {
  data: { underlyingPrice: number; pnl: number }[];
}) {
  const mounted = useMounted();

  if (!mounted || data.length < 2) {
    return <div className="flex h-64 items-center justify-center text-sm text-stone-500">No payoff curve available.</div>;
  }

  return (
    <div className="h-64 w-full min-w-0">
      <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e7e2d8" />
          <XAxis dataKey="underlyingPrice" tick={{ fontSize: 12 }} tickFormatter={(value) => Number(value).toFixed(0)} />
          <YAxis tick={{ fontSize: 12 }} width={72} tickFormatter={(value) => `${Math.round(Number(value))}`} />
          <Tooltip formatter={(value) => formatMXN(Number(value))} labelFormatter={(value) => `Underlying ${Number(value).toFixed(2)}`} />
          <Line type="monotone" dataKey="pnl" stroke="#4f6f52" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function MonteCarloHistogram({
  data
}: {
  data: { binStart: number; binEnd: number; count: number }[];
}) {
  const mounted = useMounted();

  if (!mounted || !data.length) {
    return <div className="flex h-64 items-center justify-center text-sm text-stone-500">No Monte Carlo histogram available.</div>;
  }

  return (
    <div className="h-64 w-full min-w-0">
      <ResponsiveContainer width="100%" height="100%" minWidth={1} minHeight={1}>
        <BarChart data={data.map((item) => ({ ...item, label: `${item.binStart.toFixed(0)}-${item.binEnd.toFixed(0)}` }))}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e7e2d8" />
          <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
          <YAxis tick={{ fontSize: 12 }} width={52} />
          <Tooltip />
          <Bar dataKey="count" fill="#41698a" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
