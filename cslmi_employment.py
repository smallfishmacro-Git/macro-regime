#!/usr/bin/env python3
# =============================================================================
#  cslmi_employment.py   ·   market-dashboard pipeline
#  Builds the U.S. Cyclically Sensitive Labor Market Index (CSLMI), an open
#  FRED replication of the RecessionALERT CSLMI, and writes employment.json
#  in the exact schema the macro-regime EMPLOYMENT tab consumes.
#
#  Run locally / in GitHub Actions:
#     pip install fredapi pandas numpy
#     FRED_API_KEY=xxxxxxxx python cslmi_employment.py
#
#  IMPORTANT — ROTATE YOUR FRED KEY: the key committed in the uploaded
#  notebook (5cce...406) is now public. Generate a fresh one and store it as
#  a GitHub Actions secret named FRED_API_KEY. Never hard-code it here.
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
OUT_PATH     = os.environ.get("CSLMI_OUT", "data/employment.json")
START        = "1965-01-01"
EXPANDING_Z  = False   # True = leak-free expanding z-score (no lookahead);
                       # False = full-sample z (conventional for a published
                       # historical index). Labor MOMENTUM index, not a
                       # tradeable signal, so full-sample is the default.
SCALE        = 16.0    # composite = mean(component z) * SCALE.
                       # Calibrated so the 2020 trough lands near -42 and the
                       # normal range is roughly +/-15, mirroring the report.
INCLUDE_U52  = True    # build the state-diffusion component (51 FRED calls)

if not FRED_API_KEY:
    sys.exit("FRED_API_KEY not set. export FRED_API_KEY=... (and rotate the old one)")

fred = Fred(api_key=FRED_API_KEY)

# The 8 CSLMI components.  invert=True for series where a RISE means a WEAKER
# labor market (so they are sign-flipped before averaging).
COMPONENTS = [
    {"id":"AWHMAN",      "name":"Avg Weekly Hours, Mfg",            "fred":"AWHMAN",      "invert":False, "freq":"M"},
    {"id":"AWOTMAN",     "name":"Avg Weekly Overtime Hours, Mfg",   "fred":"AWOTMAN",     "invert":False, "freq":"M"},
    {"id":"LNS12032194", "name":"Part-Time for Economic Reasons",   "fred":"LNS12032194", "invert":True,  "freq":"M"},
    {"id":"ICSA",        "name":"Initial Jobless Claims",           "fred":"ICSA",        "invert":True,  "freq":"W"},
    {"id":"JTS3000HIL",  "name":"JOLTS Hires, Mfg",                 "fred":"JTS3000HIL",  "invert":False, "freq":"M"},
    {"id":"JTS3000JOL",  "name":"JOLTS Job Openings, Mfg",          "fred":"JTS3000JOL",  "invert":False, "freq":"M"},
    {"id":"TEMPHELPS",   "name":"Temporary Help Services",          "fred":"TEMPHELPS",   "invert":False, "freq":"M"},
    # U52 (net % of states with falling unemployment) is injected separately.
]

STATES = ("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI "
          "MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT "
          "VT VA WA WV WI WY DC").split()

# ---------------------------------------------------------------- helpers ---
def monthly(series, how="last"):
    """Resample any FRED series to month-start."""
    s = series.copy()
    s.index = pd.to_datetime(s.index)
    return s.resample("MS").mean() if how == "mean" else s.resample("MS").last()

def yoy(s):
    return s.pct_change(12) * 100.0

def zscore(s):
    if EXPANDING_Z:
        mu = s.expanding(min_periods=24).mean()
        sd = s.expanding(min_periods=24).std()
        return (s - mu) / sd
    return (s - s.mean()) / s.std()

def fetch(series_id):
    return fred.get_series(series_id, observation_start=START)

