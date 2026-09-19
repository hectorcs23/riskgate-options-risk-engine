import type { ReactNode } from "react";

type StatCardProps = {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
};

export function StatCard({ label, value, detail }: StatCardProps) {
  return (
    <div className="panel-pad">
      <p className="field-label">{label}</p>
      <div className="mt-2 text-2xl font-bold text-ink">{value}</div>
      {detail ? <div className="mt-2 text-sm text-stone-500">{detail}</div> : null}
    </div>
  );
}
