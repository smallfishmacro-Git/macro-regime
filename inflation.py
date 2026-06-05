#!/usr/bin/env python3
# =============================================================================
#  inflation.py   ·   macro-regime data pipeline
#  Builds the U.S. Inflation Momentum & Impulse Index, an open FRED/yfinance
#  replication of the "MMM Inflation Momentum" dashboard, and writes
#  inflation.json in the exact schema the macro-regime INFLATION tab consumes.
#
#  Run locally / in GitHub Actions:
#     pip install fredapi pandas numpy yfinance
#     FRED_API_KEY=xxxxxxxx python inflation.py
#
#  Uses the SAME FRED_API_KEY secret your CSLMI / USHMI steps already use.
#  Never hard-code the key here.
#
#  This is an OPEN REPLICATION. The 13 inputs are reduced to a comparable
#  inflationary signal, each signal's 3-month momentum is standardized into an
#  impulse z, and the impulse z's are aggregated into a composite. Because the
#  aggregation/standardization is open (not the proprietary Pine weighting),
#  the live values will track the dashboard's *shape and regime* but will not
#  bit-match its exact figures — exactly like cslmi_employment.py / ushmi_
#  housing.py replicate (not reproduce) RecessionALERT. All calibration
#  constants below are clearly marked and safe to tune through deployed
#  iterations.
# =============================================================================
import os, json, sys
import numpy as np
import pandas as pd

try:
    from fredapi import Fred
except ImportError:
    sys.exit("Missing dependency: pip install fredapi")

# ---------------------------------------------------------------- CONFIG ----
FRED_API_KEY = os.environ.get("FRED_API_KEY", "").strip()
OUT_PATH     = os.environ.get("INFLATION_OUT", "data/inflation.json")
START        = "2003-01-01"   # 5Y5Y fwd (T5YIFR) begins 2003-01; the composite
                              # is anchored here so every expectations input is
                              # live from the first month.
EXPANDING_Z  = False          # False = full-sample z (conventional for a
                              # published MOMENTUM index). True = leak-free
                              # expanding z if you ever treat this as a signal.
CLIP_Z       = 3.0            # winsorize per-input impulse z at +/- this many
                              # sd before aggregating (tames single-series
                              # blow-ups like a breakeven spike).

# --- nowcast calibration (0-100). nowcast = blend of WHERE inflation sits
#     (level score) and the MOMENTUM (impulse score). Tune freely. ----------
NOWCAST_W_IMP   = 0.50        # weight on the impulse component
NOWCAST_IMP_K   = 20.0        # impulse_score = 50 + composite_z * K   (clip 0-100)
NOWCAST_LEVEL_K = 8.0         # level_score   = 50 + (basket_yoy - target) * K
NOWCAST_TARGET  = 2.0         # inflation target the level score centers on (%)

# --- regime bands on the composite impulse z (mirrors the tab's defaults) ---
BANDS = {"neutral_lo": -0.5, "neutral_hi": 0.5, "hot": 1.0, "cold": -1.0}

# --- ISM Prices Paid: ISM revoked FRED redistribution, so there is no free
#     national feed (same situation as NAHB in the housing pipeline). Two
#     ways to wire it, in priority order:
#       1) Drop a CSV at data/ism_prices.csv with rows  YYYY-MM,value
#          (the true 0-100 ISM Manufacturing Prices index, e.g. 70.5). Set
#          ISM_CSV to its path. This preserves the real level.
#       2) Enable the regional-Fed prices-paid proxy below (USE_ISM_PROXY=1).
#          Fully automated, but it is a diffusion proxy, NOT the ISM level.
#     If neither resolves, ISM is dropped and the composite runs on 12 inputs
#     (the tab + diffusion handle a variable input count gracefully).
ISM_CSV        = os.environ.get("ISM_CSV", "data/ism_prices.csv").strip()
USE_ISM_PROXY  = os.environ.get("USE_ISM_PROXY", "").strip() not in ("", "0", "false")
ISM_PROXY_FRED = ["PPCDFSA066MSFRBPHI",   # Philadelphia Fed mfg: prices paid (diffusion)
                  "PPCDISA066MSFRBNY"]    # NY Fed (Empire State) mfg: prices paid
                              # NOTE: confirm these IDs on FRED before enabling;
                              # the pipeline drops any that 404 and averages the
                              # rest. Proxy is OFF by default to avoid shipping
                              # an unverified series.

