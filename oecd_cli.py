#!/usr/bin/env python3
# ============================================================================
# OECD G20 Composite Leading Indicator (CLI) + diffusion breadth
# ----------------------------------------------------------------------------
# Writes data/oecd.json, consumed by the GROWTH > OECD view
# (src/tabs/OecdGrowthChart.jsx) via its raw.githubusercontent.com URL.
#
# Self-contained: hits the PUBLIC OECD SDMX REST API. No API key, no secret,
# no FRED/yfinance — so it never collides with the gitignored RecessionAlert
# xlsx the LEADING composite depends on.  Safe to run in GitHub Actions.
#
# Methodology (replicates the reference notebook 1:1):
#   G20 CLI          = cross-country mean of the amplitude-adjusted CLI
#   Diffusion (MoM)  = % of countries whose CLI rose vs the prior month
#   Diffusion (YoY)  = % of countries whose CLI rose vs 12 months prior
# ============================================================================

import os
import io
import sys
import json
import time
import datetime as dt

import requests
import pandas as pd

# ----------------------------------------------------------------------------
# TUNABLE CONSTANTS  (env-overridable — iterate by deployment)
# ----------------------------------------------------------------------------
# 17 OECD CLI members aggregated as the "G20" proxy. The dataflow is versioned
# (...DF_CLI,4.1...); if OECD bumps the version and the fetch 404s, update the
# OECD_CLI_URL secret/env or this default.
OECD_CLI_URL = os.environ.get(
    "OECD_CLI_URL",
    "https://sdmx.oecd.org/public/rest/data/OECD.SDD.STES,DSD_STES@DF_CLI,4.1/"
    "ZAF+IDN+IND+CHN+BRA+GBR+TUR+ESP+MEX+KOR+JPN+ITA+DEU+FRA+CAN+AUS+USA"
    ".M.LI...AA...H?dimensionAtObservation=AllDimensions&format=csvfilewithlabels",
).strip()

OUT_PATH     = os.environ.get("OECD_OUT", "data/oecd.json").strip()
HTTP_TIMEOUT = int(os.environ.get("OECD_TIMEOUT", "60"))
HTTP_RETRIES = int(os.environ.get("OECD_RETRIES", "4"))

# US NBER recession windows — emitted in the JSON so the frontend has a single
# source of truth (no hard-coded dates in the component).
RECESSIONS = [
    ("1960-04-01", "1961-02-01"),
    ("1969-12-01", "1970-11-01"),
    ("1973-11-01", "1975-03-01"),
    ("1980-01-01", "1980-07-01"),
    ("1981-07-01", "1982-11-01"),
    ("1990-07-01", "1991-03-01"),
    ("2001-03-01", "2001-11-01"),
    ("2007-12-01", "2009-06-01"),
    ("2020-02-01", "2020-04-01"),
]


# ----------------------------------------------------------------------------
def fetch_csv(url: str) -> str:
    """GET the SDMX CSV with bounded exponential-backoff retries."""
    last = None
    for i in range(HTTP_RETRIES):
        try:
            r = requests.get(
                url,
                timeout=HTTP_TIMEOUT,
                headers={"User-Agent": "smallfishmacro-oecd-cli/1.0"},
            )
            r.raise_for_status()
            return r.text
        except Exception as e:  # noqa: BLE001 — broad on purpose, we retry
            last = e
            wait = (2 ** i) * 3
            print(f"[oecd] fetch attempt {i + 1}/{HTTP_RETRIES} failed: {e} "
                  f"— retrying in {wait}s", file=sys.stderr)
            time.sleep(wait)
    raise SystemExit(f"[oecd] FAILED to fetch after {HTTP_RETRIES} attempts: {last}")


def compute(df: pd.DataFrame) -> dict:
    """Pivot the long SDMX frame to country columns and derive the three series."""
    for col in ("REF_AREA", "TIME_PERIOD", "OBS_VALUE"):
        if col not in df.columns:
            raise SystemExit(
                f"[oecd] expected column '{col}' missing; got {list(df.columns)[:12]}"
            )

    df = df.copy()
    df["TIME_PERIOD"] = pd.to_datetime(df["TIME_PERIOD"])
    cli = (
        df.pivot_table(index="TIME_PERIOD", columns="REF_AREA",
                       values="OBS_VALUE", aggfunc="first")
        .sort_index()
    )
    countries = sorted(str(c) for c in cli.columns)

    g20 = cli.mean(axis=1)
    # fill_method=None  → no forward-fill across gaps (modern pandas default;
    # methodologically correct and silences the 2.1.x FutureWarning).
    denom = cli.count(axis=1)
    mom = cli.pct_change(fill_method=None).gt(0).sum(axis=1) / denom * 100.0
    yoy = cli.pct_change(periods=12, fill_method=None).gt(0).sum(axis=1) / denom * 100.0

    def fv(s, ts):
        v = s.loc[ts]
        return None if pd.isna(v) else round(float(v), 4)

    series = []
    for ts in cli.index:
        series.append({
            "t":   int(ts.value // 1_000_000),  # epoch ms (UTC) — Recharts numeric x-axis
            "cli": fv(g20, ts),
            "mom": fv(mom, ts),
            "yoy": fv(yoy, ts),
        })

    return {
        "as_of":        cli.index.max().strftime("%Y-%m-%d"),
        "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "n_countries":  len(countries),
        "countries":    countries,
        "recessions":   [[a, b] for a, b in RECESSIONS],
        "series":       series,
    }


def main():
    txt = fetch_csv(OECD_CLI_URL)
    df = pd.read_csv(io.StringIO(txt))
    out = compute(df)

    os.makedirs(os.path.dirname(OUT_PATH) or ".", exist_ok=True)
    with open(OUT_PATH, "w") as f:
        json.dump(out, f, separators=(",", ":"), allow_nan=False)

    last = out["series"][-1]
    print(f"[oecd] wrote {OUT_PATH} · {len(out['series'])} months · "
          f"{out['n_countries']} countries · as_of {out['as_of']}")
    print(f"[oecd] latest: CLI={last['cli']} · MoM={last['mom']}% · YoY={last['yoy']}%")


if __name__ == "__main__":
    main()
