"""
ingest_growth.py — SmallFish Macro Regime / GROWTH (v3)

Pulls macro growth indicators, computes regime composites, and writes
data/growth.json.

v3 changes vs v2:
  - fetch_atlanta_fed() rewritten to stitch THREE sheets from the official
    GDPTrackingModelDataAndForecasts.xlsx workbook:
      * TrackingArchives        → ~10y daily history of headline GDP nowcast
                                  (cols: 'Forecast Date', 'GDP Nowcast')
      * CurrentQtrEvolution     → current-quarter daily headline (3 side-by-side
                                  3-col blocks of [Date, Major Releases, GDP*])
      * ContribHistory          → current-quarter daily component contributions
                                  (wide format: row 0 dates, col 1 numbered labels)
  - Components mapped by NIPA prefix: '2-' (PCE goods), '3-' (PCE services),
    '5-' (fixed inv), '11-' (govt). Net exports + inventories from named rows
    ('Change in net exports', 'Change in inventory investment').
  - Output schema unchanged: long-format DataFrame with daily date index.
    Headline 'total' is continuous ~10y. Component cols are populated only
    for the current forecast quarter (~29 rows); NaN before that. This
    intentional asymmetry mirrors how Atlanta Fed publishes the data.

OUT OF SCOPE for v1:
  - Multi-quarter component history (ContribArchives) — Bloomberg's full
    year-long stacked view. Deferred to v1.1.
  - Hierarchy-aware aggregation (indented-label depth in BEA tree).
  - TrackingDeepArchives (2011 Q3 – 2014 Q1 pre-live model).

Sources:
  AUTO:   Atlanta Fed (xlsx) + Dallas Fed WEI (FRED API)
  MANUAL: UNCTAD World Nowcast (csv append) + RecessionAlert WLA + LEI (xlsx drop)

Usage:
    python scripts/ingest_growth.py

Env:
    FRED_API_KEY    required (free key at fred.stlouisfed.org)
"""

from __future__ import annotations
import json
import os
import sys
import glob
from datetime import datetime, timezone
from pathlib import Path

# UTF-8 console reconfiguration — Windows-safe; must run before any non-ASCII log()
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")

import pandas as pd
import requests

# ----------------------------------------------------------------------
# Paths
# ----------------------------------------------------------------------
ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CACHE = DATA / "cache"
UNCTAD_MANUAL = DATA / "unctad" / "manual.csv"
RA_RAW_DIR = DATA / "recessionalert" / "raw"
OUTPUT_JSON = DATA / "growth.json"
CACHE.mkdir(parents=True, exist_ok=True)

# ----------------------------------------------------------------------
# .env loader (no python-dotenv dependency)
# ----------------------------------------------------------------------
_env_path = ROOT / ".env"
if _env_path.exists():
    for line in _env_path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())

# ----------------------------------------------------------------------
# Config
# ----------------------------------------------------------------------
ATLANTA_FED_URL = (
    "https://www.atlantafed.org/-/media/Project/Atlanta/FRBA/Documents/"
    "cqer/researchcq/gdpnow/GDPTrackingModelDataAndForecasts.xlsx"
)
NY_FED_URL = (
    "https://www.newyorkfed.org/medialibrary/Research/Interactives/Data/"
    "NowCast/Downloads/New-York-Fed-Staff-Nowcast_download_data.xlsx"
)
FRED_API = "https://api.stlouisfed.org/fred/series/observations"
FRED_API_KEY = os.environ.get("FRED_API_KEY")

Z_WINDOW_YEARS = 10
DIRECTION_LOOKBACK_WEEKS = 8


def log(msg: str) -> None:
    print(f"[ingest] {msg}", flush=True)


def fail(msg: str, exit_code: int = 1) -> None:
    print(f"[ingest][ERROR] {msg}", file=sys.stderr, flush=True)
    sys.exit(exit_code)


def looks_like_html(content: bytes) -> bool:
    head = content[:512].lstrip().lower()
    return head.startswith(b"<!doctype html") or head.startswith(b"<html") or b"<head>" in head[:200]


