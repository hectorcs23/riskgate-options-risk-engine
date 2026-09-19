from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from dataclasses import asdict, dataclass, field, replace
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo


BOT_ROOT = Path(__file__).resolve().parents[1]
APP_ROOT = Path(__file__).resolve().parents[2]
if str(BOT_ROOT) not in sys.path:
    sys.path.insert(0, str(BOT_ROOT))

from bot.config import BotConfig, RiskConfig, load_config
from bot.data import Bar, load_history
from bot.features import build_market_regime, technical_features
from bot.strategies import Candidate, build_candidates


NY_TZ = ZoneInfo("America/New_York")
UTC = timezone.utc
CONTRACT_MULTIPLIER = 100
SUBMIT_DELAY_SEC = 0.5

PAPER_BASE_URL = "https://paper-api.alpaca.markets"
LIVE_BASE_URL = "https://api.alpaca.markets"
OCC_SYMBOL_RE = re.compile(r"^[A-Z]{1,6}\d{6}[CP]\d{8}$")


@dataclass(frozen=True)
class ExecutionConfig:
    mode: str = "debit_spread"
    state_file: str = "outputs/alpaca_riskgate_state.json"
    max_new_positions: int = 2
    max_open_positions: int = 5
    max_daily_orders: int = 10
    options_sleeve_pct: float = 1.0
    risk_per_trade_pct: float = 0.01
    min_open_interest: int = 100
    min_contract_price_usd: float = 0.05
    max_entry_debit_pct_of_portfolio: float = 0.03
    dte_tolerance_days: int = 14
    entry_price_pad_pct: float = 0.05
    exit_price_pad_pct: float = 0.05
    allow_watchlist_entries: bool = False
    allow_queued_orders: bool = True
    one_position_per_symbol: bool = True
    close_existing_positions: bool = True
    open_new_positions: bool = True
    take_profit_pct: float | None = None
    stop_loss_pct: float | None = None
    require_options_level: int | None = None

    @classmethod
    def from_config_file(cls, path: Path) -> "ExecutionConfig":
        raw = json.loads(path.read_text(encoding="utf-8"))
        data = raw.get("execution", {})
        cfg = cls()
        for key, value in data.items():
            if hasattr(cfg, key):
                cfg = replace(cfg, **{key: value})
        if cfg.mode not in {"debit_spread", "long_option"}:
            raise ValueError("execution.mode must be 'debit_spread' or 'long_option'")
        return cfg


@dataclass(frozen=True)
class AlpacaContract:
    symbol: str
    underlying_symbol: str
    option_type: str
    expiration_date: date
    strike_price: float
    close_price: float
    open_interest: int
    tradable: bool
    penny_program: bool = False

    def dte(self, today: date) -> int:
        return (self.expiration_date - today).days


@dataclass(frozen=True)
class ExecutionLeg:
    symbol: str
    opening_side: str
    option_type: str
    strike: float
    expiration_date: str
    entry_price: float


@dataclass(frozen=True)
class ExecutionPlan:
    candidate: Candidate
    order_payload: dict[str, Any]
    legs: tuple[ExecutionLeg, ...]
    entry_debit_usd: float
    max_loss_usd_per_unit: float
    qty: int
    reason: str


@dataclass
class ManagedPosition:
    id: str
    symbol: str
    strategy: str
    opened_at: str
    qty: int
    entry_debit_usd: float
    score: float
    legs: list[dict[str, Any]]
    status: str = "open"


@dataclass
class TraderState:
    positions: dict[str, dict[str, Any]] = field(default_factory=dict)
    last_run: str = ""
    run_history: list[dict[str, Any]] = field(default_factory=list)

    @classmethod
    def load(cls, path: Path) -> "TraderState":
        if not path.exists():
            return cls()
        return cls(**json.loads(path.read_text(encoding="utf-8")))

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(asdict(self), indent=2), encoding="utf-8")