# ---------------------------------------------------------- build U52 -------
def build_u52():
    """Net % of states with falling unemployment, linearly de-trended.
       Higher = more states improving = expansionary."""
    cols = {}
    for ab in STATES:
        try:
            ur = monthly(fetch(ab + "UR"), "last")
            cols[ab] = ur
        except Exception as e:
            print(f"  [U52] skip {ab}: {e}")
    if len(cols) < 20:
        raise RuntimeError("too few state series for U52")
    ur = pd.DataFrame(cols)
    # falling = UR lower than 3 months ago
    chg = ur - ur.shift(3)
    falling = (chg < 0).sum(axis=1)
    rising  = (chg > 0).sum(axis=1)
    valid   = (chg.notna()).sum(axis=1).replace(0, np.nan)
    net = (falling - rising) / valid * 100.0     # net % falling
    net = net.dropna()
    # linearly de-trend against long-term regression mean (per the report)
    x = np.arange(len(net))
    b1, b0 = np.polyfit(x, net.values, 1)
    detr = pd.Series(net.values - (b0 + b1 * x), index=net.index)
    print(f"  [U52] built from {len(cols)} states, {len(detr)} months")
    return detr

# --------------------------------------------------------- assemble index ---
print("Fetching components from FRED ...")
zcols, meta_rows, since = {}, [], {}

for c in COMPONENTS:
    try:
        raw = monthly(fetch(c["fred"]), "mean" if c["freq"] == "W" else "last")
        g = yoy(raw)
        if c["invert"]:
            g = -g
        z = zscore(g.dropna())
        zcols[c["id"]] = z
        first = g.dropna().index.min()
        since[c["id"]] = int(first.year) if first is not None else None
        meta_rows.append({**{k: c[k] for k in ("id", "name", "fred", "invert")},
                          "yoy": None, "z": None, "since": since[c["id"]]})
        print(f"  ok  {c['id']:<12} {len(z.dropna())} pts, since {since[c['id']]}")
    except Exception as e:
        print(f"  FAIL {c['id']}: {e}  (dropping)")

if INCLUDE_U52:
    try:
        u52 = build_u52()                      # already a de-trended level
        zcols["U52"] = zscore(u52)
        since["U52"] = int(u52.index.min().year)
        meta_rows.insert(4, {"id":"U52","name":"Net % States Falling Unemployment",
                             "fred":"STATE-DIFFUSION","invert":False,
                             "yoy":None,"z":None,"since":since["U52"]})
    except Exception as e:
        print(f"  FAIL U52: {e}  (continuing with available components)")

# align z-scores on a common monthly grid
Z = pd.DataFrame(zcols).sort_index()
Z = Z.loc[START:]
n_comp = Z.shape[1]
print(f"Components in composite: {n_comp}")

# composite = mean of available component z-scores * SCALE
composite = Z.mean(axis=1, skipna=True) * SCALE
diffusion = (Z < 0).sum(axis=1) / Z.notna().sum(axis=1) * 100.0
composite = composite.dropna()
diffusion = diffusion.reindex(composite.index)

# ------------------------------------------------------------ benchmarks ----
unrate = monthly(fetch("UNRATE"), "last")
nfp    = yoy(monthly(fetch("PAYEMS"), "last"))
usrec  = monthly(fetch("USREC"), "last").fillna(0)

# ------------------------------------------------- recession probability ----
def recession_within(usrec_m, horizon=8):
    """1 if a recession month occurs within the next `horizon` months.
    Tail months whose forward window isn't fully observed are left NaN
    (unknowable) so the logistic fit never trains on future data we
    don't have. dropna() downstream removes them from the fit."""
    arr = usrec_m.values.astype(float)
    out = np.full(len(arr), np.nan)
    for i in range(len(arr)):
        seg = arr[i+1:i+1+horizon]
        if seg.size and seg.max() == 1:
            out[i] = 1.0            # recession seen in window -> definitive
        elif seg.size == horizon:
            out[i] = 0.0            # full window observed, no recession
        # else: partial window, no recession seen -> leave NaN (unknown)
    return pd.Series(out, index=usrec_m.index)

def fit_logistic(x, y, iters=50):
    """Tiny Newton-Raphson logistic regression (numpy only)."""
    X = np.column_stack([np.ones_like(x), x])
    w = np.zeros(2)
    for _ in range(iters):
        p = 1 / (1 + np.exp(-(X @ w)))
        W = np.clip(p * (1 - p), 1e-6, None)
        grad = X.T @ (p - y)
        H = (X * W[:, None]).T @ X + 1e-6 * np.eye(2)
        w -= np.linalg.solve(H, grad)
    return w

