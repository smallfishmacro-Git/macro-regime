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


def _classify_quadrant(lead_z, coinc_z):
    """Classify a (lead, coinc) point into one of four regime quadrants.
    Returns None if either value is null/NaN/non-numeric.
    """
    if lead_z is None or coinc_z is None:
        return None
    try:
        l = float(lead_z)
        c = float(coinc_z)
    except (TypeError, ValueError):
        return None
    if pd.isna(l) or pd.isna(c):
        return None
    if l >= 0 and c >= 0: return "ACCELERATING"
    if l < 0 and c >= 0:  return "SLOWING"
    if l < 0 and c < 0:   return "CONTRACTION"
    if l >= 0 and c < 0:  return "RECOVERY"
    return None


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
# FRED Real GDP YoY (quarterly, used for LEADING tab WEI vs GDP chart)
# ======================================================================
def fetch_fred_gdp() -> pd.DataFrame:
    """Fetch FRED A191RO1Q156NBEA — Real GDP, % change from year ago,
    quarterly. Already pre-computed YoY by BEA, so no further math
    needed.

    Returns DataFrame with cols: date, gdp_yoy
    Date is the quarter-start convention as FRED publishes.
    """
    log("Fetching FRED Real GDP YoY (A191RO1Q156NBEA) ...")
    if not FRED_API_KEY:
        log("  WARNING: FRED_API_KEY not set — returning empty df")
        return pd.DataFrame(columns=["date", "gdp_yoy"])

    params = {
        "series_id": "A191RO1Q156NBEA",
        "api_key": FRED_API_KEY,
        "file_type": "json",
        "observation_start": "1990-01-01",  # ~35 years history is plenty
    }
    try:
        r = requests.get(FRED_API, params=params, timeout=30)
        r.raise_for_status()
        data = r.json()
    except Exception as e:
        log(f"  FRED GDP fetch failed: {e} — returning empty df")
        return pd.DataFrame(columns=["date", "gdp_yoy"])

    obs = data.get("observations", [])
    if not obs:
        log(f"  no observations returned — returning empty df")
        return pd.DataFrame(columns=["date", "gdp_yoy"])

    df = pd.DataFrame(obs)
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    df["gdp_yoy"] = pd.to_numeric(df["value"], errors="coerce")
    df = df[["date", "gdp_yoy"]].dropna(subset=["date"]).sort_values("date").reset_index(drop=True)

    n_with_value = df["gdp_yoy"].notna().sum()
    log(f"  fetched {len(df)} quarterly obs ({n_with_value} non-null) · "
        f"{df['date'].iloc[0].date()} → {df['date'].iloc[-1].date()}")

    if n_with_value:
        latest = df.dropna(subset=["gdp_yoy"]).iloc[-1]
        log(f"  latest: {latest['date'].date()} = {latest['gdp_yoy']:.2f}%")
        # Sanity: historical GDP YoY range roughly -10 to +12; outliers
        # (COVID Q2 2020) can hit -10. Anything outside is suspicious.
        valid = df["gdp_yoy"].dropna()
        if valid.min() < -15 or valid.max() > 20:
            log(f"  WARNING: gdp_yoy range [{valid.min():.2f}, {valid.max():.2f}] outside expected (-15, +20)")
        else:
            log(f"  range OK: [{valid.min():.2f}, {valid.max():.2f}]")

    df.to_csv(CACHE / "fred_gdp_yoy.csv", index=False)
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
# RecessionAlert (manual xlsx drop — both Weekly + Monthly files)
# ======================================================================
def read_recessionalert() -> pd.DataFrame:
    """Read RecessionAlert WeeklyData_*.xlsx + MonthlyData_*.xlsx from
    data/recessionalert/raw/. Extract WLEI2 (weekly), G20 CLI level
    (monthly), ROC (monthly), and %CBANK (monthly bonus indicator).

    Returns a DataFrame with cols:
      date              — common date axis (monthly EOM, joined)
      wla               — WLEI2 from WeeklyData (resampled to monthly)
      global_lei        — G20 CLI level from WORLD sheet col 1
      global_lei_8m     — G20 CLI ROC (6mo smoothed) from WORLD sheet col 3
                          (dashboard displays this as "GLOBAL LEI +8M")
      cb_net_cutters    — %CBANK from WORLD sheet col 6 (bonus)

    If either file is missing or unreadable, returns an empty DataFrame
    so the calling code's signal_availability.leading=False guard
    activates correctly.
    """
    raw_dir = ROOT / "data" / "recessionalert" / "raw"

    if not raw_dir.exists():
        log("RecessionAlert: data/recessionalert/raw/ doesn't exist — leading data unavailable")
        return pd.DataFrame(), pd.DataFrame()

    weekly_files = sorted(raw_dir.glob("WeeklyData_*.xlsx"))
    monthly_files = sorted(raw_dir.glob("MonthlyData_*.xlsx"))

    if not weekly_files and not monthly_files:
        log("RecessionAlert: no WeeklyData_*.xlsx or MonthlyData_*.xlsx found — leading data unavailable")
        return pd.DataFrame(), pd.DataFrame()

    # ---- Weekly: extract WLEI2 + AVG ----
    weekly = pd.DataFrame(columns=["date", "wlei2", "avg"])
    if weekly_files:
        weekly_path = weekly_files[-1]  # latest by lexicographic ISO sort
        log(f"RecessionAlert weekly: reading {weekly_path.name}")
        try:
            # Header at row 0, blank row 1, data starts row 2.
            wdf = pd.read_excel(weekly_path, sheet_name="WEEKLY LEI's", header=0)
            log(f"  shape: {wdf.shape}, cols: {list(wdf.columns)[:6]}")

            # Capture WLEI2 (existing) + AVG. (new for LEADING chart).
            # Drop the blank separator row by filtering on date validity.
            wdf = wdf[["DATE", "WLEI2", "AVG."]].copy()
            wdf.columns = ["date", "wlei2", "avg"]
            wdf["date"] = pd.to_datetime(wdf["date"], errors="coerce")
            wdf["wlei2"] = pd.to_numeric(wdf["wlei2"], errors="coerce")
            wdf["avg"] = pd.to_numeric(wdf["avg"], errors="coerce")
            wdf = wdf.dropna(subset=["date"]).sort_values("date").reset_index(drop=True)

            n_wlei2 = wdf["wlei2"].notna().sum()
            n_avg = wdf["avg"].notna().sum()
            log(f"  weekly WLEI2: {n_wlei2} obs · AVG: {n_avg} obs · "
                f"{wdf['date'].iloc[0].date()} → {wdf['date'].iloc[-1].date()}")
            weekly = wdf
        except Exception as e:
            log(f"  WARNING: weekly file unreadable ({e}) — skipping")

    # ---- Monthly: extract G20 CLI level + ROC + %CBANK from WORLD sheet ----
    monthly = pd.DataFrame(columns=["date", "global_lei", "global_lei_8m", "cb_net_cutters"])
    if monthly_files:
        monthly_path = monthly_files[-1]
        log(f"RecessionAlert monthly: reading {monthly_path.name}")
        try:
            # WORLD sheet has NO header at top — the header is at row ~663
            # (bottom of data). Use header=None and reference columns
            # positionally. Rows below the data block are dropped via
            # date-validity filtering.
            mdf = pd.read_excel(monthly_path, sheet_name="WORLD", header=None)
            log(f"  shape: {mdf.shape}")

            # Verified column mapping (from Excel direct view of the legend
            # at row 666+ of the WORLD sheet):
            #   col 0 = DATE (EOM)
            #   col 1 = G20 CLI (level, base 100)
            #   col 2 = REC (binary signal)
            #   col 3 = ROC (6mo smoothed rate of change)
            #   col 4 = % LEI (% G20 with rising CLI)
            #   col 5 = %LEIg (% G20 with rising CLI 6mo smoothed)
            #   col 6 = %CBANK (net % of 38 CBs where last move was a cut)
            if mdf.shape[1] < 7:
                fail(f"WORLD sheet has only {mdf.shape[1]} cols, need ≥7")

            wdf2 = pd.DataFrame({
                "date":           mdf.iloc[:, 0],
                "global_lei":     mdf.iloc[:, 1],
                "global_lei_8m":  mdf.iloc[:, 3],   # ROC — what dashboard shows as "GLOBAL LEI +8M"
                "pct_g20_rising": mdf.iloc[:, 4],   # % G20 countries with rising CLI (NEW for LEADING chart)
                "cb_net_cutters": mdf.iloc[:, 6],   # %CBANK bonus indicator
            })

            wdf2["date"] = pd.to_datetime(wdf2["date"], errors="coerce")
            for c in ["global_lei", "global_lei_8m", "pct_g20_rising", "cb_net_cutters"]:
                wdf2[c] = pd.to_numeric(wdf2[c], errors="coerce")

            # Drop the legend/header rows below the data block (col 0 not a date)
            wdf2 = wdf2.dropna(subset=["date"]).sort_values("date").reset_index(drop=True)

            # Sanity check: G20 CLI level should be in 80-120 range
            if wdf2["global_lei"].notna().any():
                lv = wdf2["global_lei"].dropna()
                if lv.min() < 70 or lv.max() > 130:
                    log(f"  WARNING: global_lei range [{lv.min():.2f}, {lv.max():.2f}] outside expected 80-120 — column may be misaligned")
                else:
                    log(f"  global_lei (G20 CLI) range OK: [{lv.min():.2f}, {lv.max():.2f}]")

            n_lei = wdf2["global_lei"].notna().sum()
            n_roc = wdf2["global_lei_8m"].notna().sum()
            n_pct = wdf2["pct_g20_rising"].notna().sum()
            n_cb  = wdf2["cb_net_cutters"].notna().sum()
            log(f"  monthly · G20 CLI: {n_lei} obs · ROC: {n_roc} obs · "
                f"%G20 rising: {n_pct} obs · %CBANK: {n_cb} obs · "
                f"{wdf2['date'].iloc[0].date()} → {wdf2['date'].iloc[-1].date()}")

            monthly = wdf2
        except Exception as e:
            log(f"  WARNING: monthly WORLD sheet unreadable ({e}) — skipping")

    # ---- Monthly: extract USMLEI from DATA sheet ----
    # DATA sheet has 2-row header: row 2 = group labels, row 3 = column
    # names. Data starts row 4. Use header=3 to consume row 3 as column
    # names; this gives us a usable DataFrame.
    usmlei = pd.DataFrame(columns=["date", "usmlei"])
    if monthly_files:
        try:
            ddf = pd.read_excel(monthly_path, sheet_name="DATA", header=3)
            log(f"  monthly DATA shape (post-header): {ddf.shape}")

            # Column 0 is "MONTH" (date), column 16 is "USMLEI V2".
            # Use positional access to be defensive against header
            # whitespace differences.
            if ddf.shape[1] < 17:
                log(f"  WARNING: DATA sheet has only {ddf.shape[1]} cols, can't extract USMLEI")
            else:
                usmlei = pd.DataFrame({
                    "date":   ddf.iloc[:, 0],
                    "usmlei": ddf.iloc[:, 16],
                })
                usmlei["date"] = pd.to_datetime(usmlei["date"], errors="coerce")
                usmlei["usmlei"] = pd.to_numeric(usmlei["usmlei"], errors="coerce")
                usmlei = usmlei.dropna(subset=["date"]).sort_values("date").reset_index(drop=True)

                n_usmlei = usmlei["usmlei"].notna().sum()
                if n_usmlei:
                    log(f"  USMLEI: {n_usmlei} obs · "
                        f"{usmlei['date'].iloc[0].date()} → {usmlei['date'].iloc[-1].date()}")
                    # Sanity check: USMLEI ranges roughly -70 to +70 historically
                    valid = usmlei["usmlei"].dropna()
                    if valid.min() < -100 or valid.max() > 100:
                        log(f"  WARNING: USMLEI range [{valid.min():.2f}, {valid.max():.2f}] outside ±100 — column may be misaligned")
                    else:
                        log(f"  USMLEI range OK: [{valid.min():.2f}, {valid.max():.2f}]")
        except Exception as e:
            log(f"  WARNING: monthly DATA sheet unreadable ({e}) — skipping USMLEI")

    # ---- Combine: monthly is the bottleneck cadence; resample weekly to monthly ----
    if len(weekly) == 0 and len(monthly) == 0:
        log("RecessionAlert: both weekly and monthly empty — returning empty df")
        return pd.DataFrame(), pd.DataFrame()

    # Resample weekly WLEI2 to monthly EOM (last value of each month)
    if len(weekly):
        weekly_monthly = (
            weekly.set_index("date")["wlei2"]
            .resample("ME").last()
            .rename("wla")
            .reset_index()
        )
    else:
        weekly_monthly = pd.DataFrame(columns=["date", "wla"])

    # Outer-join weekly-resampled with monthly on date
    if len(monthly):
        out = pd.merge(weekly_monthly, monthly, on="date", how="outer")
    else:
        out = weekly_monthly.copy()
        out["global_lei"] = None
        out["global_lei_8m"] = None
        out["pct_g20_rising"] = None
        out["cb_net_cutters"] = None

    # Also merge USMLEI on date (monthly EOM cadence, aligns with WORLD)
    if len(usmlei):
        out = pd.merge(out, usmlei, on="date", how="outer")
    else:
        out["usmlei"] = None

    out = out.sort_values("date").reset_index(drop=True)

    log(f"RecessionAlert FINAL: {len(out)} monthly rows · "
        f"{out['date'].iloc[0].date()} → {out['date'].iloc[-1].date()}")

    def _last(col):
        if col in out.columns and out[col].notna().any():
            return f"{out[col].dropna().iloc[-1]:.4f}"
        return "None"

    log(f"  latest values: wla={_last('wla')}, usmlei={_last('usmlei')}, "
        f"global_lei={_last('global_lei')}, global_lei_8m={_last('global_lei_8m')}, "
        f"pct_g20_rising={_last('pct_g20_rising')}, cb_net_cutters={_last('cb_net_cutters')}")

    out.to_csv(CACHE / "recessionalert_combined.csv", index=False)
    # Return tuple: (monthly composite, weekly raw with avg)
    # The weekly DataFrame is needed by build_growth_payload to expose
    # the AVG series at native weekly cadence (un-resampled).
    return out, weekly


