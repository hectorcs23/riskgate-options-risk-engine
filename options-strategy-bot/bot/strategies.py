from __future__ import annotations

from dataclasses import dataclass, asdict

from .config import BotConfig
from .features import MarketRegime, TechnicalFeatures
from .model import ScoreResult, evaluate_candidate
from .options import OptionStructure, iv_proxy, make_debit_spread


@dataclass(frozen=True)
class Candidate:
    symbol: str
    strategy: str
    score: ScoreResult
    structure: OptionStructure
    close: float

    def to_row(self) -> dict[str, object]:
        return {
            "symbol": self.symbol,
            "strategy": self.strategy,
            "direction": self.structure.direction,
            "decision": self.score.decision,
            "total_score": self.score.total_score,
            "market_score": self.score.market_score,
            "technical_score": self.score.technical_score,
            "options_score": self.score.options_score,
            "trade_score": self.score.trade_score,
            "close": self.close,
            "net_debit_usd": round(self.structure.net_debit_usd, 3),
            "max_loss_mxn": round(self.structure.max_loss_mxn, 0),
            "max_profit_mxn": round(self.structure.max_profit_mxn, 0),
            "reward_risk": round(self.structure.reward_risk, 2),
            "break_even": round(self.structure.break_even, 2),
            "net_delta": round(self.structure.net_delta, 4),
            "net_theta": round(self.structure.net_theta, 4),
            "implied_vol": round(self.structure.implied_vol, 4),
            "warnings": " | ".join(self.score.warnings)
        }


def build_candidates(symbol: str, features: TechnicalFeatures, regime: MarketRegime, config: BotConfig) -> list[Candidate]:
    iv = iv_proxy(features.realized_vol_20)
    candidates: list[Candidate] = []
    for strategy in config.strategy.enabled:
        structure = make_debit_spread(
            strategy=strategy,
            spot=features.close,
            dte=config.strategy.dte,
            iv=iv,
            usd_mxn=config.usd_mxn,
            slippage_bps=config.costs.slippage_bps
        )
        score = evaluate_candidate(
            regime=regime,
            features=features,
            structure=structure,
            max_risk_mxn=config.risk.max_risk_per_trade_mxn,
            allow_extended_moves=config.strategy.allow_extended_moves
        )
        candidates.append(Candidate(symbol, strategy, score, structure, features.close))
    return sorted(candidates, key=lambda item: item.score.total_score, reverse=True)