# --- broad commodity index (yfinance). The dashboard's "Commodities YoY" is a
#     commodity PRICE index, not a producer-price series, so it comes from
#     yfinance. We try tickers in order and use the first that returns data;
#     if all fail (or yfinance is unavailable) the component is dropped. ------
COMMOD_TICKERS = ["^SPGSCI", "^BCOM", "DBC"]   # S&P GSCI -> Bloomberg Cmdty -> DBC ETF

if not FRED_API_KEY:
    sys.exit("FRED_API_KEY not set. export FRED_API_KEY=... (same secret as the CSLMI/USHMI steps)")

fred = Fred(api_key=FRED_API_KEY)

# =============================================================================
#  THE 13 INPUTS
#  group  : EXPECTATIONS | PRICES | WAGES/RENT | COMMODITIES | SURVEY
#  fred   : FRED series id (or special handler for COMMOD / ISM)
#  unit   : "%" (rate / YoY) or "idx" (ISM diffusion index)
#  sigkind: how the raw FRED series becomes the inflationary SIGNAL
#             "rate" -> use the level as-is (already a %: breakevens, fwd)
#             "yoy"  -> 12m % change of the level (CPI/PCE/PPI/AHE/Rent/Oil/Cmdty)
#             "idx"  -> use the level as-is (ISM 0-100 diffusion)
#  chgkind: how chg3 / chg12 (shown in the breadth grid) are computed
#             "pct"  -> % change of the signal over 3 / 12 months (expectations)
#             "diff" -> simple difference of the signal (everything else;
#                       e.g. change in the YoY rate, in pp)
#  All inputs are sign-aligned so a RISE = MORE inflation (no inversion needed).
# =============================================================================
INPUTS = [
    {"id":"T5YIFR",  "name":"5Y5Y Fwd Inflation",  "fred":"T5YIFR",        "group":"EXPECTATIONS", "unit":"%",   "sigkind":"rate", "chgkind":"pct"},
    {"id":"T5YIE",   "name":"5Y Breakeven",         "fred":"T5YIE",         "group":"EXPECTATIONS", "unit":"%",   "sigkind":"rate", "chgkind":"pct"},
    {"id":"T10YIE",  "name":"10Y Breakeven",        "fred":"T10YIE",        "group":"EXPECTATIONS", "unit":"%",   "sigkind":"rate", "chgkind":"pct"},
    {"id":"CPI",     "name":"CPI YoY",              "fred":"CPIAUCSL",      "group":"PRICES",       "unit":"%",   "sigkind":"yoy",  "chgkind":"diff"},
    {"id":"CORECPI", "name":"Core CPI YoY",         "fred":"CPILFESL",      "group":"PRICES",       "unit":"%",   "sigkind":"yoy",  "chgkind":"diff"},
    {"id":"PCE",     "name":"PCE YoY",              "fred":"PCEPI",         "group":"PRICES",       "unit":"%",   "sigkind":"yoy",  "chgkind":"diff"},
    {"id":"COREPCE", "name":"Core PCE YoY",         "fred":"PCEPILFE",      "group":"PRICES",       "unit":"%",   "sigkind":"yoy",  "chgkind":"diff"},
    # PPI core. Default = Final Demand less Foods & Energy (the headline "core
    # PPI" most analysts quote). Swap to "WPSFD4131" for the narrower Finished
    # Goods Less Foods & Energy series if that is what your Pine source uses.
    {"id":"PPIXFE",  "name":"PPI ex Food & Energy", "fred":"WPSFD49116",    "group":"PRICES",       "unit":"%",   "sigkind":"yoy",  "chgkind":"diff"},
    {"id":"AHE",     "name":"Avg Hourly Earnings",  "fred":"CES0500000003", "group":"WAGES/RENT",   "unit":"%",   "sigkind":"yoy",  "chgkind":"diff"},
    {"id":"RENT",    "name":"CPI Rent (Primary)",   "fred":"CUSR0000SEHA",  "group":"WAGES/RENT",   "unit":"%",   "sigkind":"yoy",  "chgkind":"diff"},
    {"id":"OIL",     "name":"Oil (WTI) YoY",        "fred":"DCOILWTICO",    "group":"COMMODITIES",  "unit":"%",   "sigkind":"yoy",  "chgkind":"diff"},
    {"id":"COMMOD",  "name":"Commodities YoY",      "fred":"__COMMOD__",    "group":"COMMODITIES",  "unit":"%",   "sigkind":"yoy",  "chgkind":"diff"},
    {"id":"ISMPx",   "name":"ISM Prices Paid",      "fred":"__ISM__",       "group":"SURVEY",       "unit":"idx", "sigkind":"idx",  "chgkind":"diff"},
]

