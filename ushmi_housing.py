#!/usr/bin/env python3
# =============================================================================
#  ushmi_housing.py   ·   macro-regime data pipeline
#  Builds the U.S. Housing Market Index (USHMI), an open FRED replication of the
#  RecessionALERT USHMI, and writes housing.json in the exact schema the
#  macro-regime HOUSING tab consumes.
#
#  Run locally / in GitHub Actions:
#     pip install fredapi pandas numpy
#     FRED_API_KEY=xxxxxxxx python ushmi_housing.py
#
#  Uses the SAME FRED_API_KEY secret your CSLMI employment step already uses.
#  Never hard-code the key here.
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
OUT_PATH     = os.environ.get("USHMI_OUT", "data/housing.json")
START        = "1960-01-01"
EXPANDING_Z  = False    # full-sample z (published historical index). Housing
                        # MOMENTUM index, not a tradeable signal.
SCALE        = 17.0     # composite = mean(component z) * SCALE. Calibrated so
                        # the 2008/2020 troughs land near -45..-50 and the
                        # normal range is roughly +/-20, mirroring the report.
REC_HORIZON  = 6        # "probability of recession within N months" (PDF: 6).
                        # The index itself leads recession by ~14m on average.

if not FRED_API_KEY:
    sys.exit("FRED_API_KEY not set. export FRED_API_KEY=... (same secret as the CSLMI step)")

fred = Fred(api_key=FRED_API_KEY)

# The USHMI components, in the report's chronological order:
#   permits -> starts -> completions -> supply -> new & existing sales,
#   plus builder & buyer sentiment.
# invert=True for a series where a RISE means a WEAKER housing market.
# lead = the report's published typical lead vs the business cycle (months);
#        negative = lags.  most_leading flags the two that form USHMI-Leading.
COMPONENTS = [
    {"id":"PERMIT",       "name":"Building Permits",              "fred":"PERMIT",        "invert":False, "freq":"M", "lead":17, "tag":"LEADS",      "most_leading":False},
    {"id":"HOUST",        "name":"Housing Starts",                "fred":"HOUST",         "invert":False, "freq":"M", "lead":14, "tag":"LEADS",      "most_leading":False},
    {"id":"MSACSR",       "name":"Monthly Supply of New Houses",  "fred":"MSACSR",        "invert":True,  "freq":"M", "lead":18, "tag":"LEADS",      "most_leading":True },
    {"id":"HSN1F",        "name":"New One-Family Houses Sold",    "fred":"HSN1F",         "invert":False, "freq":"M", "lead":10, "tag":"LEADS",      "most_leading":False},
    {"id":"COMPUTSA",     "name":"Housing Completions",           "fred":"COMPUTSA",      "invert":False, "freq":"M", "lead":-9, "tag":"LAGS",       "most_leading":False},
    {"id":"EXHOSLUSM495S","name":"Existing Home Sales (NAR)",     "fred":"EXHOSLUSM495S", "invert":False, "freq":"M", "lead":2,  "tag":"COINCIDENT", "most_leading":False},
    # Buyer-sentiment leg. The report uses Univ. Michigan "buying conditions
    # for houses" (not free on FRED). UMCSENT is the same survey provider and
    # still updates monthly, so it is the public proxy. Fannie Mae's housing-
    # specific HPSI (FMNHSHPSIUS) is the closer concept but FRED discontinued
    # it in 2025 — swap it in here if you obtain a maintained feed.
    {"id":"UMCSENT",      "name":"Univ. Michigan Sentiment (proxy)","fred":"UMCSENT",     "invert":False, "freq":"M", "lead":26, "tag":"LEADS",      "most_leading":True },
]

# NAHB/Wells Fargo HMI is a *core* USHMI component but has NO free FRED feed
# (NAHB licensing). It is surfaced in the tab as a placeholder. To wire it in,
# drop a CSV at data/nahb.csv with rows `YYYY-MM,value` and set USE_NAHB_CSV.
NAHB_META = {"id":"NAHB","name":"NAHB / Wells Fargo HMI","fred":"NAHBHMI","invert":False,
             "lead":15,"tag":"LEADS","since":1985}
USE_NAHB_CSV = os.environ.get("NAHB_CSV", "").strip()   # optional path to a CSV