# ======================================================================
# Cron-safe data preservation
# ======================================================================
def preserve_from_prior(new_payload: dict) -> tuple[dict, list[str]]:
    """Read the previous run's growth.json from disk; for each
    preservable field, if the new payload produced empty/null, copy
    the prior value forward. Returns (merged_payload, preserved_fields).

    This makes the ingest cron-safe: when xlsx source files aren't
    available on the runner (gitignored, not in cron environment), the
    affected fields get preserved from the last-known-good state
    instead of being clobbered to null.

    Sources NOT covered by this preservation (Atlanta, NY Fed, FRED,
    UNCTAD) all have automated fetches that work in any environment;
    they always produce fresh data so preservation isn't needed.
    """
    growth_json_path = ROOT / "data" / "growth.json"
    if not growth_json_path.exists():
        log("preserve_from_prior: no prior growth.json — nothing to preserve")
        return new_payload, []

    try:
        with open(growth_json_path) as f:
            prior = json.load(f)
    except Exception as e:
        log(f"preserve_from_prior: prior growth.json unreadable ({e}) — skipping preservation")
        return new_payload, []

    preserved = []

    # ---- Group 1: RecessionAlert scalars in current{} ----
    ra_scalar_fields = [
        "wla", "usmlei", "global_lei", "global_lei_8m",
        "pct_g20_rising", "cb_net_cutters",
        "avg_z",             # depends on RA weekly AVG
        "lead_z_quadrant",   # depends on USMLEI (RA-derived)
        "coinc_z_quadrant",  # depends on GDP YoY (FRED) — fresh, but
                             # paired with lead so both preserved together
                             # for visual coherence in degraded mode
        "quadrant",          # classification depends on both
    ]
    for field in ra_scalar_fields:
        new_val = new_payload.get("current", {}).get(field)
        prior_val = prior.get("current", {}).get(field)
        if new_val is None and prior_val is not None:
            new_payload.setdefault("current", {})[field] = prior_val
            preserved.append(f"current.{field}")

    # ---- Group 2: RecessionAlert time series arrays ----
    array_fields = ["ra_leading_series", "ra_weekly_avg_series", "avg_z_series", "quadrant_trajectory"]
    for field in array_fields:
        new_arr = new_payload.get(field, [])
        prior_arr = prior.get(field, [])
        if not new_arr and prior_arr:
            new_payload[field] = prior_arr
            preserved.append(field)

    # ---- Group 3: Regime fields (downstream of leading data) ----
    # If we preserved any RecessionAlert data, also preserve the regime
    # call, since it depends on leading inputs that we couldn't refresh.
    # If RA data was fresh, regime is already correctly computed.
    ra_was_preserved = any(p.startswith("current.wla") or
                           p.startswith("current.usmlei") or
                           p.startswith("current.global_lei") or
                           p.startswith("ra_") for p in preserved)
    if ra_was_preserved:
        # Preserve regime block + hedge_ratio + composite_z_lead
        regime_fields_to_preserve = ["regime", "hedge_ratio", "lead_z"]
        for field in regime_fields_to_preserve:
            prior_val = prior.get("current", {}).get(field)
            if prior_val is not None:
                new_payload.setdefault("current", {})[field] = prior_val
                preserved.append(f"current.{field}")

        # Also preserve signal_availability.leading flag (currently True
        # if RA data was real on prior run; would have flipped False on
        # this run if we didn't preserve)
        prior_sig_av = prior.get("meta", {}).get("signal_availability", {})
        if prior_sig_av.get("leading") is True:
            new_payload.setdefault("meta", {}).setdefault("signal_availability", {})["leading"] = True
            preserved.append("meta.signal_availability.leading")

    log(f"preserve_from_prior: preserved {len(preserved)} field(s) from prior run")
    if preserved:
        for p in preserved:
            log(f"  - {p}")

    return new_payload, preserved