# ---------------------------------------------------------------- helpers ---
def monthly_last(series):
    s = series.copy(); s.index = pd.to_datetime(s.index)
    return s.resample("MS").last()

def yoy(s):
    return s.pct_change(12) * 100.0

def zscore(s):
    s = s.dropna()
    if EXPANDING_Z:
        mu = s.expanding(min_periods=24).mean(); sd = s.expanding(min_periods=24).std()
        return (s - mu) / sd
    sd = s.std()
    return (s - s.mean()) / sd if sd and not np.isnan(sd) else s * 0.0

def fred_monthly(series_id):
    return monthly_last(fred.get_series(series_id, observation_start=START))

def signal_from(raw, sigkind):
    """Reduce a monthly FRED level to a comparable inflationary signal."""
    if sigkind == "yoy":
        return yoy(raw)
    return raw            # "rate" and "idx" use the level directly

def chg_over(sig, n, chgkind):
    """chg3 / chg12 for the breadth grid (latest value)."""
    s = sig.dropna()
    if len(s) <= n:
        return None
    now, past = s.iloc[-1], s.iloc[-1 - n]
    if chgkind == "pct":
        return round(float((now / past - 1.0) * 100.0), 2) if past not in (0, None) else None
    return round(float(now - past), 2)

# -------------------------------------------------- special input fetchers ---
def fetch_commodities():
    """Broad commodity price index via yfinance; first ticker that works wins."""
    try:
        import yfinance as yf
    except Exception as e:
        print(f"  COMMOD: yfinance unavailable ({e}); dropping component")
        return None, None
    for tk in COMMOD_TICKERS:
        try:
            df = yf.download(tk, start=START, progress=False, auto_adjust=True)
            if df is None or df.empty:
                continue
            px = df["Close"]
            if isinstance(px, pd.DataFrame):     # multiindex guard
                px = px.iloc[:, 0]
            px = monthly_last(px)
            if px.dropna().shape[0] >= 24:
                print(f"  COMMOD: using {tk}")
                return px, tk
        except Exception as e:
            print(f"  COMMOD: {tk} failed ({e})")
    print("  COMMOD: all tickers failed; dropping component")
    return None, None