# ---------------------------------------------------------------- helpers ---
def monthly(series, how="last"):
    s = series.copy(); s.index = pd.to_datetime(s.index)
    return s.resample("MS").mean() if how == "mean" else s.resample("MS").last()

def yoy(s):
    return s.pct_change(12) * 100.0

def zscore(s):
    if EXPANDING_Z:
        mu = s.expanding(min_periods=24).mean(); sd = s.expanding(min_periods=24).std()
        return (s - mu) / sd
    return (s - s.mean()) / s.std()

def fetch(series_id):
    return fred.get_series(series_id, observation_start=START)

# --------------------------------------------------------- assemble index ---
print("Fetching housing components from FRED ...")
zcols, lead_cols, meta_rows, since, latest_yoy = {}, {}, [], {}, {}

for c in COMPONENTS:
    try:
        raw = monthly(fetch(c["fred"]), "last")
        g   = yoy(raw)
        sig = -g if c["invert"] else g          # sign-aligned growth
        z   = zscore(sig.dropna())
        zcols[c["id"]] = z
        if c["most_leading"]:
            lead_cols[c["id"]] = z
        first = g.dropna().index.min()
        since[c["id"]] = int(first.year) if first is not None else None
        latest_yoy[c["id"]] = round(float(g.dropna().iloc[-1]), 2) if len(g.dropna()) else None
        meta_rows.append({**{k: c[k] for k in ("id","name","fred","invert","lead","tag")},
                          "yoy": latest_yoy[c["id"]], "z": None,
                          "since": since[c["id"]], "live": True})
        print(f"  ok  {c['id']:<14} {len(z.dropna())} pts, since {since[c['id']]}, lead {c['lead']:>3}m")
    except Exception as e:
        print(f"  FAIL {c['id']}: {e}  (dropping)")

# optional NAHB from a user-supplied CSV (no free FRED feed) -----------------
nahb_live = False
if USE_NAHB_CSV and os.path.exists(USE_NAHB_CSV):
    try:
        nahb = pd.read_csv(USE_NAHB_CSV, header=None, names=["d","v"])
        nahb["d"] = pd.to_datetime(nahb["d"] + "-01")
        ns = nahb.set_index("d")["v"].sort_index()
        nz = zscore(yoy(ns).dropna())
        zcols["NAHB"] = nz
        since["NAHB"] = int(ns.index.min().year)
        latest_yoy["NAHB"] = round(float(yoy(ns).dropna().iloc[-1]), 2)
        meta_rows.append({**{k: NAHB_META[k] for k in ("id","name","fred","invert","lead","tag")},
                          "yoy": latest_yoy["NAHB"], "z": None, "since": since["NAHB"], "live": True})
        nahb_live = True
        print(f"  ok  NAHB (CSV)     {len(nz.dropna())} pts, since {since['NAHB']}")
    except Exception as e:
        print(f"  NAHB CSV failed ({e}); showing placeholder")
if not nahb_live:
    meta_rows.append({**{k: NAHB_META[k] for k in ("id","name","fred","invert","lead","tag","since")},
                      "yoy": None, "z": None, "live": False})

# align z-scores on a common monthly grid ------------------------------------
Z = pd.DataFrame(zcols).sort_index().loc[START:]
n_comp = Z.shape[1]
print(f"Components in composite: {n_comp}")

composite = (Z.mean(axis=1, skipna=True) * SCALE).dropna()
breadth   = ((Z < 0).sum(axis=1) / Z.notna().sum(axis=1) * 100.0).reindex(composite.index)

# USHMI-Leading = mean z of the two most-leading components -------------------
if lead_cols:
    L = pd.DataFrame(lead_cols).sort_index()
    leading = (L.mean(axis=1, skipna=True) * SCALE).reindex(composite.index)
else:
    leading = pd.Series(np.nan, index=composite.index)

# existing-home-sales YoY benchmark (lagging confirm) ------------------------
try:
    ehs = yoy(monthly(fetch("EXHOSLUSM495S"), "last")).reindex(composite.index)
except Exception:
    ehs = pd.Series(np.nan, index=composite.index)

# ------------------------------------------------------------ benchmarks ----
usrec = monthly(fetch("USREC"), "last").fillna(0)

