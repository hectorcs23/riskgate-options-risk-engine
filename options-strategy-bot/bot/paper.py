from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import date
import json
from pathlib import Path

from .strategies import Candidate


@dataclass(frozen=True)
class PaperPosition:
    id: str
    symbol: str
    strategy: str
    opened_at: str
    entry_value_mxn: float
    score: float
    status: str = "open"


def load_ledger(path: str | Path) -> list[dict]:
    ledger_path = Path(path)
    if not ledger_path.exists():
        return []
    return json.loads(ledger_path.read_text(encoding="utf-8"))


def save_ledger(path: str | Path, rows: list[dict]) -> None:
    ledger_path = Path(path)
    ledger_path.parent.mkdir(parents=True, exist_ok=True)
    ledger_path.write_text(json.dumps(rows, indent=2), encoding="utf-8")


def open_candidates(candidates: list[Candidate], ledger_path: str | Path, min_score: float, max_new: int) -> list[dict]:
    rows = load_ledger(ledger_path)
    open_symbols = {row["symbol"] for row in rows if row.get("status") == "open"}
    new_rows = 0
    for candidate in candidates:
        if new_rows >= max_new:
            break
        if candidate.symbol in open_symbols:
            continue
        if candidate.score.total_score < min_score or candidate.score.decision not in {"paper_small", "paper_normal"}:
            continue
        position = PaperPosition(
            id=f"{date.today().isoformat()}-{candidate.symbol}-{candidate.strategy}",
            symbol=candidate.symbol,
            strategy=candidate.strategy,
            opened_at=date.today().isoformat(),
            entry_value_mxn=round(candidate.structure.max_loss_mxn, 2),
            score=candidate.score.total_score
        )
        rows.append(asdict(position))
        open_symbols.add(candidate.symbol)
        new_rows += 1
    save_ledger(ledger_path, rows)
    return rows