def fetch_ism():
    """ISM Prices Paid: CSV (true level) -> regional-Fed proxy -> drop."""
    # 1) manual CSV (preserves the real 0-100 ISM level)
    if ISM_CSV and os.path.exists(ISM_CSV):
        try:
            d = pd.read_csv(ISM_CSV, header=None, names=["d", "v"])
            d["d"] = pd.to_datetime(d["d"].astype(str).str.strip() + "-01", errors="coerce")
            s = d.dropna(subset=["d"]).set_index("d")["v"].sort_index().astype(float)
            s = s.resample("MS").last()
            if s.dropna().shape[0] >= 12:
                print(f"  ISM: using CSV {ISM_CSV} ({s.dropna().shape[0]} months, true ISM level)")
                return s, "ISM-PRICES (CSV)"
        except Exception as e:
            print(f"  ISM: CSV failed ({e})")
    # 2) regional-Fed prices-paid proxy (diffusion, not the ISM level)
    if USE_ISM_PROXY:
        cols = {}
        for fid in ISM_PROXY_FRED:
            try:
                cols[fid] = fred_monthly(fid)
                print(f"  ISM: proxy leg {fid} ok")
            except Exception as e:
                print(f"  ISM: proxy leg {fid} failed ({e})")
        if cols:
            proxy = pd.DataFrame(cols).mean(axis=1)
            return proxy, "ISM-PROXY (regional Fed)"
    print("  ISM: no source resolved; dropping component (composite uses 12 inputs)")
    return None, None

# --------------------------------------------------------- assemble index ---
print("Fetching inflation inputs ...")
sig_cols, imp_cols, meta_rows = {}, {}, []
fred_used = []

for c in INPUTS:
    try:
        if c["fred"] == "__COMMOD__":
            raw, tag = fetch_commodities()
            if raw is None:
                continue
            fred_used.append(tag)
        elif c["fred"] == "__ISM__":
            raw, tag = fetch_ism()
            if raw is None:
                continue
            fred_used.append(tag)
        else:
            raw = fred_monthly(c["fred"])
            fred_used.append(c["fred"])

        sig = signal_from(raw, c["sigkind"]).dropna()
        if sig.shape[0] < 18:
            print(f"  skip {c['id']}: only {sig.shape[0]} signal points")
            continue

        # per-input impulse = standardized 3-month momentum of the signal
        imp = zscore(sig.diff(3)).clip(-CLIP_Z, CLIP_Z)
        sig_cols[c["id"]] = sig
        imp_cols[c["id"]] = imp

        level  = round(float(sig.iloc[-1]), 2)
        chg3   = chg_over(sig, 3,  c["chgkind"])
        chg12  = chg_over(sig, 12, c["chgkind"])
        impv   = round(float(imp.dropna().iloc[-1]), 2) if imp.dropna().shape[0] else 0.0
        accel  = 1 if (chg3 is not None and chg12 is not None and chg3 > chg12) else -1
        since  = int(sig.index.min().year)

        meta_rows.append({
            "id": c["id"], "name": c["name"], "fred": c["fred"], "unit": c["unit"],
            "level": level, "chg3": chg3 if chg3 is not None else 0.0,
            "chg12": chg12 if chg12 is not None else 0.0,
            "impulse": impv, "accel": accel, "group": c["group"], "since": since,
        })
        print(f"  ok  {c['id']:<8} level {level:>8} impulse {impv:>6} accel {accel:+d}  since {since}")
    except Exception as e:
        print(f"  FAIL {c['id']}: {e}  (dropping)")

if not imp_cols:
    sys.exit("No inputs resolved — aborting (check FRED_API_KEY / network).")

# align all per-input impulse z's on a common monthly grid -------------------
IMP = pd.DataFrame(imp_cols).sort_index().loc[START:]
n_inputs = IMP.shape[1]
print(f"Inputs in composite: {n_inputs}")

# composite impulse z: winsorized cross-sectional mean, then standardized so
# the series reads as "inflation momentum vs its own history" (centers on 0,
# ~+/-1 = a one-sigma push). df = breadth of POSITIVE per-input impulses.
composite_raw = IMP.mean(axis=1, skipna=True)
composite_z   = zscore(composite_raw).reindex(composite_raw.index)
diffusion     = (IMP > 0).sum(axis=1) / IMP.notna().sum(axis=1) * 100.0