# ------------------------------------------------- recession probability ----
def recession_within(usrec_m, horizon):
    """1 if a recession month occurs within the next `horizon` months. Tail
    months whose forward window isn't fully observed are left NaN so the
    logistic fit never trains on data we don't have."""
    arr = usrec_m.values.astype(float)
    out = np.full(len(arr), np.nan)
    for i in range(len(arr)):
        seg = arr[i+1:i+1+horizon]
        if seg.size and seg.max() == 1:   out[i] = 1.0
        elif seg.size == horizon:         out[i] = 0.0
    return pd.Series(out, index=usrec_m.index)

def fit_logistic(x, y, iters=60):
    X = np.column_stack([np.ones_like(x), x]); w = np.zeros(2)
    for _ in range(iters):
        p = 1/(1+np.exp(-(X @ w)))
        W = np.clip(p*(1-p), 1e-6, None)
        grad = X.T @ (p - y)
        H = (X*W[:,None]).T @ X + 1e-6*np.eye(2)
        w -= np.linalg.solve(H, grad)
    return w

target = recession_within(usrec, REC_HORIZON).reindex(composite.index)
fit_df = pd.concat([composite.rename("c"), target.rename("y")], axis=1).dropna()
w = fit_logistic(fit_df["c"].values, fit_df["y"].values)
prob = (1/(1+np.exp(-(w[0] + w[1]*composite)))) * 100.0
prob_avg = (prob + breadth) / 2.0
print(f"Logistic fit: prob(rec<= {REC_HORIZON}m) = sigmoid({w[0]:.3f} + {w[1]:.3f}*USHMI)")

# ----------------------------------------------------------- summation ------
summation = composite.cumsum()
summation = summation - summation.min() + 800.0    # positive band echoing PDF

# --------------------------------------------------- assemble output rows ---
df = pd.DataFrame({
    "c":   composite.round(2),
    "s":   summation.round(1),
    "df":  breadth.round(1),
    "p":   prob.round(1),
    "pa":  prob_avg.round(1),
    "lead":leading.round(2),
    "ehs": ehs.round(2),
    "r":   usrec.reindex(composite.index).fillna(0).astype(int),
}).dropna(subset=["c"])

df = df.astype(object).where(pd.notna(df), None)   # NaN-safe JSON
series = [{"d": ts.strftime("%Y-%m"), **row} for ts, row in df.iterrows()]

# latest z per component (for the breadth grid contribution bars) ------------
for m in meta_rows:
    cid = m["id"]
    if cid in Z.columns:
        zl = Z[cid].dropna()
        m["z"] = round(float(zl.iloc[-1]), 2) if len(zl) else None

th = {"soft_landing_upper": 0.0, "soft_landing_lower": -12.0, "recession_floor": -25.0}
last = series[-1]
out = {
    "meta": {
        "source": "FRED_LIVE",
        "title": "U.S. Housing Market Index",
        "subtitle": "8-component cyclical housing-momentum index · FRED replication of RecessionALERT USHMI",
        "as_of": last["d"],
        "published": pd.Timestamp.now("UTC").strftime("%Y-%m-%d"),
        "n_components": int(n_comp),
        "rec_horizon_m": REC_HORIZON,
        "scale_note": f"composite = mean(component z) * {SCALE}; expanding_z={EXPANDING_Z}; rec_horizon={REC_HORIZON}m; avg lead ~14m",
        "thresholds": th,
        "fred_series": [c["fred"] for c in COMPONENTS] + (["NAHB-CSV"] if nahb_live else []) + ["USREC"],
    },
    "series": series,
    "components": meta_rows,
    "thresholds": th,
}

os.makedirs(os.path.dirname(OUT_PATH) or ".", exist_ok=True)
with open(OUT_PATH, "w") as f:
    json.dump(out, f, separators=(",", ":"), allow_nan=False)

print(f"\nWrote {OUT_PATH}  ·  {len(series)} months  ·  {n_comp} live components"
      f"{' + NAHB(CSV)' if nahb_live else ' (NAHB placeholder)'}")
print(f"Latest {last['d']}: USHMI={last['c']}  leading={last['lead']}  "
      f"breadth={last['df']}%  prob{REC_HORIZON}m={last['p']}%")