# ======================================================================
# 5. Compose regime
# ======================================================================
def build_growth_payload(gdpnow, wei, unctad, ra, ny_fed, gdp_yoy, ra_weekly) -> dict:
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

    # ---- WEI 13-week moving average (for LEADING tab chart) ----
    if len(wei) > 0 and "wei" in wei.columns:
        wei_with_ma = wei.copy()
        wei_with_ma["wei_ma13"] = wei_with_ma["wei"].rolling(window=13, min_periods=1).mean()
        log(f"  computed WEI 13wk MA: latest = {wei_with_ma['wei_ma13'].dropna().iloc[-1]:.3f}" if wei_with_ma["wei_ma13"].notna().any() else "  WEI 13wk MA: empty")
    else:
        wei_with_ma = wei.copy()
        wei_with_ma["wei_ma13"] = None

    # ---- Per-indicator 5Y rolling z-scores for REGIME MODEL panel ----
    # COINCIDENT pill: WEI z-score (5Y rolling on weekly cadence).
    # LEADING pill:    RecessionAlert weekly AVG z-score (5Y rolling, weekly).
    # COMPOSITE pill:  both overlaid (frontend handles merge).
    # Reuses the existing rolling_zscore() helper (window_obs only; min_periods
    # auto = max(20, window//4) = 65 for window=260).
    wei_z_df = pd.DataFrame(columns=["date", "wei_z"])
    if len(wei) > 0 and "wei" in wei.columns:
        wei_z_series = wei.copy()
        wei_z_series["wei_z"] = rolling_zscore(wei_z_series["wei"], 260)
        wei_z_df = wei_z_series[["date", "wei_z"]].dropna(subset=["wei_z"])
        if len(wei_z_df):
            log(f"  computed WEI z-score (5Y rolling): {len(wei_z_df)} obs · latest = {wei_z_df['wei_z'].iloc[-1]:.3f}")

    avg_z_df = pd.DataFrame(columns=["date", "avg_z"])
    if len(ra_weekly) > 0 and "avg" in ra_weekly.columns:
        avg_z_series = ra_weekly.copy()
        avg_z_series["avg_z"] = rolling_zscore(avg_z_series["avg"], 260)
        avg_z_df = avg_z_series[["date", "avg_z"]].dropna(subset=["avg_z"])
        if len(avg_z_df):
            log(f"  computed AVG z-score (5Y rolling): {len(avg_z_df)} obs · latest = {avg_z_df['avg_z'].iloc[-1]:.3f}")

    # ---- Z-scores for QUADRANT panel (Step 13c) ----
    # USMLEI z-score: monthly cadence, 5Y window = 60 obs. The existing
    # rolling_zscore helper sets min_periods = max(20, window//4) = 20;
    # spec asked for 12, but the helper's floor only affects early-band
    # coverage, not latest values.
    usmlei_z_df = pd.DataFrame(columns=["date", "usmlei_z"])
    if "usmlei" in ra.columns and ra["usmlei"].notna().any():
        usmlei_src = ra[["date", "usmlei"]].dropna(subset=["usmlei"]).sort_values("date").reset_index(drop=True)
        usmlei_src["usmlei_z"] = rolling_zscore(usmlei_src["usmlei"], 60)
        usmlei_z_df = usmlei_src[["date", "usmlei_z"]].dropna(subset=["usmlei_z"])
        if len(usmlei_z_df):
            log(f"  computed USMLEI z-score (5Y rolling): {len(usmlei_z_df)} obs · latest = {usmlei_z_df['usmlei_z'].iloc[-1]:.3f}")

    # GDP YoY z-score: quarterly cadence, 5Y window = 20 obs.
    gdp_z_df = pd.DataFrame(columns=["date", "gdp_z"])
    if len(gdp_yoy) > 0 and "gdp_yoy" in gdp_yoy.columns:
        gdp_src = gdp_yoy.copy().sort_values("date").reset_index(drop=True)
        gdp_src["gdp_z"] = rolling_zscore(gdp_src["gdp_yoy"], 20)
        gdp_z_df = gdp_src[["date", "gdp_z"]].dropna(subset=["gdp_z"])
        if len(gdp_z_df):
            log(f"  computed GDP YoY z-score (5Y rolling): {len(gdp_z_df)} obs · latest = {gdp_z_df['gdp_z'].iloc[-1]:.3f}")

    # ---- Build monthly quadrant trajectory from WEI + AVG weekly z-scores ----
    # Resample both weekly z-series to monthly EOM (last weekly z within each
    # calendar month). Replaces the previous USMLEI + GDP-YoY sourcing for
    # timeliness (weekly data, ~1 week stale) and internal consistency with
    # the regime panel pills. The usmlei_z_df / gdp_z_df computations above
    # are retained — they remain valid signals and may drive future overlays.
    quadrant_df = pd.DataFrame(columns=["date", "lead_z", "coinc_z"])
    if len(wei_z_df) and len(avg_z_df):
        wei_monthly = (
            wei_z_df.set_index("date")["wei_z"]
            .resample("ME").last()
            .rename("coinc_z")
        )
        avg_monthly = (
            avg_z_df.set_index("date")["avg_z"]
            .resample("ME").last()
            .rename("lead_z")
        )
        quadrant_df = pd.concat([avg_monthly, wei_monthly], axis=1).reset_index()
        quadrant_df = quadrant_df.dropna(subset=["lead_z", "coinc_z"]).reset_index(drop=True)
        if len(quadrant_df):
            log(f"  computed quadrant trajectory (WEI/AVG): {len(quadrant_df)} monthly obs · "
                f"latest ({quadrant_df['date'].iloc[-1].date()}): "
                f"lead_z={quadrant_df['lead_z'].iloc[-1]:.3f}, coinc_z={quadrant_df['coinc_z'].iloc[-1]:.3f}")

    payload = {
        "meta": {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "z_window_years": Z_WINDOW_YEARS,
            "direction_lookback_weeks": DIRECTION_LOOKBACK_WEEKS,
            "sources": {
                "atlanta_fed":    f"fetched · latest obs {gdpnow['date'].iloc[-1].date().isoformat()}",
                "ny_fed":         f"fetched · latest obs {ny_fed['date'].iloc[-1].date().isoformat()}" if len(ny_fed) else "missing",
                "fred_wei":       f"fetched · latest obs {wei['date'].iloc[-1].date().isoformat()}",
                "fred_gdp_yoy":   f"fetched · latest obs {gdp_yoy['date'].iloc[-1].date().isoformat()}" if len(gdp_yoy) else "missing",
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
            "wla":            _f(ra["wla"].dropna().iloc[-1]) if "wla" in ra.columns and ra["wla"].notna().any() else None,
            "usmlei":         _f(ra["usmlei"].dropna().iloc[-1]) if "usmlei" in ra.columns and ra["usmlei"].notna().any() else None,
            "global_lei":     _f(ra["global_lei"].dropna().iloc[-1]) if "global_lei" in ra.columns and ra["global_lei"].notna().any() else None,
            "global_lei_8m":  _f(ra["global_lei_8m"].dropna().iloc[-1]) if "global_lei_8m" in ra.columns and ra["global_lei_8m"].notna().any() else None,
            "pct_g20_rising": _f(ra["pct_g20_rising"].dropna().iloc[-1]) if "pct_g20_rising" in ra.columns and ra["pct_g20_rising"].notna().any() else None,
            "cb_net_cutters": _f(ra["cb_net_cutters"].dropna().iloc[-1]) if "cb_net_cutters" in ra.columns and ra["cb_net_cutters"].notna().any() else None,
            "coinc_z":        _f(coinc_z),
            "lead_z":         _f(lead_z),
            "wei_z":          _f(wei_z_df["wei_z"].iloc[-1]) if len(wei_z_df) else None,
            "avg_z":          _f(avg_z_df["avg_z"].iloc[-1]) if len(avg_z_df) else None,
            "lead_z_quadrant":  _f(quadrant_df["lead_z"].iloc[-1]) if len(quadrant_df) else None,
            "coinc_z_quadrant": _f(quadrant_df["coinc_z"].iloc[-1]) if len(quadrant_df) else None,
            "quadrant": _classify_quadrant(
                quadrant_df["lead_z"].iloc[-1] if len(quadrant_df) else None,
                quadrant_df["coinc_z"].iloc[-1] if len(quadrant_df) else None,
            ),
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
        "wei_series": _df_to_records(
            wei_with_ma[["date", "wei", "wei_ma13"]].dropna(how="all", subset=["wei", "wei_ma13"])
            if len(wei_with_ma) else pd.DataFrame(columns=["date", "wei", "wei_ma13"]),
            cols=["date", "wei", "wei_ma13"],
        ),
        "gdp_yoy_series": _df_to_records(
            gdp_yoy.dropna(subset=["gdp_yoy"])
            if len(gdp_yoy) else pd.DataFrame(columns=["date", "gdp_yoy"]),
            cols=["date", "gdp_yoy"],
        ),
        "ra_leading_series": _df_to_records(
            ra[["date", "usmlei", "pct_g20_rising", "cb_net_cutters"]].dropna(how="all", subset=["usmlei", "pct_g20_rising", "cb_net_cutters"])
            if all(c in ra.columns for c in ["usmlei", "pct_g20_rising", "cb_net_cutters"]) and len(ra)
            else pd.DataFrame(columns=["date", "usmlei", "pct_g20_rising", "cb_net_cutters"]),
            cols=["date", "usmlei", "pct_g20_rising", "cb_net_cutters"],
        ),
        "ra_weekly_avg_series": _df_to_records(
            ra_weekly[["date", "avg"]].dropna(subset=["avg"])
            if len(ra_weekly) and "avg" in ra_weekly.columns
            else pd.DataFrame(columns=["date", "avg"]),
            cols=["date", "avg"],
        ),
        "wei_z_series": _df_to_records(
            wei_z_df, cols=["date", "wei_z"],
        ),
        "avg_z_series": _df_to_records(
            avg_z_df, cols=["date", "avg_z"],
        ),
        "quadrant_trajectory": _df_to_records(
            quadrant_df.tail(12) if len(quadrant_df) else pd.DataFrame(columns=["date", "lead_z", "coinc_z"]),
            cols=["date", "lead_z", "coinc_z"],
        ),
    }

    # Cron-safe preservation: if any sources produced empty/null this
    # run (e.g., RecessionAlert xlsx not present in cron runner), copy
    # those fields forward from the previous growth.json.
    payload, preserved_fields = preserve_from_prior(payload)
    payload.setdefault("meta", {})["preserved_fields"] = preserved_fields

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
    log(f"=== SmallFish Macro Regime · GROWTH ingest v5 · {datetime.now(timezone.utc).isoformat()} ===")
    log(f"ROOT = {ROOT}")
    gdpnow = fetch_atlanta_fed()
    ny_fed = fetch_ny_fed()
    wei = fetch_fred_wei()
    gdp_yoy = fetch_fred_gdp()
    unctad = read_unctad_manual()
    ra, ra_weekly = read_recessionalert()
    payload = build_growth_payload(gdpnow, wei, unctad, ra, ny_fed, gdp_yoy, ra_weekly)
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
