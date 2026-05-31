"""Poll facility occupancy and local weather; append one row per sample.

Occupancy: POST https://wssc.cyc.org.tw/api  ->  {"gym":[n,cap], "swim":[n,cap], "ice":[n,cap]}
Weather:   Open-Meteo current conditions at the configured coordinates.
Runs only during opening hours (06:00 <= local hour < 22:00 Asia/Taipei).
"""

from __future__ import annotations

import csv
import json
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

API_URL = "https://wssc.cyc.org.tw/api"
WEATHER_URL = (
    "https://api.open-meteo.com/v1/forecast"
    "?latitude=24.987&longitude=121.553"
    "&current=temperature_2m,precipitation,weather_code"
    "&timezone=Asia%2FTaipei"
)
CSV_PATH = Path(__file__).resolve().parent / "data" / "occupancy.csv"
HEADER = [
    "timestamp_utc", "timestamp_local",
    "ice_current", "ice_capacity",
    "swim_current", "swim_capacity",
    "gym_current", "gym_capacity",
    "temperature_c", "precipitation_mm", "weather_code",
    "api_status", "weather_status",
]
LOCAL_TZ = timezone(timedelta(hours=8))


def http_json(url: str, *, method: str = "GET", data: bytes | None = None,
              retries: int = 4, timeout: int = 15) -> dict | None:
    backoff = 2
    last_err: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(
                url, data=data, method=method,
                headers={
                    "User-Agent": "Mozilla/5.0 (occupancy-logger)",
                    "Accept": "application/json, */*",
                    "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
                },
            )
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read())
        except (urllib.error.URLError, urllib.error.HTTPError,
                TimeoutError, json.JSONDecodeError) as e:
            last_err = e
            if attempt < retries:
                time.sleep(backoff)
                backoff *= 2
    print(f"http_json failed: {url} -> {last_err}", file=sys.stderr)
    return None


def parse_facilities(payload: dict) -> dict[str, tuple[int | None, int | None]]:
    out: dict[str, tuple[int | None, int | None]] = {}
    for key in ("gym", "swim", "ice"):
        pair = payload.get(key)
        if not isinstance(pair, list) or len(pair) < 2:
            out[key] = (None, None)
            continue
        cur_raw, cap_raw = pair[0], pair[1]
        if isinstance(cur_raw, str) and "找不到資源" in cur_raw:
            out[key] = (None, None)
            continue
        try:
            out[key] = (int(cur_raw), int(cap_raw))
        except (TypeError, ValueError):
            out[key] = (None, None)
    return out


def fetch_facilities() -> tuple[dict[str, tuple[int | None, int | None]] | None, str]:
    payload = http_json(API_URL, method="POST", data=b"")
    if payload is None:
        return None, "fetch_failed"
    parsed = parse_facilities(payload)
    any_value = any(cur is not None for cur, _ in parsed.values())
    return parsed, ("ok" if any_value else "no_data")


def fetch_weather() -> tuple[dict | None, str]:
    payload = http_json(WEATHER_URL, retries=3, timeout=10)
    if payload is None:
        return None, "fetch_failed"
    cur = payload.get("current") or {}
    return {
        "temperature_c": cur.get("temperature_2m"),
        "precipitation_mm": cur.get("precipitation"),
        "weather_code": cur.get("weather_code"),
    }, "ok"


def cell(v) -> str:
    return "" if v is None else str(v)


def main() -> int:
    now_utc = datetime.now(timezone.utc).replace(microsecond=0)
    now_local = now_utc.astimezone(LOCAL_TZ)
    if not (6 <= now_local.hour < 22):
        print(f"closed at {now_local:%Y-%m-%d %H:%M}; skipping")
        return 0

    facilities, api_status = fetch_facilities()
    weather, weather_status = fetch_weather()

    if facilities is None:
        ice = swim = gym = (None, None)
    else:
        ice, swim, gym = facilities["ice"], facilities["swim"], facilities["gym"]
    if weather is None:
        weather = {"temperature_c": None, "precipitation_mm": None, "weather_code": None}

    ts_utc = now_utc.isoformat().replace("+00:00", "Z")
    ts_local = now_local.strftime("%Y-%m-%d %H:%M:%S")

    row = [
        ts_utc, ts_local,
        cell(ice[0]), cell(ice[1]),
        cell(swim[0]), cell(swim[1]),
        cell(gym[0]), cell(gym[1]),
        cell(weather["temperature_c"]),
        cell(weather["precipitation_mm"]),
        cell(weather["weather_code"]),
        api_status, weather_status,
    ]

    CSV_PATH.parent.mkdir(parents=True, exist_ok=True)
    new_file = not CSV_PATH.exists()
    with CSV_PATH.open("a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        if new_file:
            w.writerow(HEADER)
        w.writerow(row)

    print(
        f"{ts_local}  ice={ice[0]}/{ice[1]}  "
        f"temp={weather['temperature_c']}C  precip={weather['precipitation_mm']}mm  "
        f"api={api_status} weather={weather_status}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