target = recession_within(usrec, 8).reindex(composite.index)
fit_df = pd.concat([composite.rename("c"), target.rename("y")], axis=1).dropna()
w = fit_logistic(fit_df["c"].values, fit_df["y"].values)
prob = (1 / (1 + np.exp(-(w[0] + w[1] * composite)))) * 100.0
prob_avg = (prob + diffusion) / 2.0
print(f"Logistic fit: prob = sigmoid({w[0]:.3f} + {w[1]:.3f}*CSLMI)")

# ----------------------------------------------------------- summation ------
summation = composite.cumsum()
summation = summation - summation.min() + 40.0    # positive display offset

# --------------------------------------------------- assemble output rows ---
df = pd.DataFrame({
    "c":  composite.round(2),
    "s":  summation.round(1),
    "df": diffusion.round(2),
    "p":  prob.round(2),
    "pa": prob_avg.round(2),
    "u":  unrate.reindex(composite.index).round(1),
    "n":  nfp.reindex(composite.index).round(2),
    "r":  usrec.reindex(composite.index).fillna(0).astype(int),
}).dropna(subset=["c"])

# NaN-safe JSON (json.dumps cannot serialise NaN)
df = df.astype(object).where(pd.notna(df), None)
series = [{"d": ts.strftime("%Y-%m"), **row} for ts, row in df.iterrows()]

# latest snapshot for each component (yoy + z)
for m in meta_rows:
    cid = m["id"]
    if cid in Z.columns:
        zlast = Z[cid].dropna()
        m["z"] = round(float(zlast.iloc[-1]), 2) if len(zlast) else None
    m["since"] = since.get(cid)
# recompute latest yoy for display (re-fetch cheaply from Z is z, not yoy) ----
# We kept yoy implicitly; re-derive a readable latest %Δ from the raw series:
for m in meta_rows:
    if m["fred"] in ("STATE-DIFFUSION",):
        m["yoy"] = round(float(u52.iloc[-1]), 2) if INCLUDE_U52 and "u52" in dir() else None
        continue
    try:
        raw = monthly(fetch(m["fred"]), "mean" if m["fred"] == "ICSA" else "last")
        g = yoy(raw).dropna()
        v = float(g.iloc[-1])
        m["yoy"] = round(-v if m["invert"] else v, 2) if not m["invert"] else round(v, 2)
        # NOTE: display the RAW yoy (pre-invert) so the % reads naturally;
        # sign of the contribution is carried by z.
        m["yoy"] = round(v, 2)
    except Exception:
        m["yoy"] = None

th = {"soft_landing_upper": 0.0, "soft_landing_lower": -15.0, "recession_floor": -22.0}
last = series[-1]
out = {
    "meta": {
        "source": "FRED_LIVE",
        "title": "U.S. Cyclically Sensitive Labor Market Index",
        "subtitle": "8-component cyclical labor-momentum index · FRED replication of RecessionALERT CSLMI",
        "as_of": last["d"],
        "published": pd.Timestamp.utcnow().strftime("%Y-%m-%d"),
        "n_components": int(n_comp),
        "scale_note": f"composite = mean(component z) * {SCALE}; expanding_z={EXPANDING_Z}",
        "thresholds": th,
        "fred_series": [c["fred"] for c in COMPONENTS] + (["STATE-DIFFUSION"] if "U52" in Z.columns else []) + ["UNRATE","PAYEMS","USREC"],
    },
    "series": series,
    "components": meta_rows,
    "thresholds": th,
}

os.makedirs(os.path.dirname(OUT_PATH) or ".", exist_ok=True)
with open(OUT_PATH, "w") as f:
    json.dump(out, f, separators=(",", ":"), allow_nan=False)

print(f"\nWrote {OUT_PATH}  ·  {len(series)} months  ·  {n_comp} components")
print(f"Latest {last['d']}: CSLMI={last['c']}  diffusion={last['df']}%  "
      f"prob={last['p']}%  unrate={last['u']}%")