# realized-price levels for the chart benchmarks + nowcast level score -------
def yoy_level(series_id):
    try:
        return yoy(fred_monthly(series_id))
    except Exception:
        return pd.Series(dtype=float)

cpi_yoy   = yoy_level("CPIAUCSL")
corepce   = yoy_level("PCEPILFE")
basket    = pd.concat([
                yoy_level("CPIAUCSL"), yoy_level("CPILFESL"),
                yoy_level("PCEPI"),    yoy_level("PCEPILFE"),
            ], axis=1).mean(axis=1)

# nowcast 0-100 ---------------------------------------------------------------
imp_score   = (50.0 + composite_z * NOWCAST_IMP_K).clip(0, 100)
level_score = (50.0 + (basket - NOWCAST_TARGET) * NOWCAST_LEVEL_K).clip(0, 100)
nowcast     = (NOWCAST_W_IMP * imp_score
               + (1 - NOWCAST_W_IMP) * level_score.reindex(imp_score.index))

# NBER recession flag ---------------------------------------------------------
try:
    usrec = monthly_last(fred.get_series("USREC", observation_start=START)).fillna(0)
except Exception:
    usrec = pd.Series(0, index=composite_z.index)

# ----------------------------------------------------------- output rows -----
idx = composite_z.dropna().index
df = pd.DataFrame({
    "c":    composite_z.reindex(idx).round(3),
    "nc":   nowcast.reindex(idx).round(2),
    "cpi":  cpi_yoy.reindex(idx).round(2),
    "core": corepce.reindex(idx).round(2),
    "df":   diffusion.reindex(idx).round(1),
    "r":    usrec.reindex(idx).fillna(0).astype(int),
}).dropna(subset=["c"])

df = df.astype(object).where(pd.notna(df), None)   # NaN-safe JSON
series = [{"d": ts.strftime("%Y-%m"), **row} for ts, row in df.iterrows()]

# top drivers of the latest change in composite impulse ----------------------
drivers = []
if IMP.shape[0] >= 2:
    delta = (IMP.iloc[-1] - IMP.iloc[-2]) / float(n_inputs)   # contribution to Δ composite_raw
    name_by_id = {c["id"]: c["name"] for c in INPUTS}
    top = delta.reindex(delta.abs().sort_values(ascending=False).index).head(3)
    drivers = [{"name": name_by_id.get(k, k), "pts": round(float(v), 2)}
               for k, v in top.items() if pd.notna(v)]

# ------------------------------------------------------------- assemble ------
last = series[-1]
out = {
    "meta": {
        "source": "FRED_LIVE",
        "title": "U.S. Inflation Momentum & Impulse Index",
        "subtitle": ("13-input inflation-impulse composite \u00b7 expectations + prices "
                     "+ wages/rent + commodities + survey"),
        "as_of": last["d"],
        "published": pd.Timestamp.now("UTC").strftime("%Y-%m-%d"),
        "n_inputs": int(n_inputs),
        "scale_note": (f"per-input impulse = z(signal.diff(3)) clipped +/-{CLIP_Z}; "
                       f"composite = z(mean impulse); expanding_z={EXPANDING_Z}; "
                       f"diffusion = share of positive impulses"),
        "fred_series": fred_used + ["USREC"],
    },
    "series": series,
    "components": meta_rows,
    "drivers": drivers,
    "bands": BANDS,
}

os.makedirs(os.path.dirname(OUT_PATH) or ".", exist_ok=True)
with open(OUT_PATH, "w") as f:
    json.dump(out, f, separators=(",", ":"), allow_nan=False)

rising = int(round(last["df"] / 100.0 * n_inputs)) if last["df"] is not None else 0
print(f"\nWrote {OUT_PATH}  ·  {len(series)} months  ·  {n_inputs} live inputs")
print(f"Latest {last['d']}: impulse-z={last['c']}  nowcast={last['nc']}  "
      f"diffusion={last['df']}% ({rising}/{n_inputs})  CPI={last['cpi']}  corePCE={last['core']}")