def load_dot_env(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        name, value = stripped.split("=", 1)
        name = name.strip()
        if name and name not in os.environ:
            os.environ[name] = value.strip().strip('"').strip("'")


def as_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def as_int(value: Any, default: int = 0) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def parse_date(value: str) -> date | None:
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


def round_option_price(price: float) -> float:
    if price <= 0:
        return 0.01
    increment = 0.01 if price < 3 else 0.05
    return max(increment, round(round(price / increment) * increment, 2))


class AlpacaTradingClient:
    def __init__(self, paper: bool) -> None:
        key = os.getenv("APCA_API_KEY_ID")
        secret = os.getenv("APCA_API_SECRET_KEY")
        if not key or not secret:
            raise RuntimeError("Missing APCA_API_KEY_ID or APCA_API_SECRET_KEY.")
        self.base_url = PAPER_BASE_URL if paper else LIVE_BASE_URL
        self.headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "APCA-API-KEY-ID": key,
            "APCA-API-SECRET-KEY": secret,
        }

    def request(
        self,
        method: str,
        path: str,
        params: dict[str, str] | None = None,
        body: dict[str, Any] | None = None,
    ) -> Any:
        query = f"?{urlencode(params)}" if params else ""
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = Request(
            f"{self.base_url}{path}{query}",
            data=data,
            headers=self.headers,
            method=method,
        )
        try:
            with urlopen(request, timeout=45) as response:
                raw = response.read().decode("utf-8")
                return json.loads(raw) if raw else None
        except HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Alpaca {method} {path} failed: HTTP {error.code}: {detail[:500]}") from error
        except URLError as error:
            raise RuntimeError(f"Alpaca connection failed: {error.reason}") from error

    def account(self) -> dict[str, Any]:
        return self.request("GET", "/v2/account")

    def clock(self) -> dict[str, Any]:
        return self.request("GET", "/v2/clock")

    def positions(self) -> list[dict[str, Any]]:
        return self.request("GET", "/v2/positions")

    def submit_order(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self.request("POST", "/v2/orders", body=payload)

    def option_contracts(self, params: dict[str, str]) -> list[dict[str, Any]]:
        rows: list[dict[str, Any]] = []
        page_token: str | None = None
        while True:
            effective = dict(params)
            if page_token:
                effective["page_token"] = page_token
            payload = self.request("GET", "/v2/options/contracts", params=effective)
            rows.extend(payload.get("option_contracts") or payload.get("contracts") or [])
            page_token = payload.get("next_page_token")
            if not page_token:
                return rows


def contract_from_api(row: dict[str, Any]) -> AlpacaContract | None:
    expiration = parse_date(str(row.get("expiration_date") or ""))
    symbol = str(row.get("symbol") or "").upper().strip()
    if not expiration or not symbol:
        return None
    return AlpacaContract(
        symbol=symbol,
        underlying_symbol=str(row.get("underlying_symbol") or "").upper().strip(),
        option_type=str(row.get("type") or "").lower().strip(),
        expiration_date=expiration,
        strike_price=as_float(row.get("strike_price")),
        close_price=as_float(row.get("close_price")),
        open_interest=as_int(row.get("open_interest")),
        tradable=bool(row.get("tradable", False)),
        penny_program=bool(row.get("ppind", False)),
    )


def option_positions(positions: Iterable[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for position in positions:
        symbol = str(position.get("symbol") or "").upper()
        asset_class = str(position.get("asset_class") or "").lower()
        if asset_class == "us_option" or OCC_SYMBOL_RE.match(symbol):
            out[symbol] = position
    return out


def current_position_price(position: dict[str, Any]) -> float:
    for key in ("current_price", "market_price", "lastday_price", "avg_entry_price"):
        price = as_float(position.get(key))
        if price > 0:
            return price
    market_value = abs(as_float(position.get("market_value")))
    qty = abs(as_float(position.get("qty")))
    if market_value > 0 and qty > 0:
        return market_value / (qty * CONTRACT_MULTIPLIER)
    return 0.0


def load_histories(config: BotConfig, data_dir: str | None, synthetic: bool, offline: bool) -> dict[str, list[Bar]]:
    symbols = list(
        dict.fromkeys(
            [
                *config.universe,
                config.market_symbols.get("spy", "SPY"),
                config.market_symbols.get("qqq", "QQQ"),
                config.market_symbols.get("vix", "VIX"),
            ]
        )
    )
    return {symbol: load_history(symbol, data_dir, synthetic, offline) for symbol in symbols}


def scan_candidates(config: BotConfig, data_dir: str | None, synthetic: bool, offline: bool) -> list[Candidate]:
    histories = load_histories(config, data_dir, synthetic, offline)
    spy = histories.get(config.market_symbols.get("spy", "SPY"), [])
    qqq = histories.get(config.market_symbols.get("qqq", "QQQ"), [])
    vix = histories.get(config.market_symbols.get("vix", "VIX"), [])
    breadth = [histories.get(symbol, []) for symbol in config.universe[:8]]
    regime = build_market_regime(spy, qqq, vix, breadth)

    candidates: list[Candidate] = []
    for symbol in config.universe:
        features = technical_features(histories.get(symbol, []))
        if not features:
            continue
        for candidate in build_candidates(symbol, features, regime, config):
            candidates.append(candidate)
    candidates.sort(key=lambda item: item.score.total_score, reverse=True)
    return candidates[: config.risk.max_daily_candidates]


def contracts_for_candidate(
    client: AlpacaTradingClient,
    candidate: Candidate,
    execution: ExecutionConfig,
) -> dict[tuple[str, date], list[AlpacaContract]]:
    today = datetime.now(NY_TZ).date()
    min_exp = today + timedelta(days=max(7, candidate.structure.dte - execution.dte_tolerance_days))
    max_exp = today + timedelta(days=candidate.structure.dte + execution.dte_tolerance_days)
    option_types = sorted({leg.option_type for leg in candidate.structure.legs})
    by_type_exp: dict[tuple[str, date], list[AlpacaContract]] = {}

    for option_type in option_types:
        raw = client.option_contracts(
            {
                "underlying_symbols": candidate.symbol,
                "status": "active",
                "type": option_type,
                "expiration_date_gte": min_exp.isoformat(),
                "expiration_date_lte": max_exp.isoformat(),
                "strike_price_gte": f"{candidate.close * 0.80:.2f}",
                "strike_price_lte": f"{candidate.close * 1.20:.2f}",
                "limit": "10000",
            }
        )
        for row in raw:
            contract = contract_from_api(row)
            if not contract:
                continue
            if not contract.tradable:
                continue
            if contract.close_price < execution.min_contract_price_usd:
                continue
            if contract.open_interest < execution.min_open_interest:
                continue
            by_type_exp.setdefault((contract.option_type, contract.expiration_date), []).append(contract)
    return by_type_exp


def choose_contracts(
    candidate: Candidate,
    execution: ExecutionConfig,
    available: dict[tuple[str, date], list[AlpacaContract]],
) -> tuple[tuple[ExecutionLeg, ...], float, str] | None:
    today = datetime.now(NY_TZ).date()
    expirations = sorted({expiration for _, expiration in available.keys()})
    best: tuple[float, tuple[ExecutionLeg, ...], float, str] | None = None

    for expiration in expirations:
        legs: list[ExecutionLeg] = []
        used_symbols: set[str] = set()
        strike_error = 0.0
        entry_debit = 0.0
        missing = False
        for model_leg in candidate.structure.legs:
            contracts = available.get((model_leg.option_type, expiration), [])
            if not contracts:
                missing = True
                break
            selected = min(contracts, key=lambda item: abs(item.strike_price - model_leg.strike))
            if selected.symbol in used_symbols:
                missing = True
                break
            used_symbols.add(selected.symbol)
            strike_error += abs(selected.strike_price - model_leg.strike) / max(candidate.close, 1)
            adjusted_price = selected.close_price * (
                1 + execution.entry_price_pad_pct
                if model_leg.action == "buy"
                else 1 - execution.entry_price_pad_pct
            )
            opening_side = "buy" if model_leg.action == "buy" else "sell"
            entry_debit += adjusted_price if opening_side == "buy" else -adjusted_price
            legs.append(
                ExecutionLeg(
                    symbol=selected.symbol,
                    opening_side=opening_side,
                    option_type=selected.option_type,
                    strike=selected.strike_price,
                    expiration_date=selected.expiration_date.isoformat(),
                    entry_price=round_option_price(adjusted_price),
                )
            )
        if missing or not legs:
            continue
        dte_error = abs((expiration - today).days - candidate.structure.dte) / max(candidate.structure.dte, 1)
        penalty = dte_error + strike_error
        entry_debit = round_option_price(max(entry_debit, 0.01))
        reason = f"expiration={expiration.isoformat()}, dte={(expiration - today).days}, strike_error={strike_error:.3f}"
        if best is None or penalty < best[0]:
            best = (penalty, tuple(legs), entry_debit, reason)

    if best is None:
        return None
    return best[1], best[2], best[3]


def order_payload_for_plan(candidate: Candidate, legs: tuple[ExecutionLeg, ...], qty: int, entry_debit: float) -> dict[str, Any]:
    if len(legs) == 1:
        leg = legs[0]
        return {
            "symbol": leg.symbol,
            "qty": str(qty),
            "side": "buy",
            "type": "limit",
            "limit_price": f"{leg.entry_price:.2f}",
            "time_in_force": "day",
            "position_intent": "buy_to_open",
            "client_order_id": f"riskgate-{candidate.symbol}-{datetime.now(NY_TZ):%Y%m%d%H%M%S}",
        }
    return {
        "order_class": "mleg",
        "qty": str(qty),
        "type": "limit",
        "limit_price": f"{entry_debit:.2f}",
        "time_in_force": "day",
        "legs": [
            {
                "symbol": leg.symbol,
                "ratio_qty": "1",
                "side": leg.opening_side,
                "position_intent": "buy_to_open" if leg.opening_side == "buy" else "sell_to_open",
            }
            for leg in legs
        ],
        "client_order_id": f"riskgate-mleg-{candidate.symbol}-{datetime.now(NY_TZ):%Y%m%d%H%M%S}",
    }


def build_execution_plan(
    client: AlpacaTradingClient,
    candidate: Candidate,
    execution: ExecutionConfig,
    portfolio_value_usd: float,
    remaining_sleeve_usd: float,
) -> ExecutionPlan | None:
    if execution.mode == "long_option" and "spread" in candidate.strategy:
        strategy = "long_call_proxy" if candidate.structure.direction == "bullish" else "long_put_proxy"
        candidate = replace(
            candidate,
            strategy=strategy,
            structure=replace(
                candidate.structure,
                strategy=strategy,
                legs=(candidate.structure.legs[0],),
                max_profit_mxn=candidate.structure.max_loss_mxn * 2.5,
                reward_risk=2.5,
            ),
        )

    available = contracts_for_candidate(client, candidate, execution)
    selected = choose_contracts(candidate, execution, available)
    if selected is None:
        return None
    legs, entry_debit, reason = selected
    max_loss_usd_per_unit = entry_debit * CONTRACT_MULTIPLIER
    if max_loss_usd_per_unit > portfolio_value_usd * execution.max_entry_debit_pct_of_portfolio:
        return None

    score_scale = 1.0 if candidate.score.decision == "paper_normal" else 0.5
    trade_budget = portfolio_value_usd * execution.risk_per_trade_pct * score_scale
    trade_budget = min(trade_budget, remaining_sleeve_usd)
    qty = int(trade_budget // max_loss_usd_per_unit)
    if qty <= 0:
        return None

    payload = order_payload_for_plan(candidate, legs, qty, entry_debit)
    return ExecutionPlan(
        candidate=candidate,
        order_payload=payload,
        legs=legs,
        entry_debit_usd=entry_debit,
        max_loss_usd_per_unit=max_loss_usd_per_unit,
        qty=qty,
        reason=reason,
    )


def managed_position_value(position: ManagedPosition, alpaca_positions: dict[str, dict[str, Any]]) -> float:
    value = 0.0
    for leg in position.legs:
        symbol = str(leg["symbol"])
        current = current_position_price(alpaca_positions.get(symbol, {}))
        if current <= 0:
            current = as_float(leg.get("entry_price"))
        value += current if leg["opening_side"] == "buy" else -current
    return max(value, 0.0)


def reconcile_state(state: TraderState, alpaca_positions: dict[str, dict[str, Any]]) -> None:
    for position_id, raw_position in list(state.positions.items()):
        position = ManagedPosition(**raw_position)
        live_legs = [leg for leg in position.legs if str(leg["symbol"]) in alpaca_positions]
        if not live_legs:
            print(f"Removing closed managed position from state: {position_id}")
            state.positions.pop(position_id, None)
        elif len(live_legs) != len(position.legs):
            print(f"WARNING partial managed position detected for {position_id}; inspect Alpaca manually.")


def close_payload(position: ManagedPosition, alpaca_positions: dict[str, dict[str, Any]], execution: ExecutionConfig) -> dict[str, Any] | None:
    if len(position.legs) == 1:
        leg = position.legs[0]
        price = current_position_price(alpaca_positions.get(str(leg["symbol"]), {}))
        if price <= 0:
            return None
        return {
            "symbol": str(leg["symbol"]),
            "qty": str(position.qty),
            "side": "sell",
            "type": "limit",
            "limit_price": f"{round_option_price(price * (1 - execution.exit_price_pad_pct)):.2f}",
            "time_in_force": "day",
            "position_intent": "sell_to_close",
            "client_order_id": f"riskgate-close-{position.symbol}-{datetime.now(NY_TZ):%Y%m%d%H%M%S}",
        }

    credit = managed_position_value(position, alpaca_positions)
    if credit <= 0:
        return None
    return {
        "order_class": "mleg",
        "qty": str(position.qty),
        "type": "limit",
        "limit_price": f"{-round_option_price(credit * (1 - execution.exit_price_pad_pct)):.2f}",
        "time_in_force": "day",
        "legs": [
            {
                "symbol": str(leg["symbol"]),
                "ratio_qty": "1",
                "side": "sell" if leg["opening_side"] == "buy" else "buy",
                "position_intent": "sell_to_close" if leg["opening_side"] == "buy" else "buy_to_close",
            }
            for leg in position.legs
        ],
        "client_order_id": f"riskgate-close-mleg-{position.symbol}-{datetime.now(NY_TZ):%Y%m%d%H%M%S}",
    }


def close_reasons(position: ManagedPosition, alpaca_positions: dict[str, dict[str, Any]], config: BotConfig, execution: ExecutionConfig) -> list[str]:
    reasons: list[str] = []
    opened = datetime.fromisoformat(position.opened_at)
    held_days = (datetime.now(NY_TZ).date() - opened.date()).days
    current_value = managed_position_value(position, alpaca_positions)
    if held_days >= config.strategy.hold_days:
        reasons.append(f"held {held_days} days >= hold_days {config.strategy.hold_days}")
    if execution.take_profit_pct is not None and current_value >= position.entry_debit_usd * (1 + execution.take_profit_pct):
        reasons.append(f"take profit {current_value:.2f} >= {position.entry_debit_usd * (1 + execution.take_profit_pct):.2f}")
    if execution.stop_loss_pct is not None and current_value <= position.entry_debit_usd * (1 - execution.stop_loss_pct):
        reasons.append(f"stop loss {current_value:.2f} <= {position.entry_debit_usd * (1 - execution.stop_loss_pct):.2f}")
    expirations = [
        parsed
        for parsed in (parse_date(str(leg.get("expiration_date"))) for leg in position.legs)
        if parsed is not None
    ]
    earliest_exp = min(expirations) if expirations else None
    if earliest_exp is not None and (earliest_exp - datetime.now(NY_TZ).date()).days <= 7:
        reasons.append("expiration within 7 days")
    return reasons


def submit_order(client: AlpacaTradingClient, payload: dict[str, Any], dry_run: bool) -> dict[str, Any]:
    label = "DRY-RUN " if dry_run else ""
    if payload.get("order_class") == "mleg":
        leg_text = ", ".join(f"{leg['side']} {leg['symbol']}" for leg in payload["legs"])
        print(f"  {label}MLEG qty={payload['qty']} limit={payload['limit_price']} legs=[{leg_text}]")
    else:
        print(
            f"  {label}ORDER {payload['side']} {payload['symbol']} "
            f"qty={payload['qty']} limit={payload.get('limit_price')}"
        )
    if dry_run:
        return {"dry_run": True, **payload}
    response = client.submit_order(payload)
    time.sleep(SUBMIT_DELAY_SEC)
    return response


def build_dynamic_config(config: BotConfig, portfolio_value_usd: float, execution: ExecutionConfig) -> BotConfig:
    portfolio_value_mxn = portfolio_value_usd * config.usd_mxn
    risk = replace(
        config.risk,
        max_risk_per_trade_mxn=portfolio_value_mxn * execution.risk_per_trade_pct,
        max_open_positions=execution.max_open_positions,
        max_daily_candidates=max(config.risk.max_daily_candidates, execution.max_new_positions * 4),
    )
    return replace(config, initial_equity_mxn=portfolio_value_mxn, risk=risk)


def assert_options_level(account: dict[str, Any], execution: ExecutionConfig) -> None:
    required = execution.require_options_level
    if required is None:
        required = 3 if execution.mode == "debit_spread" else 2
    level = as_int(account.get("options_trading_level") or account.get("options_approved_level"), -1)
    if level >= 0 and level < required:
        raise RuntimeError(f"Alpaca options level {level} is below required level {required} for {execution.mode}.")


def run(args: argparse.Namespace) -> None:
    load_dot_env(args.env_file)
    config_path = args.config.resolve()
    config = load_config(config_path)
    execution = ExecutionConfig.from_config_file(config_path)
    state_path = (BOT_ROOT / execution.state_file).resolve()
    paper = os.getenv("APCA_PAPER", "true").lower() not in {"0", "false", "no"}
    dry_run = not args.live

    client = AlpacaTradingClient(paper=paper)
    account = client.account()
    portfolio_value_usd = as_float(account.get("portfolio_value"))
    cash = as_float(account.get("cash"))
    options_bp = as_float(account.get("options_buying_power"))
    assert_options_level(account, execution)

    dynamic_config = build_dynamic_config(config, portfolio_value_usd, execution)
    print("=" * 78)
    print(f"RiskGate/RiskLab Alpaca options trader - {'DRY-RUN' if dry_run else 'LIVE'}")
    print(f"Portfolio value: ${portfolio_value_usd:,.2f}  cash=${cash:,.2f}  options_bp=${options_bp:,.2f}")
    print(
        f"Sizing: full Alpaca portfolio is base; sleeve={execution.options_sleeve_pct:.0%}, "
        f"risk/trade={execution.risk_per_trade_pct:.2%} (${portfolio_value_usd * execution.risk_per_trade_pct:,.2f})"
    )
    print(f"Execution mode: {execution.mode}")

    clock = client.clock()
    print(f"Market is_open={clock.get('is_open')} next_open={clock.get('next_open')}")
    if not clock.get("is_open") and not execution.allow_queued_orders:
        print("Market is closed and allow_queued_orders=false; stopping before orders.")
        return

    all_positions = client.positions()
    alpaca_option_positions = option_positions(all_positions)
    state = TraderState.load(state_path)
    reconcile_state(state, alpaca_option_positions)

    close_orders: list[tuple[str, dict[str, Any], list[str]]] = []
    if execution.close_existing_positions:
        for position_id, raw_position in state.positions.items():
            position = ManagedPosition(**raw_position)
            reasons = close_reasons(position, alpaca_option_positions, dynamic_config, execution)
            if not reasons:
                continue
            payload = close_payload(position, alpaca_option_positions, execution)
            if payload:
                close_orders.append((position_id, payload, reasons))

    candidates = scan_candidates(dynamic_config, args.data_dir, args.synthetic, args.offline)
    print("")
    print("Top RiskLab candidates:")
    for candidate in candidates[:10]:
        print(
            f"  {candidate.symbol:5s} {candidate.strategy:26s} "
            f"score={candidate.score.total_score:5.1f} decision={candidate.score.decision:12s} "
            f"model_debit={candidate.structure.net_debit_usd:5.2f} rr={candidate.structure.reward_risk:4.2f}"
        )
        if candidate.score.warnings:
            print(f"       warnings: {' | '.join(candidate.score.warnings)}")

    managed_open_symbols = {
        ManagedPosition(**row).symbol
        for key, row in state.positions.items()
        if key not in {position_id for position_id, _, _ in close_orders}
    }
    current_managed_value = sum(
        managed_position_value(ManagedPosition(**row), alpaca_option_positions)
        * CONTRACT_MULTIPLIER
        * ManagedPosition(**row).qty
        for key, row in state.positions.items()
        if key not in {position_id for position_id, _, _ in close_orders}
    )
    remaining_sleeve_usd = max(0.0, portfolio_value_usd * execution.options_sleeve_pct - current_managed_value)

    open_plans: list[ExecutionPlan] = []
    if execution.open_new_positions:
        for candidate in candidates:
            if len(open_plans) >= execution.max_new_positions:
                break
            if candidate.score.total_score < dynamic_config.strategy.min_score_to_enter:
                continue
            eligible_decisions = {"paper_small", "paper_normal"}
            if execution.allow_watchlist_entries:
                eligible_decisions.add("watchlist")
            if candidate.score.decision not in eligible_decisions:
                continue
            open_after_closes = len(state.positions) - len(close_orders) + len(open_plans)
            if open_after_closes >= execution.max_open_positions:
                break
            if execution.one_position_per_symbol and candidate.symbol in managed_open_symbols:
                continue
            plan = build_execution_plan(
                client,
                candidate,
                execution,
                portfolio_value_usd,
                remaining_sleeve_usd,
            )
            if not plan:
                continue
            open_plans.append(plan)
            remaining_sleeve_usd -= plan.max_loss_usd_per_unit * plan.qty
            managed_open_symbols.add(candidate.symbol)

    total_orders = len(close_orders) + len(open_plans)
    print("")
    print(f"Planned orders: {len(close_orders)} closes + {len(open_plans)} opens = {total_orders}")
    if total_orders > execution.max_daily_orders:
        raise RuntimeError(f"Order breaker hit: {total_orders} > {execution.max_daily_orders}")

    print("")
    print("--- Closing managed positions ---")
    for position_id, payload, reasons in close_orders:
        print(f"  CLOSE {position_id}: {'; '.join(reasons)}")
        submit_order(client, payload, dry_run)

    print("")
    print("--- Opening new positions ---")
    for plan in open_plans:
        print(
            f"  OPEN {plan.candidate.symbol} {plan.candidate.strategy} "
            f"score={plan.candidate.score.total_score:.1f} qty={plan.qty} "
            f"debit={plan.entry_debit_usd:.2f} ({plan.reason})"
        )
        submit_order(client, plan.order_payload, dry_run)
        if not dry_run:
            position_id = f"{datetime.now(NY_TZ):%Y%m%d}-{plan.candidate.symbol}-{plan.candidate.strategy}"
            state.positions[position_id] = asdict(
                ManagedPosition(
                    id=position_id,
                    symbol=plan.candidate.symbol,
                    strategy=plan.candidate.strategy,
                    opened_at=datetime.now(NY_TZ).isoformat(),
                    qty=plan.qty,
                    entry_debit_usd=plan.entry_debit_usd,
                    score=plan.candidate.score.total_score,
                    legs=[asdict(leg) for leg in plan.legs],
                )
            )

    state.last_run = datetime.now(NY_TZ).isoformat()
    state.run_history.append(
        {
            "date": datetime.now(NY_TZ).date().isoformat(),
            "portfolio_value_usd": portfolio_value_usd,
            "dry_run": dry_run,
            "candidates": len(candidates),
            "closes": len(close_orders),
            "opens": len(open_plans),
        }
    )
    state.run_history = state.run_history[-120:]
    state.save(state_path)
    print("")
    print(f"State: {state_path}")
    print("=" * 78)


def main() -> None:
    parser = argparse.ArgumentParser(description="Execute RiskLab/RiskGate option candidates through Alpaca.")
    parser.add_argument("--config", type=Path, default=BOT_ROOT / "config.alpaca.example.json")
    parser.add_argument("--env-file", type=Path, default=APP_ROOT / ".env.local")
    parser.add_argument("--data-dir", default=None)
    parser.add_argument("--synthetic", action="store_true")
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--live", action="store_true", help="Submit Alpaca orders. Default is dry-run.")
    args = parser.parse_args()
    run(args)


if __name__ == "__main__":
    main()
