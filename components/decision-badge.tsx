import { clsx } from "clsx";
import { decisionLabel, decisionTone } from "@/lib/format";

export function DecisionBadge({ decision }: { decision?: string | null }) {
  return (
    <span
      className={clsx(
        "inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold",
        decisionTone(decision)
      )}
    >
      {decisionLabel(decision)}
    </span>
  );
}
