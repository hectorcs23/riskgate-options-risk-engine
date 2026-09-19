from __future__ import annotations

import json
import os
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def configured() -> bool:
    return bool(os.getenv("APCA_API_KEY_ID") and os.getenv("APCA_API_SECRET_KEY"))


def option_chain_snapshot(symbol: str, option_type: str = "call", limit: int = 100) -> dict:
    if not configured():
        raise RuntimeError("Missing APCA_API_KEY_ID or APCA_API_SECRET_KEY.")
    params = urlencode({
        "feed": os.getenv("ALPACA_DATA_FEED", "indicative"),
        "type": option_type,
        "limit": limit
    })
    url = f"https://data.alpaca.markets/v1beta1/options/snapshots/{symbol.upper()}?{params}"
    request = Request(
        url,
        headers={
            "Accept": "application/json",
            "APCA-API-KEY-ID": os.environ["APCA_API_KEY_ID"],
            "APCA-API-SECRET-KEY": os.environ["APCA_API_SECRET_KEY"]
        }
    )
    with urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))