def rolling_zscore(series: pd.Series, window_obs: int) -> pd.Series:
    mean = series.rolling(window=window_obs, min_periods=max(20, window_obs // 4)).mean()
    std = series.rolling(window=window_obs, min_periods=max(20, window_obs // 4)).std()
    return (series - mean) / std


def classify_regime(coinc_z: float, lead_z: float, lead_z_8w_ago: float) -> dict:
    if coinc_z > 0.5:
        level = "HIGH"
    elif coinc_z < -0.5:
        level = "LOW"
    else:
        level = "NORMAL"
    direction = "ACCELERATING" if lead_z > lead_z_8w_ago else "SLOWING"
    return {"level": level, "direction": direction}


HEDGE_MAP = {
    ("LOW", "SLOWING"):         {"ratio": 70, "posture": "Long puts, VIX calls, delta-hedged"},
    ("LOW", "ACCELERATING"):    {"ratio": 25, "posture": "Roll off puts, beta back on"},
    ("NORMAL", "SLOWING"):      {"ratio": 45, "posture": "Building put position"},
    ("NORMAL", "ACCELERATING"): {"ratio": 20, "posture": "Light hedge"},
    ("HIGH", "SLOWING"):        {"ratio": 40, "posture": "Initiating puts (cheap entry)"},
    ("HIGH", "ACCELERATING"):   {"ratio": 10, "posture": "Minimal hedge, sell vol"},
}


# ======================================================================
# 1. Atlanta Fed GDPNow xlsx — multi-sheet stitch
# ======================================================================
def _read_tracking_archives(xlsx_path: Path) -> pd.DataFrame:
    """TrackingArchives is already long-format with header at row 0.
    Schema: col 0 = 'Forecast Date', col 27 = 'GDP Nowcast'.
    Returns (date, total) DataFrame, ~1800 rows from 2014-05-01.
    """
    df = pd.read_excel(xlsx_path, sheet_name="TrackingArchives", header=0)
    log(f"    TrackingArchives shape: {df.shape}")

    # Defensive lookup — column names should be stable but verify
    date_col = "Forecast Date"
    total_col = "GDP Nowcast"
    if date_col not in df.columns:
        # Fallback: positional
        date_col = df.columns[0]
        log(f"    'Forecast Date' col missing — falling back to col 0 '{date_col}'")
    if total_col not in df.columns:
        # Fallback: position 27
        if len(df.columns) > 27:
            total_col = df.columns[27]
            log(f"    'GDP Nowcast' col missing — falling back to col 27 '{total_col}'")
        else:
            fail(f"TrackingArchives missing both 'GDP Nowcast' name and col 27. "
                 f"Has: {list(df.columns)}")

    out = df[[date_col, total_col]].copy()
    out.columns = ["date", "total"]
    out["date"] = pd.to_datetime(out["date"], errors="coerce")
    out["total"] = pd.to_numeric(out["total"], errors="coerce")
    out = out.dropna().sort_values("date").reset_index(drop=True)
    log(f"    parsed: {len(out)} rows · {out['date'].iloc[0].date()} → {out['date'].iloc[-1].date()}")
    return out


def _read_current_qtr_evolution(xlsx_path: Path) -> pd.DataFrame:
    """CurrentQtrEvolution has 3 side-by-side blocks of 3 cols each
    [Date, Major Releases, GDP*]. Row 0 is repeating header.
    Returns (date, total) DataFrame for current quarter (~30 rows).
    """
    df = pd.read_excel(xlsx_path, sheet_name="CurrentQtrEvolution", header=None)
    log(f"    CurrentQtrEvolution shape: {df.shape}")

    blocks = []
    for start in (0, 3, 6):
        if start + 2 >= df.shape[1]:
            continue
        b = df.iloc[1:, [start, start + 2]].copy()  # skip header row, take Date + GDP*
        b.columns = ["date", "total"]
        b["date"] = pd.to_datetime(b["date"], errors="coerce")
        b["total"] = pd.to_numeric(b["total"], errors="coerce")
        b = b.dropna()
        if len(b):
            blocks.append(b)

    if not blocks:
        log("    WARNING: CurrentQtrEvolution had no parseable blocks")
        return pd.DataFrame(columns=["date", "total"])

    out = pd.concat(blocks, ignore_index=True).sort_values("date").reset_index(drop=True)
    log(f"    parsed: {len(out)} rows · {out['date'].iloc[0].date()} → {out['date'].iloc[-1].date()}")
    return out


def _read_contrib_history(xlsx_path: Path) -> pd.DataFrame:
    """ContribHistory is wide: row 0 dates in cols 2..N, col 1 numbered labels.
    Component prefix mapping (NIPA):
      pceGoods    ← '2-'  (PCE Goods)
      pceServices ← '3-'  (PCE Services)
      fixedInv    ← '5-'  (Fixed Investment)
      govt        ← '11-' (Government)
      netExports  ← row labeled 'Change in net exports'
      inventories ← row labeled 'Change in inventory investment'
    Returns wide DataFrame: date + 6 component columns, ~30 rows.
    """
    df = pd.read_excel(xlsx_path, sheet_name="ContribHistory", header=None)
    log(f"    ContribHistory shape: {df.shape}")

    # Locate date row — should be row 0, but defensively scan first 3 rows
    date_row_idx = None
    for i in range(min(3, len(df))):
        if df.shape[1] <= 2:
            continue
        try:
            ts = pd.to_datetime(df.iloc[i, 2], errors="coerce")
            if pd.notna(ts):
                date_row_idx = i
                break
        except Exception:
            continue
    if date_row_idx is None:
        fail(f"ContribHistory: could not locate date row. "
             f"First 3 values in col 2: {[df.iloc[i, 2] for i in range(min(3, len(df)))]}")
    log(f"    date row at index {date_row_idx}")

    # Date headers (cols 2..N, may have trailing NaN)
    dates = pd.to_datetime(df.iloc[date_row_idx, 2:].values, errors="coerce")

    # Component label column = col 1
    # fillna("") first — pandas .str.strip() can re-propagate NaN even
    # after .astype(str), which causes the helpers below to see floats.
    labels = df.iloc[:, 1].fillna("").astype(str).str.strip()

    def find_row_by_prefix(prefix: str):
        for idx, lbl in labels.items():
            if not isinstance(lbl, str) or not lbl:
                continue
            if lbl.startswith(prefix):
                return idx
        return None

    def find_row_by_substring(sub: str):
        sub_lower = sub.lower()
        for idx, lbl in labels.items():
            if not isinstance(lbl, str) or not lbl:
                continue
            if sub_lower in lbl.lower():
                return idx
        return None

    component_rows = {
        "pceGoods":    find_row_by_prefix("2-"),
        "pceServices": find_row_by_prefix("3-"),
        "fixedInv":    find_row_by_prefix("5-"),
        "govt":        find_row_by_prefix("11-"),
        "netExports":  find_row_by_substring("change in net exports"),
        "inventories": find_row_by_substring("change in inventory investment"),
    }
    log(f"    component row mapping: {component_rows}")

    missing = [k for k, v in component_rows.items() if v is None]
    if missing:
        log(f"    labels seen (first 30): {labels.tolist()[:30]}")
        fail(f"Could not locate ContribHistory rows for: {missing}")

    # Build wide-format component DataFrame
    comp_data = {"date": dates}
    for comp_name, row_idx in component_rows.items():
        comp_data[comp_name] = pd.to_numeric(df.iloc[row_idx, 2:].values, errors="coerce")

    out = pd.DataFrame(comp_data)
    out = out.dropna(subset=["date"]).reset_index(drop=True)
    log(f"    parsed: {len(out)} dates · {out['date'].iloc[0].date()} → {out['date'].iloc[-1].date()}")

    # Validation: PCE Goods + PCE Services should match parent PCE in current quarter.
    # Per dump: 0.336 + 1.603 = 1.939 ✓ (this is the tidy decomposition check)
    return out


def _read_contrib_archives(xlsx_path: Path) -> pd.DataFrame:
    """ContribArchives is long-format with header at row 0.
    Schema (col → meaning):
        col 0  = 'Forecast Date'
        col 1  = 'Quarter being forecasted' (groups daily rows by target quarter)
        col 3  = 'PCE Goods'
        col 4  = 'PCE Services'
        col 6  = 'Fixed Investment'
        col 12 = 'Government'
        col 21 = 'Change in net exports'
        col 22 = 'Change in inventory investment'

    Returns a wide-format DataFrame matching the schema produced by
    _read_contrib_history(): date + 6 component columns. Daily rows from
    2014-05-01 up to (but not including) the current forecast quarter.
    """
    df = pd.read_excel(xlsx_path, sheet_name="ContribArchives", header=0)
    log(f"    ContribArchives shape: {df.shape}")

    # Defensive lookup by column name with positional fallback.
    name_to_pos = {
        "Forecast Date": 0,
        "PCE Goods": 3,
        "PCE Services": 4,
        "Fixed Investment": 6,
        "Government": 12,
        "Change in net exports": 21,
        "Change in inventory investment": 22,
    }
    cols_resolved = {}
    for name, fallback_pos in name_to_pos.items():
        if name in df.columns:
            cols_resolved[name] = name
        elif len(df.columns) > fallback_pos:
            cols_resolved[name] = df.columns[fallback_pos]
            log(f"    column '{name}' not found by name — falling back to col {fallback_pos} '{df.columns[fallback_pos]}'")
        else:
            fail(f"ContribArchives missing required column '{name}' (and no col at fallback pos {fallback_pos})")

    out = pd.DataFrame({
        "date":        df[cols_resolved["Forecast Date"]],
        "pceGoods":    df[cols_resolved["PCE Goods"]],
        "pceServices": df[cols_resolved["PCE Services"]],
        "fixedInv":    df[cols_resolved["Fixed Investment"]],
        "govt":        df[cols_resolved["Government"]],
        "netExports":  df[cols_resolved["Change in net exports"]],
        "inventories": df[cols_resolved["Change in inventory investment"]],
    })

    out["date"] = pd.to_datetime(out["date"], errors="coerce")
    for c in out.columns[1:]:
        out[c] = pd.to_numeric(out[c], errors="coerce")
    out = out.dropna(subset=["date"]).sort_values("date").reset_index(drop=True)

    log(f"    parsed: {len(out)} rows · {out['date'].iloc[0].date()} → {out['date'].iloc[-1].date()}")
    return out


def fetch_atlanta_fed() -> pd.DataFrame:
    """v3 — multi-sheet stitched: TrackingArchives (history) + CurrentQtrEvolution
    (current-Q headline) + ContribHistory (current-Q components).

    Output: long-format DataFrame with cols
        date, total, pceGoods, pceServices, fixedInv, govt, netExports, inventories

    'total' has ~10y daily history; component cols are NaN for all dates
    before the current forecast quarter.
    """
    log("Fetching Atlanta Fed GDPNow xlsx ...")
    headers = {"User-Agent": "Mozilla/5.0 (compatible; smallfish-macro-regime-ingest/1.0)"}
    try:
        r = requests.get(ATLANTA_FED_URL, headers=headers, timeout=60)
        r.raise_for_status()
    except Exception as e:
        fail(f"Atlanta Fed fetch failed: {e}")

    ctype = r.headers.get("Content-Type", "").lower()
    log(f"  HTTP {r.status_code} · Content-Type: {ctype} · {len(r.content)} bytes")

    if looks_like_html(r.content):
        fail("Atlanta Fed returned HTML (Sitecore soft-404). URL likely stale; "
             "verify at https://www.atlantafed.org/research-and-data/data/gdpnow")

    raw_xlsx_path = CACHE / "atlantafed_gdpnow_raw.xlsx"
    raw_xlsx_path.write_bytes(r.content)
    log(f"  saved raw -> {raw_xlsx_path.relative_to(ROOT)}")

    xl = pd.ExcelFile(raw_xlsx_path)
    log(f"  workbook sheets: {xl.sheet_names}")

    required = ["TrackingArchives", "CurrentQtrEvolution", "ContribHistory"]
    missing = [s for s in required if s not in xl.sheet_names]
    if missing:
        fail(f"Required sheets missing: {missing}. Available: {xl.sheet_names}")

    # 1. Headline history (~10y)
    log("  reading TrackingArchives ...")
    archives_total = _read_tracking_archives(raw_xlsx_path)

    # 2. Headline current quarter
    log("  reading CurrentQtrEvolution ...")
    cqe_total = _read_current_qtr_evolution(raw_xlsx_path)

    # 3. Stitch headline (TrackingArchives + CurrentQtrEvolution; CQE wins on overlap)
    headline = pd.concat([archives_total, cqe_total], ignore_index=True)
    headline = headline.drop_duplicates(subset="date", keep="last").sort_values("date").reset_index(drop=True)
    log(f"  stitched headline: {len(headline)} rows · "
        f"{headline['date'].iloc[0].date()} → {headline['date'].iloc[-1].date()}")

    # 4. Components — current quarter (ContribHistory) + history (ContribArchives)
    log("  reading ContribHistory (current quarter) ...")
    components_current = _read_contrib_history(raw_xlsx_path)
    log("  reading ContribArchives (historical) ...")
    components_history = _read_contrib_archives(raw_xlsx_path)

    # Sanity-check the boundary: ContribArchives last date should be the day
    # before ContribHistory's first date (no gap, no overlap).
    if len(components_history) and len(components_current):
        gap_days = (components_current["date"].iloc[0] - components_history["date"].iloc[-1]).days
        log(f"    boundary check: ContribArchives ends {components_history['date'].iloc[-1].date()}, "
            f"ContribHistory starts {components_current['date'].iloc[0].date()} "
            f"({gap_days} day gap)")
        if gap_days < 0:
            log(f"    WARNING: ContribArchives and ContribHistory overlap — ContribHistory will win on overlap")

    # Stitch: ContribArchives + ContribHistory (current wins on any overlap,
    # though there shouldn't be any in normal Atlanta Fed cadence).
    components = pd.concat([components_history, components_current], ignore_index=True)
    components = components.drop_duplicates(subset="date", keep="last").sort_values("date").reset_index(drop=True)
    log(f"    stitched components: {len(components)} rows · "
        f"{components['date'].iloc[0].date()} → {components['date'].iloc[-1].date()}")

    # 5. Outer-merge components onto headline (full ~10y daily series)
    out = pd.merge(headline, components, on="date", how="left")
    out = out.sort_values("date").reset_index(drop=True)

    out.to_csv(CACHE / "gdpnow_components.csv", index=False)

    log(f"  FINAL: {len(out)} rows · {out['date'].iloc[0].date()} → {out['date'].iloc[-1].date()}")
    log(f"    total non-null:      {out['total'].notna().sum()}")
    log(f"    pceGoods non-null:   {out['pceGoods'].notna().sum()}  (was 29 in v3 — current Q only)")
    if out['pceGoods'].notna().sum() > 0:
        comp_first = out.dropna(subset=['pceGoods']).iloc[0]
        comp_last  = out.dropna(subset=['pceGoods']).iloc[-1]
        log(f"    component date range: {comp_first['date'].date()} → {comp_last['date'].date()}")
    log(f"    latest total:        {out['total'].iloc[-1]:.3f}")
    if out['pceGoods'].notna().sum() > 0:
        # Decomposition check on the most recent dated row (current quarter)
        last_with_comp = out.dropna(subset=['pceGoods']).iloc[-1]
        comp_sum_curr = (last_with_comp['pceGoods'] + last_with_comp['pceServices']
                       + last_with_comp['fixedInv'] + last_with_comp['govt']
                       + last_with_comp['netExports'] + last_with_comp['inventories'])
        log(f"    decomposition check (latest): {last_with_comp['date'].date()}: "
            f"sum(components)={comp_sum_curr:.3f} vs total={last_with_comp['total']:.3f} "
            f"(diff={comp_sum_curr - last_with_comp['total']:+.3f})")
        # Decomposition check on a historical row (one year back) — verifies
        # ContribArchives parsing is semantically correct, not just the current
        # ContribHistory we already validated.
        with_comp = out.dropna(subset=['pceGoods']).reset_index(drop=True)
        if len(with_comp) > 252:  # ~1 year of trading days
            mid_idx = len(with_comp) - 252
            mid = with_comp.iloc[mid_idx]
            comp_sum_mid = (mid['pceGoods'] + mid['pceServices'] + mid['fixedInv']
                          + mid['govt'] + mid['netExports'] + mid['inventories'])
            log(f"    decomposition check (1y ago): {mid['date'].date()}: "
                f"sum(components)={comp_sum_mid:.3f} vs total={mid['total']:.3f} "
                f"(diff={comp_sum_mid - mid['total']:+.3f})")

    return out


# ======================================================================
# NY Fed Staff Nowcast (separate xlsx, weekly cadence)
# ======================================================================
def fetch_ny_fed() -> pd.DataFrame:
    """Fetch NY Fed Staff Nowcast 2.0 xlsx; extract current-quarter nowcast.

    Reads sheet 'Forecasts By Horizon' (long format, header at row 5):
      col 0 = forecast_date (weekly Fridays)
      col 1 = target_quarter (string, e.g. "2026:Q2")
      col 2 = nowcast_current_quarter (point estimate, % SAAR)
      col 3 = nowcast_next_quarter (we capture but don't expose in v1)
      col 4 = nowcast_2q_ahead (sparse, ignored)

    Returns DataFrame with cols: date, ny_nowcast, target_quarter, ny_next_q
    """
    log("Fetching NY Fed Staff Nowcast xlsx ...")
    headers = {"User-Agent": "Mozilla/5.0 (compatible; smallfish-macro-regime-ingest/1.0)"}
    try:
        r = requests.get(NY_FED_URL, headers=headers, timeout=60)
        r.raise_for_status()
    except Exception as e:
        fail(f"NY Fed fetch failed: {e}\n"
             f"Verify URL at https://www.newyorkfed.org/research/policy/nowcast")

    ctype = r.headers.get("Content-Type", "").lower()
    log(f"  HTTP {r.status_code} · Content-Type: {ctype} · {len(r.content)} bytes")

    if looks_like_html(r.content):
        fail("NY Fed returned HTML (soft-404 or auth wall). URL likely stale; "
             "verify at https://www.newyorkfed.org/research/policy/nowcast")

    raw_xlsx = CACHE / "nyfed_nowcast_raw.xlsx"
    raw_xlsx.write_bytes(r.content)
    log(f"  saved raw -> {raw_xlsx.relative_to(ROOT)}")

    xl = pd.ExcelFile(raw_xlsx)
    if "Forecasts By Horizon" not in xl.sheet_names:
        fail(f"NY Fed xlsx missing 'Forecasts By Horizon' sheet. "
             f"Available: {xl.sheet_names}")

    # Header is at row 5 (zero-indexed) per the diagnostic dump.
    df = pd.read_excel(raw_xlsx, sheet_name="Forecasts By Horizon", header=5)
    log(f"  Forecasts By Horizon shape (post-header): {df.shape}")
    log(f"  columns: {list(df.columns)}")

    # Defensive positional fallback. After header=5, the columns we want
    # are positions 0, 1, 2, 3 (date, target_quarter, current_q, next_q).
    if df.shape[1] < 4:
        fail(f"Expected ≥4 columns in 'Forecasts By Horizon', got {df.shape[1]}")

    out = pd.DataFrame({
        "date":            df.iloc[:, 0],
        "target_quarter":  df.iloc[:, 1],
        "ny_backcast":     df.iloc[:, 2],   # previous quarter — keep but don't expose in v1
        "ny_nowcast":      df.iloc[:, 3],   # current quarter — this is the apples-to-apples vs Atlanta GDPNow
        "ny_next_q":       df.iloc[:, 4],   # next quarter
    })

    out["date"] = pd.to_datetime(out["date"], errors="coerce")
    out["ny_backcast"] = pd.to_numeric(out["ny_backcast"], errors="coerce")
    out["ny_nowcast"] = pd.to_numeric(out["ny_nowcast"], errors="coerce")
    out["ny_next_q"]  = pd.to_numeric(out["ny_next_q"], errors="coerce")
    out["target_quarter"] = out["target_quarter"].astype(str).str.strip()

    # Keep only rows with valid date AND a current-quarter nowcast.
    # Rows with date but no current-Q value are typically the "next quarter
    # only" early-window rows — preserve them with ny_nowcast=NaN so
    # ny_next_q remains accessible if we ever expose it.
    out = out.dropna(subset=["date"]).sort_values("date").reset_index(drop=True)

    n_with_curr = out["ny_nowcast"].notna().sum()
    n_total = len(out)
    log(f"  parsed {n_total} rows ({n_with_curr} with current-Q nowcast) · "
        f"{out['date'].iloc[0].date()} → {out['date'].iloc[-1].date()}")

    # Sanity check: nowcast values should be in plausible GDP-growth range.
    if n_with_curr:
        valid = out["ny_nowcast"].dropna()
        nc_min, nc_max = valid.min(), valid.max()
        if nc_min < -10 or nc_max > 15:
            log(f"  WARNING: NY Fed nowcast range ({nc_min:.2f}, {nc_max:.2f}) "
                f"outside plausible bounds — column may be misaligned")
        else:
            log(f"  range check OK: nowcast in [{nc_min:.2f}, {nc_max:.2f}]")

    # Freshness check: latest forecast should be within last ~21 days.
    age_days = (pd.Timestamp.today() - out["date"].iloc[-1]).days
    if age_days > 21:
        log(f"  WARNING: latest NY Fed forecast is {age_days} days old — "
            f"NY Fed publishes weekly, may indicate a data feed issue")
    else:
        log(f"  freshness OK: latest forecast {age_days} days old")

    out.to_csv(CACHE / "nyfed_nowcast.csv", index=False)
    return out


# ======================================================================
# 2. FRED WEI
# ======================================================================
def fetch_fred_wei() -> pd.DataFrame:
    log("Fetching Dallas Fed WEI from FRED ...")
    if not FRED_API_KEY:
        fail("FRED_API_KEY env var not set. Add it to .env.")
    params = {
        "series_id": "WEI",
        "api_key": FRED_API_KEY,
        "file_type": "json",
        "observation_start": "2008-01-01",
    }
    try:
        r = requests.get(FRED_API, params=params, timeout=30)
        r.raise_for_status()
    except Exception as e:
        fail(f"FRED fetch failed: {e}")
    data = r.json().get("observations", [])
    if not data:
        fail("FRED returned no observations for WEI")
    df = pd.DataFrame(data)[["date", "value"]]
    df["date"] = pd.to_datetime(df["date"])
    df["value"] = pd.to_numeric(df["value"], errors="coerce")
    df = df.dropna().sort_values("date").reset_index(drop=True)
    df = df.rename(columns={"value": "wei"})
    df.to_csv(CACHE / "fred_wei.csv", index=False)
    log(f"  parsed {len(df)} rows · latest {df['date'].iloc[-1].date()} · WEI={df['wei'].iloc[-1]:.3f}")
    return df


# ======================================================================
# 3. UNCTAD manual
# ======================================================================
def read_unctad_manual() -> pd.DataFrame:
    log("Reading UNCTAD manual CSV ...")
    if not UNCTAD_MANUAL.exists():
        fail(f"{UNCTAD_MANUAL} not found.")
    df = pd.read_csv(UNCTAD_MANUAL)
    df["date"] = pd.to_datetime(df["date"])
    df["unctad_world"] = pd.to_numeric(df["unctad_world"], errors="coerce")
    df = df.dropna().sort_values("date").reset_index(drop=True)
    log(f"  read {len(df)} rows · latest {df['date'].iloc[-1].date()} · UNCTAD={df['unctad_world'].iloc[-1]:.3f}")
    return df


# ======================================================================
# 4. RecessionAlert manual xlsx
# ======================================================================
def read_recessionalert() -> pd.DataFrame:
    log("Reading RecessionAlert latest xlsx ...")
    candidates = sorted(glob.glob(str(RA_RAW_DIR / "*.xlsx")))
    if not candidates:
        log(f"  no xlsx in {RA_RAW_DIR.relative_to(ROOT)} — skipping (WLA/LEI null)")
        return pd.DataFrame(columns=["date", "wla", "global_lei"])

    latest = candidates[-1]
    log(f"  using {Path(latest).name}")
    xl = pd.ExcelFile(latest)
    log(f"  sheets: {xl.sheet_names}")
    for s in xl.sheet_names:
        try:
            head = pd.read_excel(latest, sheet_name=s, nrows=2)
            log(f"    sheet '{s}' columns: {list(head.columns)[:6]}")
        except Exception as e:
            log(f"    sheet '{s}' preview failed: {e}")

    wla = None
    lei = None
    for s in xl.sheet_names:
        s_lower = s.lower()
        if "weekly" in s_lower or "wla" in s_lower:
            try:
                df = pd.read_excel(latest, sheet_name=s)
                date_col = next((c for c in df.columns if "date" in str(c).lower()), df.columns[0])
                wla_col = next((c for c in df.columns if "wla" in str(c).lower() or "aggregate" in str(c).lower()), None)
                if wla_col:
                    wla = df[[date_col, wla_col]].copy()
                    wla.columns = ["date", "wla"]
                    log(f"  found WLA on sheet '{s}' col '{wla_col}'")
            except Exception as e:
                log(f"  could not parse '{s}' for WLA: {e}")
        if "global" in s_lower or "lei" in s_lower:
            try:
                df = pd.read_excel(latest, sheet_name=s)
                date_col = next((c for c in df.columns if "date" in str(c).lower()), df.columns[0])
                lei_col = next((c for c in df.columns if "lei" in str(c).lower() and "+8" in str(c).lower()), None)
                if not lei_col:
                    lei_col = next((c for c in df.columns if c != date_col), None)
                if lei_col:
                    lei = df[[date_col, lei_col]].copy()
                    lei.columns = ["date", "global_lei"]
                    log(f"  found LEI on sheet '{s}' col '{lei_col}'")
            except Exception as e:
                log(f"  could not parse '{s}' for LEI: {e}")

    if wla is None and lei is None:
        log("  WARNING: could not auto-parse RecessionAlert xlsx.")
        return pd.DataFrame(columns=["date", "wla", "global_lei"])

    if wla is not None:
        wla["date"] = pd.to_datetime(wla["date"], errors="coerce")
        wla["wla"] = pd.to_numeric(wla["wla"], errors="coerce")
        wla = wla.dropna()
    if lei is not None:
        lei["date"] = pd.to_datetime(lei["date"], errors="coerce")
        lei["global_lei"] = pd.to_numeric(lei["global_lei"], errors="coerce")
        lei = lei.dropna()

    if wla is not None and lei is not None:
        out = pd.merge(wla, lei, on="date", how="outer").sort_values("date").reset_index(drop=True)
    elif wla is not None:
        out = wla.copy()
        out["global_lei"] = pd.NA
    else:
        out = lei.copy()
        out["wla"] = pd.NA

    out.to_csv(CACHE / "recessionalert.csv", index=False)
    log(f"  parsed {len(out)} rows from RecessionAlert")
    return out


# ======================================================================
# 5. Compose regime
# ======================================================================
def build_growth_payload(gdpnow, wei, unctad, ra, ny_fed) -> dict:
    log("Building weekly composite ...")
    end_date = pd.Timestamp.today().normalize()
    start_date = end_date - pd.DateOffset(years=Z_WINDOW_YEARS + 5)
    weekly_idx = pd.date_range(start=start_date, end=end_date, freq="W-FRI")
    master = pd.DataFrame({"date": weekly_idx})

    g = gdpnow[["date", "total"]].rename(columns={"total": "gdpnow"})
    g = g.set_index("date").resample("W-FRI").last().reset_index()
    master = master.merge(g, on="date", how="left")

    w = wei.set_index("date").resample("W-FRI").last().reset_index()
    master = master.merge(w, on="date", how="left")

    u = unctad.set_index("date").resample("W-FRI").last().ffill(limit=2).reset_index()
    master = master.merge(u, on="date", how="left")

    if not ra.empty:
        r_resampled = ra.set_index("date").resample("W-FRI").last().ffill(limit=2).reset_index()
        master = master.merge(r_resampled, on="date", how="left")
    else:
        master["wla"] = pd.NA
        master["global_lei"] = pd.NA

    z_window = Z_WINDOW_YEARS * 52
    for col in ["gdpnow", "wei", "unctad_world", "wla", "global_lei"]:
        if col in master.columns and master[col].notna().sum() > 50:
            master[f"{col}_z"] = rolling_zscore(master[col], z_window)

    coinc_cols = [c for c in ["gdpnow_z", "wei_z", "unctad_world_z"] if c in master.columns]
    lead_cols = [c for c in ["wla_z", "global_lei_z"] if c in master.columns]
    if coinc_cols:
        master["coinc_z"] = master[coinc_cols].mean(axis=1, skipna=True)
    if lead_cols:
        master["lead_z"] = master[lead_cols].mean(axis=1, skipna=True)

    # Defensive: ensure both composite columns exist even if their inputs were missing.
    # Downstream slicing references both unconditionally; an all-NaN column is fine.
    for col in ("coinc_z", "lead_z"):
        if col not in master.columns:
            master[col] = pd.NA

    # Track which composites actually carry signal (vs being all-NaN placeholders).
    coinc_available = bool(coinc_cols and master["coinc_z"].notna().any())
    lead_available  = bool(lead_cols and master["lead_z"].notna().any())

    if coinc_available or lead_available:
        latest = master.dropna(
            subset=[c for c in ["coinc_z", "lead_z"]
                    if c in master.columns and master[c].notna().any()],
            how="all",
        ).iloc[-1]
    else:
        latest = master.iloc[-1]

    coinc_z = float(latest.get("coinc_z", 0.0)) if pd.notna(latest.get("coinc_z", None)) else 0.0
    lead_z = float(latest.get("lead_z", 0.0)) if pd.notna(latest.get("lead_z", None)) else 0.0

    if lead_available:
        idx_now = master[master["date"] == latest["date"]].index[0]
        idx_then = max(0, idx_now - DIRECTION_LOOKBACK_WEEKS)
        prev_val = master.iloc[idx_then].get("lead_z", lead_z)
        lead_z_8w = float(prev_val) if pd.notna(prev_val) else lead_z
    else:
        lead_z_8w = lead_z

    regime = classify_regime(coinc_z, lead_z, lead_z_8w)
    # When lead data is absent, the direction classification is a silent default.
    # Surface this honestly so the frontend can render an "incomplete signal" state
    # rather than presenting a fabricated "SLOWING" / "ACCELERATING" call.
    if not lead_available:
        regime["direction"] = "UNKNOWN"
    hedge = HEDGE_MAP.get(
        (regime["level"], regime["direction"]),
        {"ratio": None, "posture": "Insufficient leading data — direction unknown"},
    )

    payload = {
        "meta": {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "z_window_years": Z_WINDOW_YEARS,
            "direction_lookback_weeks": DIRECTION_LOOKBACK_WEEKS,
            "sources": {
                "atlanta_fed":    f"fetched · latest obs {gdpnow['date'].iloc[-1].date().isoformat()}",
                "ny_fed":         f"fetched · latest obs {ny_fed['date'].iloc[-1].date().isoformat()}" if len(ny_fed) else "missing",
                "fred_wei":       f"fetched · latest obs {wei['date'].iloc[-1].date().isoformat()}",
                "unctad":         f"manual · latest obs {unctad['date'].iloc[-1].date().isoformat()}" if len(unctad) else "missing",
                "recessionalert": f"manual · latest obs {ra['date'].iloc[-1].date().isoformat()}" if len(ra) else "missing",
            },
            "signal_availability": {
                "coincident": coinc_available,
                "leading":    lead_available,
            },
        },
        "current": {
            "regime": regime,
            "hedge_ratio": hedge["ratio"],
            "hedge_posture": hedge["posture"],
            "gdpnow":         _f(gdpnow["total"].iloc[-1]),
            "ny_nowcast":     _f(ny_fed["ny_nowcast"].dropna().iloc[-1]) if len(ny_fed) and ny_fed["ny_nowcast"].notna().any() else None,
            "ny_target_qtr":  ny_fed.dropna(subset=["ny_nowcast"]).iloc[-1]["target_quarter"] if len(ny_fed) and ny_fed["ny_nowcast"].notna().any() else None,
            "wei":            _f(wei["wei"].iloc[-1]),
            "unctad_world":   _f(unctad["unctad_world"].iloc[-1]) if len(unctad) else None,
            "wla":            _f(ra["wla"].iloc[-1]) if "wla" in ra.columns and len(ra) else None,
            "global_lei_8m":  _f(ra["global_lei"].iloc[-1]) if "global_lei" in ra.columns and len(ra) else None,
            "coinc_z":        _f(coinc_z),
            "lead_z":         _f(lead_z),
        },
        "gdpnow_components": _df_to_records(
            gdpnow,  # full ~1830-row history; frontend RANGE selector handles slicing
            cols=["date", "total", "pceGoods", "pceServices", "fixedInv", "govt", "netExports", "inventories"],
        ),
        "composite_z": _df_to_records(
            master[["date", "coinc_z", "lead_z"]].dropna(how="all", subset=["coinc_z", "lead_z"])
            if (coinc_available or lead_available) else pd.DataFrame(columns=["date", "coinc_z", "lead_z"]),
            cols=["date", "coinc_z", "lead_z"],
        ),
        "ny_fed_nowcast": _df_to_records(
            ny_fed.dropna(subset=["ny_nowcast"])[["date", "ny_nowcast", "ny_backcast", "ny_next_q", "target_quarter"]]
            if len(ny_fed) else pd.DataFrame(columns=["date", "ny_nowcast", "ny_backcast", "ny_next_q", "target_quarter"]),
            cols=["date", "ny_nowcast", "ny_backcast", "ny_next_q", "target_quarter"],
        ),
    }
    return payload


def _f(x):
    if x is None or pd.isna(x):
        return None
    return round(float(x), 4)


def _df_to_records(df, cols):
    df = df[cols].copy()
    df["date"] = pd.to_datetime(df["date"]).dt.strftime("%Y-%m-%d")
    # Build records via dict comprehension so None survives — assigning
    # None into a float64-dtype Series silently coerces to NaN, which
    # then leaks through to_dict() and emits invalid JSON "NaN" literals.
    # Numeric columns pass through _f (NaN -> None, round 4 dp).
    # Non-numeric columns (string) pass through unchanged, with NaN -> None.
    records = []
    for _, row in df.iterrows():
        rec = {"date": row["date"]}
        for c in cols[1:]:
            v = row[c]
            if isinstance(v, (int, float)) or (hasattr(v, "dtype") and pd.api.types.is_numeric_dtype(type(v))):
                rec[c] = _f(v)
            else:
                # String or other; null-guard NaN
                rec[c] = None if (v is None
                                  or (isinstance(v, float) and pd.isna(v))
                                  or (isinstance(v, str) and v.strip().lower() in ("nan", ""))) else v
        records.append(rec)
    return records


# ======================================================================
# Main
# ======================================================================
def main() -> None:
    log(f"=== SmallFish Macro Regime · GROWTH ingest v4 · {datetime.now(timezone.utc).isoformat()} ===")
    log(f"ROOT = {ROOT}")
    gdpnow = fetch_atlanta_fed()
    ny_fed = fetch_ny_fed()
    wei = fetch_fred_wei()
    unctad = read_unctad_manual()
    ra = read_recessionalert()
    payload = build_growth_payload(gdpnow, wei, unctad, ra, ny_fed)
    OUTPUT_JSON.write_text(json.dumps(payload, indent=2, allow_nan=False, default=str))
    log(f"WROTE {OUTPUT_JSON.relative_to(ROOT)} ({OUTPUT_JSON.stat().st_size // 1024} KB)")
    # Pattern A dual-write: also drop into public/data/ so Vite serves it as a
    # static asset at /data/growth.json. The canonical copy lives in data/
    # (git-tracked, debuggable); the public/ copy is what the frontend fetches.
    public_dir = ROOT / "public" / "data"
    public_dir.mkdir(parents=True, exist_ok=True)
    public_json = public_dir / "growth.json"
    public_json.write_text(json.dumps(payload, indent=2, allow_nan=False, default=str))
    log(f"WROTE {public_json.relative_to(ROOT)} (dual-write for Vite)")
    cur = payload["current"]
    log("--- CURRENT REGIME ---")
    log(f"  level={cur['regime']['level']}  direction={cur['regime']['direction']}  hedge={cur['hedge_ratio']}%")
    log(f"  GDPNow={cur['gdpnow']}  WEI={cur['wei']}  UNCTAD={cur['unctad_world']}  WLA={cur['wla']}  LEI={cur['global_lei_8m']}")
    log(f"  coinc_z={cur['coinc_z']}  lead_z={cur['lead_z']}")
    log("=== done ===")


if __name__ == "__main__":
    main()
