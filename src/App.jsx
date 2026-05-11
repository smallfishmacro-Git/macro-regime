import React, { useEffect, useMemo, useState } from "react";
import {
  ComposedChart,
  Bar,
  Line,
  LineChart,
  AreaChart,
  Area,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  ReferenceArea,
} from "recharts";

// ========================================================================
// DESIGN TOKENS — aligned to smallfish-rates-regime
// ========================================================================
const C = {
  bg: "#08090c",
  panel: "#0d0f14",
  panelSoft: "#08090c",         // inner-tile bg = page bg (darker than panel)
  panelEdge: "#1a1d26",
  panelEdgeStrong: "#1a1d26",   // single-tone border, matches rates-regime
  grid: "#1a1d26",
  text: "#c8cad0",
  textDim: "#5a5e6a",
  textMute: "#3a3d46",
  amber: "#f0b800",
  amberFaint: "rgba(240,184,0,0.08)",
  green: "#00c853",
  red: "#ff5252",
  cyan: "#00bcd4",
  magenta: "#f43f5e",
  white: "#ffffff",
  // GDPNow component palette (matches Atlanta Fed convention)
  pceGoods: "#3b82f6",
  pceServices: "#ea580c",
  fixedInv: "#a855f7",
  govt: "#eab308",
  netExports: "#06b6d4",
  inventories: "#f97316",
};

const FONT_MONO = `"JetBrains Mono", "Fira Code", ui-monospace, Menlo, monospace`;

// ========================================================================
// DETERMINISTIC PRNG + DATA GENERATORS
// ========================================================================
const rng = (seed) => {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
};

// US Atlanta Fed GDPNow with component contributions (last ~12 months)
const genGDPNow = () => {
  const r = rng(2026);
  const start = new Date(2025, 4, 1);
  const data = [];
  let pceG = 0.85, pceS = 1.25, fix = 0.30, gov = 0.36, nx = 0.18, inv = -0.05;
  for (let i = 0; i < 250; i++) {
    pceG += (r() - 0.5) * 0.05; pceG = Math.max(0.4, Math.min(1.1, pceG));
    pceS += (r() - 0.5) * 0.04; pceS = Math.max(0.95, Math.min(1.55, pceS));
    fix  += (r() - 0.5) * 0.06; fix  = Math.max(0.05, Math.min(0.55, fix));
    gov  += (r() - 0.5) * 0.02; gov  = Math.max(0.30, Math.min(0.42, gov));
    nx   += (r() - 0.5) * 0.09; nx   = Math.max(-0.40, Math.min(0.45, nx));
    inv  += (r() - 0.5) * 0.07; inv  = Math.max(-0.30, Math.min(0.25, inv));
    const total = pceG + pceS + fix + gov + nx + inv;
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    data.push({
      date: d,
      label: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      pceGoods: +pceG.toFixed(3),
      pceServices: +pceS.toFixed(3),
      fixedInv: +fix.toFixed(3),
      govt: +gov.toFixed(3),
      netExports: +nx.toFixed(3),
      inventories: +inv.toFixed(3),
      total: +total.toFixed(3),
    });
  }
  return data;
};

// Composite z-scores over time
const genCompZ = () => {
  const r = rng(11);
  const start = new Date(2021, 0, 4);
  const data = [];
  let coinc = 0.4, lead = 0.6;
  for (let i = 0; i < 270; i++) {
    const phase = i / 270;
    const ct = phase<0.15?1.4:phase<0.30?0.6:phase<0.45?-0.8:phase<0.55?-1.6:phase<0.72?0.2:phase<0.88?1.0:0.5;
    const lp = Math.min(1, phase + 0.10);
    const lt = lp<0.15?1.6:lp<0.30?0.2:lp<0.45?-1.2:lp<0.55?-1.8:lp<0.72?0.6:lp<0.88?1.2:0.3;
    coinc += ((ct - coinc) * 0.08) + (r() - 0.5) * 0.18;
    lead  += ((lt - lead)  * 0.10) + (r() - 0.5) * 0.22;
    const d = new Date(start); d.setDate(d.getDate() + i * 7);
    data.push({
      date: d,
      label: d.toLocaleDateString("en-US", { month: "short", year: "2-digit" }),
      coinc: +coinc.toFixed(2),
      lead: +lead.toFixed(2),
      composite: +((coinc + lead) / 2).toFixed(2),
    });
  }
  return data;
};

const classifyRegime = (coincZ, leadZ, prevLead) => {
  const level = coincZ > 0.5 ? "HIGH" : coincZ < -0.5 ? "LOW" : "NORMAL";
  const direction = leadZ > prevLead ? "ACCELERATING" : "SLOWING";
  return { level, direction };
};

const HEDGE_MAP = {
  LOW_SLOWING:         { ratio: 70, posture: "Long puts, VIX calls, delta-hedged", color: "red" },
  LOW_ACCELERATING:    { ratio: 25, posture: "Roll off puts, beta back on",        color: "amber" },
  NORMAL_SLOWING:      { ratio: 45, posture: "Building put position",              color: "amber" },
  NORMAL_ACCELERATING: { ratio: 20, posture: "Light hedge",                        color: "green" },
  HIGH_SLOWING:        { ratio: 40, posture: "Initiating puts (cheap entry)",      color: "amber" },
  HIGH_ACCELERATING:   { ratio: 10, posture: "Minimal hedge, sell vol",            color: "green" },
};

// ========================================================================
// PRIMITIVES
// ========================================================================
const Tab = ({ active, children, onClick, size = "lg" }) => {
  const isLg = size === "lg";
  const activeColor = isLg ? C.amber : C.text;
  const underline = isLg ? "2px" : "1px";
  return (
    <button
      onClick={onClick}
      style={{
        background: "transparent",
        border: "none",
        padding: isLg ? "6px 20px" : "5px 16px",
        fontFamily: FONT_MONO,
        fontSize: isLg ? 11 : 10,
        letterSpacing: isLg ? 1.5 : 1,
        color: active ? activeColor : C.textDim,
        fontWeight: isLg && active ? "bold" : "normal",
        cursor: "pointer",
        borderBottom: active ? `${underline} solid ${C.amber}` : `${underline} solid transparent`,
        transition: "color .15s",
      }}
    >
      {children}
    </button>
  );
};

const Pill = ({ active, children, onClick }) => (
  <button
    onClick={onClick}
    style={{
      padding: "5px 12px",
      background: active ? C.amber : "transparent",
      color: active ? "#000" : C.textDim,
      border: `1px solid ${active ? C.amber : C.panelEdgeStrong}`,
      fontFamily: FONT_MONO,
      fontSize: 9,
      letterSpacing: 1.2,
      fontWeight: active ? 700 : 500,
      cursor: "pointer",
      borderRadius: 2,
    }}
  >
    {children}
  </button>
);

const Panel = ({ children, style }) => (
  <div
    style={{
      background: C.panel,
      border: `1px solid ${C.panelEdge}`,
      borderRadius: 4,
      padding: 16,
      ...style,
    }}
  >
    {children}
  </div>
);

const StatTile = ({ label, value, sub, color = C.text, valueSize = 18 }) => (
  <div style={{ background: C.bg, border: `1px solid ${C.panelEdge}`, padding: "8px 10px", borderRadius: 3 }}>
    <div style={{ fontSize: 9, color: C.textDim, letterSpacing: 1.5 }}>{label}</div>
    <div style={{ fontSize: valueSize, color, fontWeight: 700, letterSpacing: 0.2, marginTop: 2, lineHeight: 1 }}>
      {value}
    </div>
    {sub && <div style={{ fontSize: 9, color: C.textDim, marginTop: 3 }}>{sub}</div>}
  </div>
);

const KVRow = ({ label, value, valueColor = C.text, sub }) => (
  <div
    style={{
      display: "flex",
      justifyContent: "space-between",
      alignItems: "baseline",
      padding: "9px 12px",
      background: C.panelSoft,
      border: `1px solid ${C.panelEdge}`,
      marginBottom: 4,
    }}
  >
    <div>
      <div style={{ fontSize: 10, color: C.text, letterSpacing: 0.5 }}>{label}</div>
      {sub && <div style={{ fontSize: 8, color: C.textMute, marginTop: 1 }}>{sub}</div>}
    </div>
    <div style={{ fontSize: 12, color: valueColor, fontWeight: 600 }}>{value}</div>
  </div>
);

// ======================================================================
// DATA LAYER — fetches /data/growth.json and normalizes to the shape
// the existing render code expects.
//
// Wire format (backend) → in-memory shape (frontend):
//   - date strings ("2026-04-21")  → JS Date instances
//   - missing 'label' field        → derived via toLocaleDateString
//   - {coinc_z, lead_z}            → {coinc, lead, composite}
//   - null leading-block fields    → wrapped with .available flag so render
//                                     code branches on availability, not nulls
// ======================================================================
function normalizeGrowthPayload(raw) {
  const fmtDay  = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  // "Mar '21" — apostrophe disambiguates from "Mar 21" (day form).
  const fmtWeek = (d) => {
    const s = d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
    // toLocaleDateString returns "Mar 21" or "Mar 21" — we want "Mar '21"
    return s.replace(/(\w{3}) (\d{2})/, "$1 '$2");
  };

  // Note: label is computed at chart render time based on the active
  // chartRange (see src/App.jsx body). We keep `label` here for backwards
  // compatibility with the recent-contributions table, which uses the
  // short "Sep 1" form regardless of chart range.
  const gdpNow = (raw.gdpnow_components || []).map((r) => {
    const d = new Date(r.date);
    return {
      date: d,
      label: fmtDay(d),  // short form — used by recent-contributions table
      total: r.total,
      pceGoods:    r.pceGoods,
      pceServices: r.pceServices,
      fixedInv:    r.fixedInv,
      govt:        r.govt,
      netExports:  r.netExports,
      inventories: r.inventories,
    };
  });

  const compZ = (raw.composite_z || []).map((r) => {
    const d = new Date(r.date);
    const c = r.coinc_z;
    const l = r.lead_z;
    return {
      date: d,
      label: fmtWeek(d),
      coinc: c,
      lead:  l,
      composite: (c != null && l != null) ? (c + l) / 2 : (c ?? l ?? null),
    };
  });

  // NY Fed Staff Nowcast — weekly cadence (Fridays), 2023-04 onward.
  // We render this as a step-after line on the same chart as Atlanta's
  // headline. Drop rows missing ny_nowcast; ny_backcast/ny_next_q are
  // captured in JSON for future use but unused in v1 render.
  const nyFed = (raw.ny_fed_nowcast || []).map((r) => {
    const d = new Date(r.date);
    return {
      date: d,
      ny: r.ny_nowcast,
      ny_target: r.target_quarter,
    };
  }).filter((r) => r.ny != null);

  // Dallas Fed-style WEI vs GDP YoY data for the LEADING tab chart.
  // wei_series: weekly observations of WEI + 13wk MA.
  // gdp_yoy_series: quarterly observations of Real GDP YoY %.
  const weiSeries = (raw.wei_series || []).map((r) => {
    const d = new Date(r.date);
    return {
      date: d,
      wei: r.wei,
      wei_ma13: r.wei_ma13,
    };
  });
  const gdpYoySeries = (raw.gdp_yoy_series || []).map((r) => {
    const d = new Date(r.date);
    return {
      date: d,
      gdp_yoy: r.gdp_yoy,
    };
  }).filter((r) => r.gdp_yoy != null);

  // RecessionAlert leading composite — monthly cadence: USMLEI, %G20, %CBANK.
  const raLeadingSeries = (raw.ra_leading_series || []).map((r) => {
    const d = new Date(r.date);
    return {
      date: d,
      usmlei: r.usmlei,
      pct_g20_rising: r.pct_g20_rising,
      cb_net_cutters: r.cb_net_cutters,
    };
  });
  // RecessionAlert weekly AVG — weekly cadence, higher-resolution overlay.
  const raWeeklyAvgSeries = (raw.ra_weekly_avg_series || []).map((r) => {
    const d = new Date(r.date);
    return {
      date: d,
      avg: r.avg,
    };
  }).filter((r) => r.avg != null);

  // WEI z-score (5Y rolling) — for REGIME MODEL panel COINCIDENT pill.
  const weiZSeries = (raw.wei_z_series || []).map((r) => {
    const d = new Date(r.date);
    return {
      date: d,
      wei_z: r.wei_z,
    };
  }).filter((r) => r.wei_z != null);
  // RA weekly AVG z-score (5Y rolling) — for REGIME MODEL panel LEADING pill.
  const avgZSeries = (raw.avg_z_series || []).map((r) => {
    const d = new Date(r.date);
    return {
      date: d,
      avg_z: r.avg_z,
    };
  }).filter((r) => r.avg_z != null);

  // QUADRANT panel trajectory — 12 most recent monthly observations of
  // (lead_z = USMLEI z, coinc_z = GDP YoY z). Hybrid sourcing: regime
  // panel uses high-frequency WEI/AVG; quadrant uses slower-moving
  // USMLEI/GDP for trajectory stability.
  const quadrantTrajectory = (raw.quadrant_trajectory || []).map((r) => {
    const d = new Date(r.date);
    return {
      date: d,
      lead_z: r.lead_z,
      coinc_z: r.coinc_z,
    };
  }).filter((r) => r.lead_z != null && r.coinc_z != null);

  const sigAv = (raw.meta && raw.meta.signal_availability) || { coincident: true, leading: true };
  const cur = raw.current || {};
  const reg = cur.regime || { level: "NORMAL", direction: "UNKNOWN" };

  return {
    meta: raw.meta || {},
    signalAvailability: { coincident: !!sigAv.coincident, leading: !!sigAv.leading },
    current: {
      regime:        reg,
      hedgeRatio:    cur.hedge_ratio,        // may be null when leading absent
      hedgePosture:  cur.hedge_posture,
      gdpnow:        cur.gdpnow,
      nyNowcast:     cur.ny_nowcast,         // NY Fed current-quarter nowcast
      nyTargetQtr:   cur.ny_target_qtr,      // string e.g. "2026:Q2"
      wei:           cur.wei,
      unctadWorld:   cur.unctad_world,
      wla:           cur.wla,                // null when RA absent
      globalLei8m:   cur.global_lei_8m,      // null when RA absent
      coincZ:        cur.coinc_z,
      leadZ:         cur.lead_z,             // 0.0 default when leading absent — guard via signalAvailability.leading
      weiZ:          cur.wei_z,              // 5Y rolling z of WEI — REGIME MODEL COINCIDENT pill
      avgZ:          cur.avg_z,              // 5Y rolling z of RA weekly AVG — REGIME MODEL LEADING pill
      leadZQuadrant:  cur.lead_z_quadrant,   // USMLEI z — QUADRANT panel X axis
      coincZQuadrant: cur.coinc_z_quadrant,  // GDP YoY z — QUADRANT panel Y axis
      quadrant:       cur.quadrant,          // "ACCELERATING" / "SLOWING" / "CONTRACTION" / "RECOVERY" / null
    },
    gdpNow,
    compZ,
    nyFed,
    weiSeries,
    gdpYoySeries,
    raLeadingSeries,
    raWeeklyAvgSeries,
    weiZSeries,
    avgZSeries,
    quadrantTrajectory,
  };
}

function useGrowthData() {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  useEffect(() => {
    let cancelled = false;
    fetch("/data/growth.json", { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status} fetching /data/growth.json`);
        return r.json();
      })
      .then((raw) => {
        if (cancelled) return;
        setState({ loading: false, error: null, data: normalizeGrowthPayload(raw) });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ loading: false, error: err.message, data: null });
      });
    return () => { cancelled = true; };
  }, []);
  return state;
}

// ========================================================================
// MAIN
// ========================================================================
export default function MacroRegimeGrowth() {
  const [primaryTab, setPrimaryTab] = useState("MACRO_REGIME");
  const [subTab, setSubTab] = useState("GROWTH");
  const [chartMode, setChartMode] = useState("COINCIDENT");
  const [modelMode, setModelMode] = useState("COMPOSITE");
  const [chartRange, setChartRange] = useState("1Y");  // 6M | 1Y | 2Y | MAX
  const [leadingRange, setLeadingRange] = useState("5Y");      // 1Y | 5Y | MAX — drives COINCIDENT chart
  const [leadingTabRange, setLeadingTabRange] = useState("10Y"); // 5Y | 10Y | MAX — drives LEADING chart
  const [regimeRange, setRegimeRange] = useState("10Y"); // 6M | 1Y | 5Y | 10Y | MAX — drives REGIME MODEL chart
  const [quadrantRange, setQuadrantRange] = useState("FULL"); // FULL | TIGHT | AUTO — drives QUADRANT axis domain

  const { loading, error, data } = useGrowthData();

  // Loading and error states render before the rest of the component tree.
  if (loading) {
    return (
      <div style={{ background: C.bg, minHeight: "100vh", color: C.textDim, fontFamily: FONT_MONO,
        display: "flex", alignItems: "center", justifyContent: "center", letterSpacing: 1.5, fontSize: 11 }}>
        LOADING /data/growth.json …
      </div>
    );
  }
  if (error || !data) {
    return (
      <div style={{ background: C.bg, minHeight: "100vh", color: C.red, fontFamily: FONT_MONO,
        padding: 24, fontSize: 11, letterSpacing: 1 }}>
        <div style={{ marginBottom: 8 }}>FAILED TO LOAD /data/growth.json</div>
        <div style={{ color: C.textDim }}>{error}</div>
        <div style={{ color: C.textMute, marginTop: 16, fontSize: 10 }}>
          Run: python scripts/ingest_growth.py
        </div>
      </div>
    );
  }

  // Normalized data — see normalizeGrowthPayload() for shape.
  const gdpNow = data.gdpNow;
  const compZ  = data.compZ;
  const nyFed  = data.nyFed || [];
  const weiSeries = data.weiSeries || [];
  const gdpYoySeries = data.gdpYoySeries || [];
  const raLeadingSeries = data.raLeadingSeries || [];
  const raWeeklyAvgSeries = data.raWeeklyAvgSeries || [];
  const weiZSeries = data.weiZSeries || [];
  const avgZSeries = data.avgZSeries || [];
  const quadrantTrajectory = data.quadrantTrajectory || [];
  const currentQuadrant = data.current.quadrant || null;
  const latestLeadZQuadrant = data.current.leadZQuadrant ?? null;
  const latestCoincZQuadrant = data.current.coincZQuadrant ?? null;
  const latestG = gdpNow[gdpNow.length - 1] || {};

  // Divergence indicator: NY Fed vs Atlanta on the current quarter.
  // Color/label varies based on magnitude — caller uses these for the
  // NY stat tile sub-text.
  const nyDivergence = (() => {
    const atl = data.current.gdpnow;
    const ny = data.current.nyNowcast;
    if (atl == null || ny == null) return null;
    const spread = ny - atl;
    const abs = Math.abs(spread);
    let tone, text;
    if (abs > 1.0) {
      tone = "diverge";
      text = `${spread >= 0 ? "+" : ""}${spread.toFixed(2)}pp vs ATL`;
    } else if (abs <= 0.5) {
      tone = "aligned";
      text = "aligned with ATL";
    } else {
      tone = "neutral";
      text = `${spread >= 0 ? "+" : ""}${spread.toFixed(2)}pp vs ATL`;
    }
    return { spread, tone, text };
  })();
  const prevG   = gdpNow[Math.max(0, gdpNow.length - 22)] || latestG;
  const m1Delta = (latestG.total != null && prevG.total != null)
    ? +(latestG.total - prevG.total).toFixed(2)
    : 0;
  const tableRows = gdpNow.slice(-8).reverse();

  // ----- Chart range filtering -----
  // Map RANGE selection to a number of days back from the latest date.
  // MAX = full history. We slice gdpNow rather than filtering by a date
  // threshold so the visual is always anchored to "the latest date in
  // the dataset minus N days" — robust to data refreshes.
  const RANGE_DAYS = { "6M": 183, "1Y": 365, "2Y": 730, "MAX": Infinity };
  const rangeDays = RANGE_DAYS[chartRange] ?? 365;
  const gdpNowFiltered = (() => {
    if (!gdpNow.length) return [];
    const longLabel = chartRange === "2Y" || chartRange === "MAX";
    const labelFmt = longLabel
      ? (d) => d.toLocaleDateString("en-US", { month: "short", year: "2-digit" })
      : (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

    let slice;
    if (rangeDays === Infinity) {
      slice = gdpNow;
    } else {
      const latestDate = gdpNow[gdpNow.length - 1].date;
      const cutoff = new Date(latestDate.getTime() - rangeDays * 86400000);
      slice = gdpNow.filter((d) => d.date >= cutoff);
    }

    // Build a Map of NY Fed values keyed by ISO date for O(1) lookup.
    const nyByDate = new Map();
    for (const r of nyFed) {
      const k = r.date.toISOString().slice(0, 10);
      nyByDate.set(k, r.ny);
    }

    // Determine NY's last actual release date — used for the
    // solid-vs-dashed handoff. Beyond this date, the magenta line is
    // forward-filled (dashed) rather than reflecting actual NY observations.
    const nyLastDate = nyFed.length > 0
      ? nyFed.reduce((max, r) => (r.date > max ? r.date : max), nyFed[0].date)
      : null;
    const nyLastValue = nyLastDate
      ? nyByDate.get(nyLastDate.toISOString().slice(0, 10))
      : null;

    // Atlanta-driven join: each Atlanta row gets:
    //   ny       — original combined field (kept for backward compat / legend)
    //   nyReal   — actual NY observation if this date has one, else null
    //   nyFilled — last-known NY value held flat at-or-after nyLastDate, else null
    // The two split fields drive separate <Line> elements in the chart,
    // so we can render solid for actual data and dashed for forward-fill.
    const atlSliceDates = new Set(slice.map((d) => d.date.toISOString().slice(0, 10)));
    const merged = slice.map((d) => {
      const k = d.date.toISOString().slice(0, 10);
      const actualNy = nyByDate.has(k) ? nyByDate.get(k) : null;

      const nyReal = actualNy;

      const nyFilled = (nyLastDate && d.date >= nyLastDate)
        ? nyLastValue
        : null;

      return {
        ...d,
        label: labelFmt(d.date),
        ny: actualNy,
        nyReal,
        nyFilled,
      };
    });

    // Pad with NY-only rows for any NY release date in the visible range
    // that has no matching Atlanta date. Each NY-only row forward-fills
    // total + components from the prior Atlanta business day (see below),
    // so Atlanta's white line and bars remain continuous without needing
    // connectNulls.
    const atlLastDate = slice[slice.length - 1].date;
    const cutoffStart = rangeDays === Infinity
      ? new Date(0)
      : new Date(slice[0].date.getTime());

    // Build NY-only rows. For each NY Friday with no matching Atlanta
    // date, find the most recent Atlanta row with a date strictly less
    // than the NY date, and inherit its total + component values. This
    // keeps the bar wall continuous and the white line unbroken.
    // The forward-fill is honest: we're saying "Atlanta hadn't published
    // a new value yet, so the visible bar represents the latest known
    // estimate" — same convention Bloomberg uses for daily charts with
    // missing trading days.
    const nyOnlyRows = nyFed
      .filter((r) => r.date >= cutoffStart && !atlSliceDates.has(r.date.toISOString().slice(0, 10)))
      .map((r) => {
        // Find the most recent Atlanta row strictly before this NY date.
        // slice is sorted by date, so we walk backwards from the end.
        let priorAtl = null;
        for (let i = slice.length - 1; i >= 0; i--) {
          if (slice[i].date < r.date) {
            priorAtl = slice[i];
            break;
          }
        }
        // Fallback: if no prior Atlanta row in slice (NY date is before
        // any Atlanta in the visible range), use the first Atlanta row
        // in the full series instead. Edge case for very early-range NY.
        if (!priorAtl && gdpNow.length > 0) {
          priorAtl = gdpNow[0];
        }
        return {
          date: r.date,
          label: labelFmt(r.date),
          total: priorAtl ? priorAtl.total : null,
          pceGoods: priorAtl ? priorAtl.pceGoods : null,
          pceServices: priorAtl ? priorAtl.pceServices : null,
          fixedInv: priorAtl ? priorAtl.fixedInv : null,
          govt: priorAtl ? priorAtl.govt : null,
          netExports: priorAtl ? priorAtl.netExports : null,
          inventories: priorAtl ? priorAtl.inventories : null,
          ny: r.ny,
          nyReal: r.ny,
          nyFilled: null,
        };
      });

    return [...merged, ...nyOnlyRows].sort((a, b) => a.date - b.date);
  })();

  // ----- Y-axis auto-zoom -----
  // Domain accounts for both the headline line AND stacked component bars
  // above/below it. Bars only exist for current-quarter rows; for those
  // we sum positive contributions (bar top) and negative contributions
  // (bar bottom) separately so the y-axis can fit both.
  const yDomain = (() => {
    if (!gdpNowFiltered.length) return [-1, 4];
    let yMin = Infinity, yMax = -Infinity;
    for (const d of gdpNowFiltered) {
      if (d.total != null) {
        if (d.total < yMin) yMin = d.total;
        if (d.total > yMax) yMax = d.total;
      }
      // If this row has component bars, bar top = sum of positives,
      // bar bottom = sum of negatives. recharts stackOffset="sign" stacks
      // positives upward from 0 and negatives downward from 0.
      const comps = ["pceGoods", "pceServices", "fixedInv", "govt", "netExports", "inventories"];
      let pos = 0, neg = 0;
      let hasComp = false;
      for (const c of comps) {
        const v = d[c];
        if (v != null) {
          hasComp = true;
          if (v > 0) pos += v;
          else neg += v;
        }
      }
      if (hasComp) {
        if (pos > yMax) yMax = pos;
        if (neg < yMin) yMin = neg;
      }
    }
    if (yMin === Infinity) return [-1, 4];  // no data — fallback
    // Pad ~10% on each side, with a minimum padding so flat ranges still breathe.
    const pad = Math.max(0.3, (yMax - yMin) * 0.1);
    return [Math.floor((yMin - pad) * 10) / 10, Math.ceil((yMax + pad) * 10) / 10];
  })();

  // ----- Current-quarter boundary -----
  // Marks the first data point of the calendar quarter the latest reading
  // belongs to (e.g. latest=2026-04-21 → boundary at first row >= 2026-04-01).
  // Pre-Step 6d we used "first row with non-null pceGoods" as a proxy, but
  // ContribArchives now fills components for the full history, so that proxy
  // resolves to the leftmost visible point on every range.
  const currentQtrStart = (() => {
    if (!gdpNowFiltered.length) return null;
    const latest = gdpNowFiltered[gdpNowFiltered.length - 1].date;
    const qStartMonth = Math.floor(latest.getMonth() / 3) * 3;  // 0,3,6,9
    const qStart = new Date(latest.getFullYear(), qStartMonth, 1);
    const firstInQtr = gdpNowFiltered.find((d) => d.date >= qStart);
    return firstInQtr ? firstInQtr.label : null;
  })();

  // ----- Adaptive x-axis ticks -----
  // Replace the existing monthTicks block (a few lines below) with this.
  // For 6M: monthly ticks. For 1Y: monthly. For 2Y: every 2 months.
  // For MAX: yearly.
  const tickStride = chartRange === "MAX" ? 12 : chartRange === "2Y" ? 2 : 1;

  // Composite z's: last weekly observation, plus 8w-ago lead for direction context.
  // Backend already classifies regime (and emits "UNKNOWN" when leading absent),
  // so we don't re-derive — just read from data.current.
  const latest = compZ[compZ.length - 1] || { coinc: 0, lead: 0 };
  const regime = data.current.regime;                 // {level, direction}
  const regimeKey = `${regime.level}_${regime.direction}`;
  const hedge = HEDGE_MAP[regimeKey] || { ratio: data.current.hedgeRatio, posture: data.current.hedgePosture, color: "amber" };
  const hedgeColor = hedge.color === "green" ? C.green : hedge.color === "red" ? C.red : C.amber;

  // Convenience for degraded-state rendering.
  const leadAvail = data.signalAvailability.leading;
  const fmtNum = (v, digits = 2, suffix = "") => v == null ? "—" : `${v.toFixed(digits)}${suffix}`;

  // X-axis ticks — plain const, not useMemo. The arrays here are <300 rows;
  // memoization wasn't earning its keep against the Rules-of-Hooks
  // ordering constraint that conflicts with our early returns above.
  const monthTicks = (() => {
    if (!gdpNowFiltered || !gdpNowFiltered.length) return [];
    const seen = new Set();
    const monthsSeen = [];
    for (const d of gdpNowFiltered) {
      const k = `${d.date.getFullYear()}-${d.date.getMonth()}`;
      if (!seen.has(k)) {
        seen.add(k);
        monthsSeen.push(d);
      }
    }
    // Apply stride: tickStride=1 keeps every month, =2 every other,
    // =12 yearly. Always include the most recent month so the rightmost
    // edge has a label.
    const strided = monthsSeen.filter((_, i) => i % tickStride === 0);
    if (monthsSeen.length && strided[strided.length - 1] !== monthsSeen[monthsSeen.length - 1]) {
      strided.push(monthsSeen[monthsSeen.length - 1]);
    }
    return strided.map((d) => d.label);
  })();

  // ---- LEADING chart data preparation ----
  // Merge WEI (weekly) + GDP YoY (quarterly) onto a single time-sorted
  // array. Each row carries date + (wei | wei_ma13 | gdp_yoy), with
  // nulls where a series doesn't have a value at that date. Recharts'
  // connectNulls handles the gaps.
  const LEADING_RANGE_DAYS = { "1Y": 365, "5Y": 1825, "MAX": Infinity };
  const leadingRangeDays = LEADING_RANGE_DAYS[leadingRange] ?? 1825;

  const leadingChartData = (() => {
    if (!weiSeries.length && !gdpYoySeries.length) return [];

    // Range filter — anchor to "today" (latest date in either series)
    const latestWei = weiSeries.length ? weiSeries[weiSeries.length - 1].date : null;
    const latestGdp = gdpYoySeries.length ? gdpYoySeries[gdpYoySeries.length - 1].date : null;
    const latestDate = (latestWei && latestGdp)
      ? (latestWei > latestGdp ? latestWei : latestGdp)
      : (latestWei || latestGdp);

    const cutoff = leadingRangeDays === Infinity
      ? new Date(0)
      : new Date(latestDate.getTime() - leadingRangeDays * 86400000);

    const weiInRange = weiSeries.filter((r) => r.date >= cutoff);
    const gdpInRange = gdpYoySeries.filter((r) => r.date >= cutoff);

    // Range-aware date labels — short for 1Y, longer for 5Y/MAX
    const longLabel = leadingRange === "5Y" || leadingRange === "MAX";
    const labelFmt = longLabel
      ? (d) => d.toLocaleDateString("en-US", { month: "short", year: "2-digit" })
      : (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

    // Build a Map keyed by ISO date for union-merge
    const merged = new Map();
    for (const r of weiInRange) {
      const k = r.date.toISOString().slice(0, 10);
      merged.set(k, { date: r.date, label: labelFmt(r.date), wei: r.wei, wei_ma13: r.wei_ma13, gdp_yoy: null });
    }
    for (const r of gdpInRange) {
      const k = r.date.toISOString().slice(0, 10);
      const existing = merged.get(k);
      if (existing) {
        existing.gdp_yoy = r.gdp_yoy;
      } else {
        merged.set(k, { date: r.date, label: labelFmt(r.date), wei: null, wei_ma13: null, gdp_yoy: r.gdp_yoy });
      }
    }

    // Sort by date and return as array
    return Array.from(merged.values()).sort((a, b) => a.date - b.date);
  })();

  // Compute y-axis domain for LEADING chart with padding
  const leadingYDomain = (() => {
    if (!leadingChartData.length) return [-2, 5];
    let yMin = Infinity, yMax = -Infinity;
    for (const r of leadingChartData) {
      for (const v of [r.wei, r.wei_ma13, r.gdp_yoy]) {
        if (v != null) {
          if (v < yMin) yMin = v;
          if (v > yMax) yMax = v;
        }
      }
    }
    if (yMin === Infinity) return [-2, 5];
    const pad = Math.max(0.5, (yMax - yMin) * 0.1);
    return [Math.floor((yMin - pad) * 2) / 2, Math.ceil((yMax + pad) * 2) / 2];
  })();

  // Latest values for legend/tile display
  const latestWeiRow = weiSeries.length ? weiSeries[weiSeries.length - 1] : null;
  const latestGdpRow = gdpYoySeries.length ? gdpYoySeries[gdpYoySeries.length - 1] : null;

  // Adaptive x-axis tick stride for LEADING chart
  const leadingTickStride = leadingRange === "MAX" ? 24 : leadingRange === "5Y" ? 6 : 2;
  const leadingMonthTicks = (() => {
    if (!leadingChartData.length) return [];
    const seen = new Set();
    const monthsSeen = [];
    for (const d of leadingChartData) {
      const k = `${d.date.getFullYear()}-${d.date.getMonth()}`;
      if (!seen.has(k)) {
        seen.add(k);
        monthsSeen.push(d);
      }
    }
    const strided = monthsSeen.filter((_, i) => i % leadingTickStride === 0);
    if (monthsSeen.length && strided[strided.length - 1] !== monthsSeen[monthsSeen.length - 1]) {
      strided.push(monthsSeen[monthsSeen.length - 1]);
    }
    return strided.map((d) => d.label);
  })();

  // ---- LEADING tab chart data preparation ----
  // Merge RA monthly (USMLEI, %G20, %CBANK) + weekly AVG into one
  // date-sorted array. Each row carries date + (usmlei | pct_g20_rising |
  // cb_net_cutters | avg), with nulls where a series doesn't have a
  // value at that date. connectNulls handles gaps.
  const LEADING_TAB_RANGE_DAYS = { "5Y": 1825, "10Y": 3650, "MAX": Infinity };
  const leadingTabRangeDays = LEADING_TAB_RANGE_DAYS[leadingTabRange] ?? 3650;

  const leadingTabChartData = (() => {
    if (!raLeadingSeries.length && !raWeeklyAvgSeries.length) return [];

    // Lead times (in months) for forward-shifted series.
    // RecessionAlert's reference chart shifts %G20 RISING by 8 months
    // (their stated empirical lead time on coincident activity).
    // We additionally shift %CBANK CUTTERS by 12 months — global rate
    // policy typically affects real economy with a ~1yr lag.
    const G20_LEAD_MONTHS = 8;
    const CBANK_LEAD_MONTHS = 12;

    // Helper to shift a date forward by N months (preserves day-of-month
    // when possible; falls back to month-end if target month is shorter).
    const shiftMonths = (d, n) => {
      const out = new Date(d.getTime());
      out.setMonth(out.getMonth() + n);
      return out;
    };

    // Range filter — anchor to latest date across all source series.
    // Note: forward-shifted observations land at native_date + lead, so
    // the displayed chart will extend further right than latestNativeDate.
    // The cutoff still uses native dates (we want N years of history
    // ending at "today", regardless of forward projection).
    const latestMonthly = raLeadingSeries.length ? raLeadingSeries[raLeadingSeries.length - 1].date : null;
    const latestWeekly  = raWeeklyAvgSeries.length ? raWeeklyAvgSeries[raWeeklyAvgSeries.length - 1].date : null;
    const latestNativeDate = (latestMonthly && latestWeekly)
      ? (latestMonthly > latestWeekly ? latestMonthly : latestWeekly)
      : (latestMonthly || latestWeekly);

    const cutoff = leadingTabRangeDays === Infinity
      ? new Date(0)
      : new Date(latestNativeDate.getTime() - leadingTabRangeDays * 86400000);

    const monthlyInRange = raLeadingSeries.filter((r) => r.date >= cutoff);
    const weeklyInRange = raWeeklyAvgSeries.filter((r) => r.date >= cutoff);

    // Range-aware date labels — note: labels reflect the SHIFTED date
    // for forward series, native date for non-shifted series.
    const longLabel = leadingTabRange === "10Y" || leadingTabRange === "MAX";
    const labelFmt = longLabel
      ? (d) => d.toLocaleDateString("en-US", { month: "short", year: "2-digit" })
      : (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

    // Union-merge via Map keyed by ISO date.
    // Forward-shifted variants land at separate keys (date + lead_months).
    // USMLEI and AVG stay at native dates. The Map automatically handles
    // merging when multiple series happen to land on the same shifted date.
    const merged = new Map();

    // Add USMLEI at native dates (no shift)
    for (const r of monthlyInRange) {
      const k = r.date.toISOString().slice(0, 10);
      const existing = merged.get(k);
      if (existing) {
        existing.usmlei = r.usmlei;
      } else {
        merged.set(k, {
          date: r.date,
          label: labelFmt(r.date),
          usmlei: r.usmlei,
          pct_g20_rising: null,
          cb_net_cutters: null,
          avg: null,
        });
      }
    }

    // Add %G20 at shifted dates (date + 8 months)
    for (const r of monthlyInRange) {
      if (r.pct_g20_rising == null) continue;
      const shiftedDate = shiftMonths(r.date, G20_LEAD_MONTHS);
      const k = shiftedDate.toISOString().slice(0, 10);
      const existing = merged.get(k);
      if (existing) {
        existing.pct_g20_rising = r.pct_g20_rising;
      } else {
        merged.set(k, {
          date: shiftedDate,
          label: labelFmt(shiftedDate),
          usmlei: null,
          pct_g20_rising: r.pct_g20_rising,
          cb_net_cutters: null,
          avg: null,
        });
      }
    }

    // Add %CBANK at shifted dates (date + 12 months)
    for (const r of monthlyInRange) {
      if (r.cb_net_cutters == null) continue;
      const shiftedDate = shiftMonths(r.date, CBANK_LEAD_MONTHS);
      const k = shiftedDate.toISOString().slice(0, 10);
      const existing = merged.get(k);
      if (existing) {
        existing.cb_net_cutters = r.cb_net_cutters;
      } else {
        merged.set(k, {
          date: shiftedDate,
          label: labelFmt(shiftedDate),
          usmlei: null,
          pct_g20_rising: null,
          cb_net_cutters: r.cb_net_cutters,
          avg: null,
        });
      }
    }

    // Add weekly AVG at native dates (no shift)
    for (const r of weeklyInRange) {
      const k = r.date.toISOString().slice(0, 10);
      const existing = merged.get(k);
      if (existing) {
        existing.avg = r.avg;
      } else {
        merged.set(k, {
          date: r.date,
          label: labelFmt(r.date),
          usmlei: null,
          pct_g20_rising: null,
          cb_net_cutters: null,
          avg: r.avg,
        });
      }
    }

    return Array.from(merged.values()).sort((a, b) => a.date - b.date);
  })();

  // Y-axis domains for LEADING tab chart — three axes total:
  //   Left (outer):  USMLEI + AVG, FIXED bounds for visual stability
  //                  across range views.
  //   Right (inner): %G20 RISING, AUTO-ZOOMED to visible-range data so
  //                  the line uses full vertical height.
  //   Right (outer): %CBANK CUTTERS, AUTO-ZOOMED similarly.
  //
  // Each leading series gets its own axis because their absolute scales
  // aren't directly comparable. Turning-point alignment is achieved by
  // the forward-shift transformation (8mo for %G20, 12mo for %CBANK)
  // applied in leadingTabChartData; magnitude alignment isn't meaningful
  // and would require visual compression to enforce.
  const leadingTabLeftDomain = [-100, 80];

  // Compute auto-zoom domain for a given column from leadingTabChartData.
  // Returns [floor(min - pad), ceil(max + pad)] rounded to nearest 5.
  // Padding is 10% of range, with a 2-unit floor.
  const autoZoomDomain = (col, fallback = [0, 100]) => {
    if (!leadingTabChartData.length) return fallback;
    let yMin = Infinity, yMax = -Infinity;
    for (const r of leadingTabChartData) {
      const v = r[col];
      if (v != null) {
        if (v < yMin) yMin = v;
        if (v > yMax) yMax = v;
      }
    }
    if (yMin === Infinity) return fallback;
    const pad = Math.max(2, (yMax - yMin) * 0.1);
    return [Math.floor((yMin - pad) / 5) * 5, Math.ceil((yMax + pad) / 5) * 5];
  };
  const leadingTabG20Domain = autoZoomDomain("pct_g20_rising", [0, 100]);
  const leadingTabCbankDomain = autoZoomDomain("cb_net_cutters", [-50, 50]);

  // Latest values for legend display
  const latestUsmleiRow = raLeadingSeries.length ? raLeadingSeries[raLeadingSeries.length - 1] : null;
  const latestRaWeekly = raWeeklyAvgSeries.length ? raWeeklyAvgSeries[raWeeklyAvgSeries.length - 1] : null;

  // Adaptive x-axis tick stride for LEADING tab chart
  const leadingTabTickStride = leadingTabRange === "MAX" ? 24 : leadingTabRange === "10Y" ? 12 : 6;
  const leadingTabMonthTicks = (() => {
    if (!leadingTabChartData.length) return [];
    const seen = new Set();
    const monthsSeen = [];
    for (const d of leadingTabChartData) {
      const k = `${d.date.getFullYear()}-${d.date.getMonth()}`;
      if (!seen.has(k)) {
        seen.add(k);
        monthsSeen.push(d);
      }
    }
    const strided = monthsSeen.filter((_, i) => i % leadingTabTickStride === 0);
    if (monthsSeen.length && strided[strided.length - 1] !== monthsSeen[monthsSeen.length - 1]) {
      strided.push(monthsSeen[monthsSeen.length - 1]);
    }
    return strided.map((d) => d.label);
  })();

  const compZTicks = (() => {
    if (!compZ || !compZ.length) return [];
    const seen = new Set();
    return compZ
      .filter((d) => {
        const k = `${d.date.getFullYear()}-${Math.floor(d.date.getMonth() / 6)}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((d) => d.label);
  })();

  // Regime panel chart data — resamples WEI z-score + RA AVG z-score to monthly
  // EOM so both series align on the same row (raw cadence is weekly but on
  // different weekdays, so a date-keyed merge would be sparse). Per Step 13b
  // spec: monthly resample is for visual smoothness only; the regime
  // classifier still uses weekly z internally.
  const regimePanelData = (() => {
    if (!weiZSeries.length && !avgZSeries.length) return [];
    const fmtWeek = (d) => d.toLocaleDateString("en-US", { month: "short", year: "2-digit" }).replace(/(\w{3}) (\d{2})/, "$1 '$2");
    const monthKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const months = new Map();
    const ensure = (d) => {
      const k = monthKey(d);
      let bucket = months.get(k);
      if (!bucket) {
        bucket = { key: k, lastWeiDate: null, lastWeiZ: null, lastAvgDate: null, lastAvgZ: null };
        months.set(k, bucket);
      }
      return bucket;
    };
    for (const r of weiZSeries) {
      const b = ensure(r.date);
      if (!b.lastWeiDate || r.date > b.lastWeiDate) {
        b.lastWeiDate = r.date;
        b.lastWeiZ = r.wei_z;
      }
    }
    for (const r of avgZSeries) {
      const b = ensure(r.date);
      if (!b.lastAvgDate || r.date > b.lastAvgDate) {
        b.lastAvgDate = r.date;
        b.lastAvgZ = r.avg_z;
      }
    }
    const rows = Array.from(months.values()).map((b) => {
      const [y, m] = b.key.split("-").map(Number);
      const eom = new Date(y, m, 0); // day=0 of next month = last day of this month
      return {
        date: eom,
        label: fmtWeek(eom),
        wei_z: b.lastWeiZ,
        avg_z: b.lastAvgZ,
      };
    }).sort((a, b) => a.date - b.date);

    // Apply selected range — slice off rows older than (latest - rangeDays).
    const REGIME_RANGE_DAYS = { "6M": 183, "1Y": 365, "5Y": 1825, "10Y": 3650, "MAX": Infinity };
    const rangeDays = REGIME_RANGE_DAYS[regimeRange] ?? 3650;
    if (rangeDays === Infinity || !rows.length) return rows;
    const cutoff = new Date(rows[rows.length - 1].date.getTime() - rangeDays * 86400000);
    return rows.filter((r) => r.date >= cutoff);
  })();

  const regimePanelTicks = (() => {
    if (!regimePanelData.length) return [];
    const seen = new Set();
    return regimePanelData
      .filter((d) => {
        const k = `${d.date.getFullYear()}-${Math.floor(d.date.getMonth() / 6)}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((d) => d.label);
  })();

  // Latest scalar values for the regime panel header subtitle.
  const latestWeiZ = data.current.weiZ ?? (weiZSeries.length ? weiZSeries[weiZSeries.length - 1].wei_z : null);
  const latestAvgZ = data.current.avgZ ?? (avgZSeries.length ? avgZSeries[avgZSeries.length - 1].avg_z : null);

  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.text, fontFamily: FONT_MONO }}>
      {/* ============================================================ */}
      {/* TOP BRAND BAR                                                 */}
      {/* ============================================================ */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "10px 16px",
          borderBottom: `1px solid ${C.panelEdge}`,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              width: 22,
              height: 22,
              border: `1.5px solid ${C.amber}`,
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              color: C.amber,
              fontWeight: 700,
            }}
          >
            S
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: "bold", letterSpacing: 3, color: C.amber }}>
              SMALLFISHMACRO
            </span>
            <span style={{ fontSize: 12, letterSpacing: 2, color: C.text, fontWeight: "bold" }}>
              TERMINAL
            </span>
            <span style={{ fontSize: 10, color: C.textDim }}>v1.0</span>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 10, color: C.textDim }}>
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 14, height: 10, background: "#3b82f6", display: "inline-block", borderRadius: 1 }} />
            US
          </span>
          <span>ATLANTA FED + FRED + UNCTAD + RECESSIONALERT</span>
          <span style={{ color: C.amber }}>{new Date(data.meta.generated_at).toLocaleDateString("en-US", { day: "2-digit", month: "short", year: "2-digit" }).toUpperCase()}</span>
          <span>09:24</span>
          <button
            style={{
              background: "transparent",
              color: C.textDim,
              border: `1px solid ${C.panelEdge}`,
              padding: "3px 10px",
              fontFamily: FONT_MONO,
              fontSize: 10,
              letterSpacing: 1,
              cursor: "pointer",
              borderRadius: 2,
            }}
          >
            REFRESH
          </button>
        </div>
      </div>

      {/* ============================================================ */}
      {/* PRIMARY TAB ROW                                               */}
      {/* ============================================================ */}
      <div style={{ display: "flex", padding: "0 16px", borderBottom: `1px solid ${C.panelEdge}` }}>
        <Tab active={primaryTab === "RATES_REGIME"}  onClick={() => setPrimaryTab("RATES_REGIME")}>RATES REGIME</Tab>
        <Tab active={primaryTab === "BUY_THE_DIP"}   onClick={() => setPrimaryTab("BUY_THE_DIP")}>BUY THE DIP</Tab>
        <Tab active={primaryTab === "MARKET_RISK"}   onClick={() => setPrimaryTab("MARKET_RISK")}>MARKET RISK</Tab>
        <Tab active={primaryTab === "MACRO_REGIME"}  onClick={() => setPrimaryTab("MACRO_REGIME")}>MACRO REGIME</Tab>
      </div>

      {/* ============================================================ */}
      {/* SECONDARY SUB-TAB ROW                                         */}
      {/* ============================================================ */}
      <div style={{ display: "flex", padding: "0 16px", borderBottom: `1px solid ${C.panelEdge}`, marginBottom: 12 }}>
        <Tab size="sm" active={subTab === "GROWTH"}    onClick={() => setSubTab("GROWTH")}>GROWTH</Tab>
        <Tab size="sm" active={subTab === "INFLATION"} onClick={() => setSubTab("INFLATION")}>INFLATION</Tab>
        <Tab size="sm" active={subTab === "LIQUIDITY"} onClick={() => setSubTab("LIQUIDITY")}>LIQUIDITY</Tab>
        <Tab size="sm" active={subTab === "POLICY"}    onClick={() => setSubTab("POLICY")}>POLICY</Tab>
        <Tab size="sm" active={subTab === "NEWS"}      onClick={() => setSubTab("NEWS")}>NEWS</Tab>
        <Tab size="sm" active={subTab === "BRIEFING"}  onClick={() => setSubTab("BRIEFING")}>BRIEFING</Tab>
      </div>

      {/* ============================================================ */}
      {/* DATA SOURCE CONNECTOR STRIP                                   */}
      {/* ============================================================ */}
      <div style={{ padding: "0 16px", marginBottom: 12 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            background: C.panel,
            border: `1px solid ${C.panelEdge}`,
            padding: "8px 12px",
            borderRadius: 3,
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontSize: 10, color: C.textDim, letterSpacing: 1 }}>SOURCES</span>
          <span
            style={{
              fontSize: 9,
              color: C.green,
              background: "rgba(0,200,83,0.15)",
              padding: "2px 6px",
              borderRadius: 2,
            }}
          >
            ● LIVE
          </span>
          <div
            style={{
              flex: 1,
              minWidth: 200,
              fontSize: 10,
              color: C.textDim,
              display: "flex",
              gap: 16,
              flexWrap: "wrap",
            }}
          >
            <span><span style={{ color: C.text }}>atlantafed.org</span> · GDPNow + components</span>
            <span><span style={{ color: C.text }}>newyorkfed.org</span> · Staff Nowcast</span>
            <span><span style={{ color: C.text }}>FRED</span> · WEI</span>
            <span><span style={{ color: C.text }}>UNCTAD</span> · World Nowcast</span>
            <span><span style={{ color: C.text }}>RecessionAlert</span> · WLA + Global LEI</span>
          </div>
          <button
            style={{
              background: C.amber,
              color: C.bg,
              border: `1px solid ${C.amber}`,
              padding: "4px 12px",
              fontFamily: FONT_MONO,
              fontSize: 10,
              letterSpacing: 1,
              fontWeight: "bold",
              cursor: "pointer",
              borderRadius: 2,
            }}
          >
            CONNECT
          </button>
          <span style={{ fontSize: 9, color: C.textDim }}>
            All sources <span style={{ color: C.cyan }}>free / public</span> · no Bloomberg required
          </span>
        </div>
      </div>

      {/* ============================================================ */}
      {/* MAIN CONTENT GRID — 60/40                                     */}
      {/* ============================================================ */}
      <div style={{ display: "grid", gridTemplateColumns: "1.55fr 1fr", gap: 16, padding: "0 16px 16px" }}>
        {/* ================================================================ */}
        {/* LEFT — US GROWTH                                                  */}
        {/* ================================================================ */}
        <div>
          {/* Header row */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
              <span style={{ fontSize: 14, color: C.text, letterSpacing: 2, fontWeight: 600 }}>US GROWTH</span>
              <span style={{ fontSize: 11, color: C.amber, letterSpacing: 1.5, fontWeight: 600 }}>
                GDPNOW {latestG.total.toFixed(2)}%
              </span>
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              <Pill active={chartMode === "NOWCAST"}    onClick={() => setChartMode("NOWCAST")}>NOWCAST</Pill>
              <Pill active={chartMode === "COINCIDENT"} onClick={() => setChartMode("COINCIDENT")}>COINCIDENT</Pill>
              <Pill active={chartMode === "LEADING"}    onClick={() => setChartMode("LEADING")}>LEADING</Pill>
            </div>
          </div>

          {/* Stat tile row */}
          <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1.2fr 0.9fr 0.9fr 0.9fr", gap: 8, marginBottom: 14 }}>
            <StatTile
              label="ATL GDPNOW"
              value={latestG.total != null ? `${latestG.total.toFixed(3)}%` : "—"}
              sub={`${data.current.nyTargetQtr ?? "current Q"} · Atlanta · daily`}
              color={latestG.total != null ? (latestG.total > 2 ? C.green : latestG.total < 0.5 ? C.red : C.amber) : C.textMute}
            />
            <StatTile
              label="NY FED NOWCAST"
              value={data.current.nyNowcast != null ? `${data.current.nyNowcast.toFixed(2)}%` : "—"}
              sub={
                nyDivergence == null
                  ? `${data.current.nyTargetQtr ?? "current Q"} · NY Fed · weekly`
                  : nyDivergence.tone === "aligned"
                    ? "aligned with ATL"
                    : nyDivergence.text
              }
              color={
                data.current.nyNowcast == null ? C.textMute :
                nyDivergence?.tone === "diverge" ? C.red :
                nyDivergence?.tone === "aligned" ? C.green : C.magenta
              }
            />
            <StatTile label="Δ 1M"  value={`${m1Delta >= 0 ? "+" : ""}${m1Delta.toFixed(2)}`} sub="ATL · vs ~22 obs ago" color={m1Delta >= 0 ? C.green : C.red} valueSize={18} />
            <StatTile label="WEI"   value={fmtNum(data.current.wei, 2)} sub="Dallas Fed · weekly" color={C.text} valueSize={18} />
            <StatTile label="WORLD" value={fmtNum(data.current.unctadWorld, 2, "%")} sub="UNCTAD · monthly" color={C.text} valueSize={18} />
          </div>

          {/* Atlanta Fed components panel */}
          <Panel style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, paddingBottom: 8, borderBottom: `1px solid ${C.panelEdge}` }}>
              <div style={{ fontSize: 10, letterSpacing: 1.4, color: C.text }}>
                {chartMode === "COINCIDENT" ? (
                  <>
                    US COINCIDENT <span style={{ color: C.amber }}>—</span>
                    <span style={{ color: C.textMute, marginLeft: 8, fontSize: 8 }}>· WEI vs GDP YOY</span>
                  </>
                ) : chartMode === "LEADING" ? (
                  <>
                    US LEADING INDICATORS <span style={{ color: C.amber }}>—</span>
                    <span style={{ color: C.textMute, marginLeft: 8, fontSize: 8 }}>· RecessionAlert composite</span>
                  </>
                ) : (
                  <>
                    US ATLANTA FED GDPNOW <span style={{ color: C.amber }}>{latestG.total != null ? latestG.total.toFixed(3) : "—"}</span>
                    <span style={{ color: C.textMute, marginLeft: 8, fontSize: 8 }}>· {chartRange} VIEW</span>
                  </>
                )}
              </div>
              {chartMode === "NOWCAST" && (
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 8, color: C.textMute, letterSpacing: 1 }}>RANGE</span>
                  {["6M", "1Y", "2Y", "MAX"].map((r) => (
                    <button
                      key={r}
                      onClick={() => setChartRange(r)}
                      style={{
                        fontSize: 8,
                        padding: "2px 7px",
                        color: r === chartRange ? "#000" : C.textDim,
                        background: r === chartRange ? C.amber : "transparent",
                        border: `1px solid ${r === chartRange ? C.amber : C.panelEdgeStrong}`,
                        letterSpacing: 1,
                        cursor: "pointer",
                        borderRadius: 1,
                        fontFamily: FONT_MONO,
                      }}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {chartMode === "COINCIDENT" ? (
              <>
                {/* COINCIDENT chart legend + range selector row */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, marginTop: 4 }}>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 14, fontSize: 8, letterSpacing: 1 }}>
                    <Legend color={C.cyan}  label="WEI (RAW)"  value={latestWeiRow?.wei != null ? latestWeiRow.wei.toFixed(2) : "—"} />
                    <Legend color={C.white} label="WEI 13W MA" value={latestWeiRow?.wei_ma13 != null ? latestWeiRow.wei_ma13.toFixed(2) : "—"} bold />
                    <Legend color={C.amber} label="GDP YOY"    value={latestGdpRow?.gdp_yoy != null ? `${latestGdpRow.gdp_yoy.toFixed(2)}%` : "—"} bold />
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 8, color: C.textMute, letterSpacing: 1 }}>RANGE</span>
                    {["1Y", "5Y", "MAX"].map((r) => (
                      <button
                        key={r}
                        onClick={() => setLeadingRange(r)}
                        style={{
                          fontSize: 8,
                          padding: "2px 7px",
                          color: r === leadingRange ? "#000" : C.textDim,
                          background: r === leadingRange ? C.amber : "transparent",
                          border: `1px solid ${r === leadingRange ? C.amber : C.panelEdgeStrong}`,
                          letterSpacing: 1,
                          cursor: "pointer",
                          borderRadius: 1,
                          fontFamily: FONT_MONO,
                        }}
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                </div>

                {/* LEADING chart */}
                <div style={{ width: "100%", height: 460 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={leadingChartData} margin={{ top: 6, right: 30, left: 0, bottom: 6 }}>
                      <CartesianGrid stroke={C.panelEdge} strokeDasharray="2 4" vertical={false} />
                      <XAxis
                        dataKey="label"
                        ticks={leadingMonthTicks}
                        tick={{ fill: C.textDim, fontSize: 8, fontFamily: FONT_MONO }}
                        axisLine={{ stroke: C.panelEdge }}
                        tickLine={false}
                      />
                      <YAxis
                        domain={leadingYDomain}
                        tick={{ fill: C.textDim, fontSize: 8, fontFamily: FONT_MONO }}
                        axisLine={{ stroke: C.panelEdge }}
                        tickLine={false}
                        width={36}
                        tickFormatter={(v) => `${v}%`}
                      />
                      <ReferenceLine y={0} stroke={C.textMute} strokeWidth={0.5} />
                      <Tooltip
                        contentStyle={{
                          background: "#000",
                          border: `1px solid ${C.amber}`,
                          fontFamily: FONT_MONO,
                          fontSize: 9,
                          borderRadius: 2,
                        }}
                        labelStyle={{ color: C.amber, marginBottom: 4 }}
                        itemStyle={{ padding: "1px 0" }}
                      />
                      {/* WEI raw — thin cyan line */}
                      <Line
                        type="monotone"
                        dataKey="wei"
                        stroke={C.cyan}
                        strokeWidth={1.0}
                        dot={false}
                        connectNulls
                        isAnimationActive={false}
                      />
                      {/* WEI 13wk MA — thicker white line */}
                      <Line
                        type="monotone"
                        dataKey="wei_ma13"
                        stroke={C.white}
                        strokeWidth={1.8}
                        dot={false}
                        connectNulls
                        isAnimationActive={false}
                      />
                      {/* GDP YoY — stepped amber line (quarterly cadence) */}
                      <Line
                        type="stepAfter"
                        dataKey="gdp_yoy"
                        stroke={C.amber}
                        strokeWidth={2.0}
                        dot={false}
                        connectNulls
                        isAnimationActive={false}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>

                {/* Source footer */}
                <div style={{ marginTop: 8, fontSize: 8, color: C.textMute, letterSpacing: 0.8 }}>
                  SOURCE · Dallas Fed · <span style={{ color: C.cyan }}>WEI</span> · weekly · BEA · <span style={{ color: C.amber }}>Real GDP YoY</span> · quarterly · via FRED
                </div>
              </>
            ) : chartMode === "LEADING" ? (
              <>
                {/* LEADING chart legend + range selector row */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, marginTop: 4 }}>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 14, fontSize: 8, letterSpacing: 1 }}>
                    <Legend color={C.white}   label="USMLEI"          value={latestUsmleiRow?.usmlei != null ? latestUsmleiRow.usmlei.toFixed(2) : "—"} bold />
                    <Legend color={C.cyan}    label="WEEKLY AVG"      value={latestRaWeekly?.avg != null ? latestRaWeekly.avg.toFixed(2) : "—"} />
                    <Legend color={C.amber}   label="%G20 RISING +8M"     value={latestUsmleiRow?.pct_g20_rising != null ? `${latestUsmleiRow.pct_g20_rising.toFixed(1)}%` : "—"} bold />
                    <Legend color={C.magenta} label="%CBANK CUTTERS +12M" value={latestUsmleiRow?.cb_net_cutters != null ? `${latestUsmleiRow.cb_net_cutters.toFixed(1)}%` : "—"} bold />
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 8, color: C.textMute, letterSpacing: 1 }}>RANGE</span>
                    {["5Y", "10Y", "MAX"].map((r) => (
                      <button
                        key={r}
                        onClick={() => setLeadingTabRange(r)}
                        style={{
                          fontSize: 8,
                          padding: "2px 7px",
                          color: r === leadingTabRange ? "#000" : C.textDim,
                          background: r === leadingTabRange ? C.amber : "transparent",
                          border: `1px solid ${r === leadingTabRange ? C.amber : C.panelEdgeStrong}`,
                          letterSpacing: 1,
                          cursor: "pointer",
                          borderRadius: 1,
                          fontFamily: FONT_MONO,
                        }}
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                </div>

                {/* LEADING chart — dual y-axes */}
                <div style={{ width: "100%", height: 460 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={leadingTabChartData} margin={{ top: 6, right: 76, left: 0, bottom: 6 }}>
                      <CartesianGrid stroke={C.panelEdge} strokeDasharray="2 4" vertical={false} />
                      <XAxis
                        dataKey="label"
                        ticks={leadingTabMonthTicks}
                        tick={{ fill: C.textDim, fontSize: 8, fontFamily: FONT_MONO }}
                        axisLine={{ stroke: C.panelEdge }}
                        tickLine={false}
                      />
                      {/* LEFT axis (outer) — USMLEI + AVG (composite indices)
                          Fixed bounds [-100, 80] for visual stability. */}
                      <YAxis
                        yAxisId="left"
                        orientation="left"
                        domain={leadingTabLeftDomain}
                        tick={{ fill: C.textDim, fontSize: 8, fontFamily: FONT_MONO }}
                        axisLine={{ stroke: C.panelEdge }}
                        tickLine={false}
                        width={36}
                      />
                      {/* RIGHT axis (inner) — %G20 RISING
                          Auto-zoomed; tick labels in amber to match line color. */}
                      <YAxis
                        yAxisId="g20"
                        orientation="right"
                        domain={leadingTabG20Domain}
                        tick={{ fill: C.amber, fontSize: 8, fontFamily: FONT_MONO }}
                        axisLine={{ stroke: C.amber, strokeOpacity: 0.4 }}
                        tickLine={false}
                        width={32}
                        tickFormatter={(v) => `${v}%`}
                      />
                      {/* RIGHT axis (outer) — %CBANK CUTTERS
                          Auto-zoomed; tick labels in magenta to match line color. */}
                      <YAxis
                        yAxisId="cbank"
                        orientation="right"
                        domain={leadingTabCbankDomain}
                        tick={{ fill: C.magenta, fontSize: 8, fontFamily: FONT_MONO }}
                        axisLine={{ stroke: C.magenta, strokeOpacity: 0.4 }}
                        tickLine={false}
                        width={32}
                        tickFormatter={(v) => `${v}%`}
                      />
                      <ReferenceLine yAxisId="left" y={0} stroke={C.textMute} strokeWidth={0.5} />
                      <Tooltip
                        contentStyle={{
                          background: "#000",
                          border: `1px solid ${C.amber}`,
                          fontFamily: FONT_MONO,
                          fontSize: 9,
                          borderRadius: 2,
                        }}
                        labelStyle={{ color: C.amber, marginBottom: 4 }}
                        itemStyle={{ padding: "1px 0" }}
                      />

                      {/* USMLEI — white smooth (left axis) */}
                      <Line
                        yAxisId="left"
                        type="monotone"
                        dataKey="usmlei"
                        stroke={C.white}
                        strokeWidth={1.6}
                        dot={false}
                        connectNulls
                        isAnimationActive={false}
                      />
                      {/* Weekly AVG — cyan thinner (left axis) */}
                      <Line
                        yAxisId="left"
                        type="monotone"
                        dataKey="avg"
                        stroke={C.cyan}
                        strokeWidth={1.0}
                        dot={false}
                        connectNulls
                        isAnimationActive={false}
                      />
                      {/* %G20 rising — amber stepped (its own auto-zoom right axis) */}
                      <Line
                        yAxisId="g20"
                        type="stepAfter"
                        dataKey="pct_g20_rising"
                        stroke={C.amber}
                        strokeWidth={1.8}
                        dot={false}
                        connectNulls
                        isAnimationActive={false}
                      />
                      {/* %CBANK — magenta stepped (its own auto-zoom right axis) */}
                      <Line
                        yAxisId="cbank"
                        type="stepAfter"
                        dataKey="cb_net_cutters"
                        stroke={C.magenta}
                        strokeWidth={1.8}
                        dot={false}
                        connectNulls
                        isAnimationActive={false}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>

                {/* Source footer */}
                <div style={{ marginTop: 8, fontSize: 8, color: C.textMute, letterSpacing: 0.8 }}>
                  SOURCE · RecessionAlert · <span style={{ color: C.white }}>USMLEI</span> · <span style={{ color: C.cyan }}>weekly AVG</span> · OECD <span style={{ color: C.amber }}>%G20 (+8mo lead)</span> · <span style={{ color: C.magenta }}>%CBANK (+12mo lead)</span> · monthly + weekly
                </div>
              </>
            ) : (
              <>
                {/* Component legend */}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginBottom: 8, fontSize: 8, letterSpacing: 1 }}>
                  <Legend color={C.white} label="ATL GDPNOW" value={latestG.total != null ? latestG.total.toFixed(3) : "—"} bold />
                  <Legend color={C.magenta} label="NY FED NOWCAST" value={data.current.nyNowcast != null ? data.current.nyNowcast.toFixed(3) : "—"} bold />
                  <Legend color={C.pceGoods} label="PCE GOODS" value={latestG.pceGoods != null ? latestG.pceGoods.toFixed(3) : "—"} />
                  <Legend color={C.pceServices} label="PCE SERVICES" value={latestG.pceServices != null ? latestG.pceServices.toFixed(3) : "—"} />
                  <Legend color={C.fixedInv} label="FIXED INV" value={latestG.fixedInv != null ? latestG.fixedInv.toFixed(3) : "—"} />
                  <Legend color={C.govt} label="GOVT" value={latestG.govt != null ? latestG.govt.toFixed(3) : "—"} />
                  <Legend color={C.netExports} label="NET EXPORTS" value={latestG.netExports != null ? latestG.netExports.toFixed(3) : "—"} />
                  <Legend color={C.inventories} label="INVENTORIES" value={latestG.inventories != null ? latestG.inventories.toFixed(3) : "—"} />
                </div>

                <div style={{ width: "100%", height: 460 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={gdpNowFiltered} margin={{ top: 6, right: 30, left: 0, bottom: 6 }} stackOffset="sign">
                      <CartesianGrid stroke={C.grid} vertical={false} />
                      <XAxis
                        dataKey="label"
                        ticks={monthTicks}
                        tick={{ fill: C.textDim, fontSize: 8, fontFamily: FONT_MONO }}
                        axisLine={{ stroke: C.panelEdge }}
                        tickLine={false}
                      />
                      <YAxis
                        domain={yDomain}
                        tick={{ fill: C.textDim, fontSize: 8, fontFamily: FONT_MONO }}
                        axisLine={{ stroke: C.panelEdge }}
                        tickLine={false}
                        width={36}
                      />
                      <ReferenceLine y={0} stroke={C.textMute} strokeWidth={0.5} />
                      {currentQtrStart && (
                        <ReferenceLine
                          x={currentQtrStart}
                          stroke={C.amber}
                          strokeDasharray="2 3"
                          strokeWidth={0.6}
                          label={{
                            value: "CURRENT Q",
                            position: "insideTopRight",
                            fill: C.amber,
                            fontSize: 8,
                            fontFamily: FONT_MONO,
                            letterSpacing: 1,
                          }}
                        />
                      )}
                      <Tooltip
                        contentStyle={{
                          background: "#000",
                          border: `1px solid ${C.amber}`,
                          fontFamily: FONT_MONO,
                          fontSize: 9,
                          borderRadius: 2,
                        }}
                        labelStyle={{ color: C.amber, marginBottom: 4 }}
                        itemStyle={{ padding: "1px 0" }}
                      />
                      <Bar dataKey="pceGoods"    stackId="s" fill={C.pceGoods}    isAnimationActive={false} />
                      <Bar dataKey="pceServices" stackId="s" fill={C.pceServices} isAnimationActive={false} />
                      <Bar dataKey="fixedInv"    stackId="s" fill={C.fixedInv}    isAnimationActive={false} />
                      <Bar dataKey="govt"        stackId="s" fill={C.govt}        isAnimationActive={false} />
                      <Bar dataKey="netExports"  stackId="s" fill={C.netExports}  isAnimationActive={false} />
                      <Bar dataKey="inventories" stackId="s" fill={C.inventories} isAnimationActive={false} />
                      <Line type="monotone" dataKey="total" stroke={C.white} strokeWidth={1.6} dot={false} isAnimationActive={false} />
                      {/* NY Fed actual observations — solid magenta. */}
                      <Line
                        type="stepAfter"
                        dataKey="nyReal"
                        stroke={C.magenta}
                        strokeWidth={2.2}
                        dot={false}
                        connectNulls
                        isAnimationActive={false}
                      />
                      {/* NY Fed forward-fill segment — dashed, same color and weight,
                          indicates "last known value, no release since". */}
                      <Line
                        type="stepAfter"
                        dataKey="nyFilled"
                        stroke={C.magenta}
                        strokeWidth={2.2}
                        strokeDasharray="3 3"
                        dot={false}
                        connectNulls
                        isAnimationActive={false}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </>
            )}
          </Panel>

          {/* Recent contributions table — only relevant for NOWCAST (Atlanta GDPNow) */}
          {chartMode === "NOWCAST" && (
            <Panel>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, paddingBottom: 8, borderBottom: `1px solid ${C.panelEdge}` }}>
                <div style={{ fontSize: 10, letterSpacing: 1.4, color: C.text }}>
                  COMPONENT CONTRIBUTIONS · LAST 8 OBS
                </div>
                <div style={{ fontSize: 8, color: C.textMute, letterSpacing: 1 }}>
                  pp contribution to annualized %
                </div>
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 9 }}>
                <thead>
                  <tr style={{ color: C.textDim, letterSpacing: 1, textAlign: "right" }}>
                    <th style={{ padding: "6px 8px", borderBottom: `1px solid ${C.panelEdge}`, fontWeight: 500, textAlign: "left" }}>DATE</th>
                    <th style={{ padding: "6px 8px", borderBottom: `1px solid ${C.panelEdge}`, fontWeight: 500 }}>GDPNOW</th>
                    <th style={{ padding: "6px 8px", borderBottom: `1px solid ${C.panelEdge}`, fontWeight: 500 }}>PCE·G</th>
                    <th style={{ padding: "6px 8px", borderBottom: `1px solid ${C.panelEdge}`, fontWeight: 500 }}>PCE·S</th>
                    <th style={{ padding: "6px 8px", borderBottom: `1px solid ${C.panelEdge}`, fontWeight: 500 }}>FIX INV</th>
                    <th style={{ padding: "6px 8px", borderBottom: `1px solid ${C.panelEdge}`, fontWeight: 500 }}>GOVT</th>
                    <th style={{ padding: "6px 8px", borderBottom: `1px solid ${C.panelEdge}`, fontWeight: 500 }}>NET XP</th>
                    <th style={{ padding: "6px 8px", borderBottom: `1px solid ${C.panelEdge}`, fontWeight: 500 }}>INVT</th>
                  </tr>
                </thead>
                <tbody>
                  {tableRows.map((r, idx) => (
                    <tr key={idx} style={{ background: idx === 0 ? C.amberFaint : "transparent" }}>
                      <td style={{ padding: "5px 8px", color: idx === 0 ? C.amber : C.text }}>{r.label}</td>
                      <Cell v={r.total}        bold highlight={idx === 0} />
                      <Cell v={r.pceGoods}     />
                      <Cell v={r.pceServices}  />
                      <Cell v={r.fixedInv}     />
                      <Cell v={r.govt}         />
                      <Cell v={r.netExports}   />
                      <Cell v={r.inventories}  />
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ fontSize: 8, color: C.textMute, marginTop: 10, letterSpacing: 0.5 }}>
                SOURCE · Atlanta Fed · <span style={{ color: C.cyan }}>GDPTrackingModelDataAndForecasts.xlsx</span> · TrackingArchives + CurrentQtrEvolution + ContribHistory · daily
              </div>
            </Panel>
          )}
        </div>

        {/* ================================================================ */}
        {/* RIGHT — REGIME MODEL                                              */}
        {/* ================================================================ */}
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <span style={{ fontSize: 14, color: C.text, letterSpacing: 2, fontWeight: 600 }}>REGIME MODEL</span>
          </div>

          {/* Mode pills */}
          <div style={{ display: "flex", gap: 4, marginBottom: 14 }}>
            <Pill active={modelMode === "COINCIDENT"} onClick={() => setModelMode("COINCIDENT")}>COINCIDENT</Pill>
            <Pill active={modelMode === "LEADING"}    onClick={() => setModelMode("LEADING")}>LEADING</Pill>
            <Pill active={modelMode === "COMPOSITE"}  onClick={() => setModelMode("COMPOSITE")}>COMPOSITE</Pill>
            <Pill active={modelMode === "QUADRANT"}   onClick={() => setModelMode("QUADRANT")}>QUADRANT</Pill>
          </div>

          {/* Latest summary */}
          <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginBottom: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 9, color: C.textDim, letterSpacing: 1.2 }}>LATEST: <span style={{ color: C.text }}>2026-04-28</span></span>
            <span style={{ fontSize: 9, color: C.textDim, letterSpacing: 1.2 }}>
              REGIME: <span style={{ color: hedgeColor, fontWeight: 700 }}>{regime.level} · {regime.direction}</span>
            </span>
            <span style={{ fontSize: 9, color: C.textDim, letterSpacing: 1.2 }}>
              HEDGE: <span style={{ color: hedgeColor, fontWeight: 700 }}>{hedge.ratio == null ? "—" : `${hedge.ratio}%`}</span>
            </span>
          </div>

          {/* Composite chart */}
          <div style={{ background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 4, padding: 16, marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, paddingBottom: 8, borderBottom: `1px solid ${C.panelEdge}` }}>
              <span style={{ fontSize: 10, color: C.text, letterSpacing: 1.2 }}>
                {modelMode === "LEADING" ? "AVG Z·SCORE (5Y)"
                  : modelMode === "COINCIDENT" ? "WEI Z·SCORE (5Y)"
                  : modelMode === "QUADRANT" ? "QUADRANT"
                  : "COMPOSITE Z·SCORE (5Y)"}
              </span>
              <div style={{ display: "flex", gap: 12, fontSize: 8, color: C.textDim, letterSpacing: 1, alignItems: "center" }}>
                {(modelMode === "COINCIDENT" || modelMode === "COMPOSITE") && (
                  <span><span style={{ color: C.cyan }}>━</span> COINC {latestWeiZ == null ? "—" : (latestWeiZ >= 0 ? "+" : "") + latestWeiZ.toFixed(2)}</span>
                )}
                {(modelMode === "LEADING" || modelMode === "COMPOSITE") && (
                  <span><span style={{ color: leadAvail ? C.amber : C.textMute }}>━</span> LEAD {(!leadAvail || latestAvgZ == null) ? "—" : (latestAvgZ >= 0 ? "+" : "") + latestAvgZ.toFixed(2)}</span>
                )}
                {modelMode === "QUADRANT" && (() => {
                  const qColor = currentQuadrant === "ACCELERATING" ? C.green
                              : currentQuadrant === "SLOWING" ? C.amber
                              : currentQuadrant === "CONTRACTION" ? C.magenta
                              : currentQuadrant === "RECOVERY" ? C.cyan
                              : C.textMute;
                  return (
                    <>
                      <span>LEAD {latestLeadZQuadrant == null ? "—" : (latestLeadZQuadrant >= 0 ? "+" : "") + latestLeadZQuadrant.toFixed(2)}</span>
                      <span>COINC {latestCoincZQuadrant == null ? "—" : (latestCoincZQuadrant >= 0 ? "+" : "") + latestCoincZQuadrant.toFixed(2)}</span>
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <span style={{ fontSize: 7, color: C.textMute, letterSpacing: 1, marginRight: 2 }}>ZOOM</span>
                        {["FULL", "TIGHT", "AUTO"].map((r) => (
                          <button
                            key={r}
                            onClick={() => setQuadrantRange(r)}
                            style={{
                              fontSize: 7,
                              padding: "2px 6px",
                              color: r === quadrantRange ? "#000" : C.textDim,
                              background: r === quadrantRange ? C.amber : "transparent",
                              border: `1px solid ${r === quadrantRange ? C.amber : C.panelEdgeStrong}`,
                              letterSpacing: 1,
                              cursor: "pointer",
                              borderRadius: 1,
                              fontFamily: FONT_MONO,
                            }}
                          >
                            {r}
                          </button>
                        ))}
                      </span>
                      <span style={{
                        fontSize: 9, letterSpacing: 1.4, padding: "2px 8px",
                        background: currentQuadrant ? qColor : "transparent",
                        color: currentQuadrant ? "#000" : C.textDim,
                        border: `1px solid ${qColor}`,
                        borderRadius: 1, fontFamily: FONT_MONO, fontWeight: 700,
                      }}>{currentQuadrant || "—"}</span>
                    </>
                  );
                })()}
              </div>
            </div>
            {modelMode !== "QUADRANT" && (
              <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 6, marginBottom: 8 }}>
                <span style={{ fontSize: 8, color: C.textMute, letterSpacing: 1 }}>RANGE</span>
                {["6M", "1Y", "5Y", "10Y", "MAX"].map((r) => (
                  <button
                    key={r}
                    onClick={() => setRegimeRange(r)}
                    style={{
                      fontSize: 8,
                      padding: "2px 7px",
                      color: r === regimeRange ? "#000" : C.textDim,
                      background: r === regimeRange ? C.amber : "transparent",
                      border: `1px solid ${r === regimeRange ? C.amber : C.panelEdgeStrong}`,
                      letterSpacing: 1,
                      cursor: "pointer",
                      borderRadius: 1,
                      fontFamily: FONT_MONO,
                    }}
                  >
                    {r}
                  </button>
                ))}
              </div>
            )}
            {modelMode === "QUADRANT" ? (() => {
              const qColor = currentQuadrant === "ACCELERATING" ? C.green
                          : currentQuadrant === "SLOWING" ? C.amber
                          : currentQuadrant === "CONTRACTION" ? C.magenta
                          : currentQuadrant === "RECOVERY" ? C.cyan
                          : C.text;
              const trajWithOpacity = quadrantTrajectory.slice(0, -1).map((p, i, arr) => ({
                ...p,
                opacity: 0.2 + (0.6 * i / Math.max(arr.length - 1, 1)),
              }));

              // QUADRANT axis domain — driven by quadrantRange selector.
              // Symmetric across both axes so quadrant structure (zero lines
              // equidistant from edges) remains intuitive.
              const quadrantDomain = (() => {
                if (quadrantRange === "FULL") return [-3, 3];
                if (quadrantRange === "TIGHT") return [-1.5, 1.5];
                if (!quadrantTrajectory.length) return [-3, 3];
                let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
                for (const p of quadrantTrajectory) {
                  if (p.lead_z < xMin) xMin = p.lead_z;
                  if (p.lead_z > xMax) xMax = p.lead_z;
                  if (p.coinc_z < yMin) yMin = p.coinc_z;
                  if (p.coinc_z > yMax) yMax = p.coinc_z;
                }
                const absMax = Math.max(Math.abs(xMin), Math.abs(xMax), Math.abs(yMin), Math.abs(yMax));
                const padded = Math.max(0.3, absMax + 0.3);
                return [-padded, padded];
              })();

              return (
                <div style={{ width: "100%", height: 320, position: "relative" }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart margin={{ top: 12, right: 18, left: 4, bottom: 18 }}>
                      <CartesianGrid stroke={C.panelEdge} strokeDasharray="2 4" />
                      <XAxis
                        type="number"
                        dataKey="lead_z"
                        domain={quadrantDomain}
                        tick={{ fill: C.textDim, fontSize: 8, fontFamily: FONT_MONO }}
                        axisLine={{ stroke: C.panelEdge }}
                        tickLine={false}
                        label={{ value: "LEAD Z", position: "insideBottom", offset: -8,
                          style: { fill: C.textMute, fontSize: 8, fontFamily: FONT_MONO, letterSpacing: 1 } }}
                      />
                      <YAxis
                        type="number"
                        dataKey="coinc_z"
                        domain={quadrantDomain}
                        tick={{ fill: C.textDim, fontSize: 8, fontFamily: FONT_MONO }}
                        axisLine={{ stroke: C.panelEdge }}
                        tickLine={false}
                        width={28}
                        label={{ value: "COINC Z", angle: -90, position: "insideLeft",
                          style: { fill: C.textMute, fontSize: 8, fontFamily: FONT_MONO, letterSpacing: 1 } }}
                      />
                      <ReferenceLine x={0} stroke={C.textMute} strokeWidth={0.8} />
                      <ReferenceLine y={0} stroke={C.textMute} strokeWidth={0.8} />

                      {/* Hover tooltip — shows date + values + quadrant for hovered point */}
                      <Tooltip
                        cursor={{ stroke: C.text, strokeWidth: 0.5, strokeDasharray: "2 2" }}
                        content={(tProps) => {
                          if (!tProps.active || !tProps.payload || !tProps.payload.length) return null;
                          const pt = tProps.payload[0].payload;
                          if (!pt || pt.lead_z == null || pt.coinc_z == null) return null;
                          const dateStr = pt.date instanceof Date
                            ? pt.date.toLocaleDateString("en-US", { year: "numeric", month: "short" })
                            : new Date(pt.date).toLocaleDateString("en-US", { year: "numeric", month: "short" });
                          const qClass = pt.lead_z >= 0 && pt.coinc_z >= 0 ? "ACCELERATING"
                                       : pt.lead_z < 0 && pt.coinc_z >= 0 ? "SLOWING"
                                       : pt.lead_z < 0 && pt.coinc_z < 0  ? "CONTRACTION"
                                       : pt.lead_z >= 0 && pt.coinc_z < 0 ? "RECOVERY"
                                       : "—";
                          const qCol = qClass === "ACCELERATING" ? C.green
                                     : qClass === "SLOWING" ? C.amber
                                     : qClass === "CONTRACTION" ? C.magenta
                                     : qClass === "RECOVERY" ? C.cyan
                                     : C.text;
                          return (
                            <div style={{
                              background: C.bg,
                              border: `1px solid ${C.panelEdgeStrong}`,
                              padding: "4px 8px",
                              fontSize: 8,
                              fontFamily: FONT_MONO,
                              letterSpacing: 1,
                              color: C.text,
                            }}>
                              <span style={{ color: C.textMute }}>{dateStr}</span>
                              <span style={{ marginLeft: 8 }}>LEAD {pt.lead_z >= 0 ? "+" : ""}{pt.lead_z.toFixed(2)}</span>
                              <span style={{ marginLeft: 8 }}>COINC {pt.coinc_z >= 0 ? "+" : ""}{pt.coinc_z.toFixed(2)}</span>
                              <span style={{ marginLeft: 8, color: qCol, fontWeight: 700 }}>{qClass}</span>
                            </div>
                          );
                        }}
                      />

                      {/* Trajectory line — connects all 12 points in chronological order */}
                      <Line
                        data={quadrantTrajectory}
                        type="linear"
                        dataKey="coinc_z"
                        stroke={C.text}
                        strokeWidth={1}
                        strokeOpacity={0.35}
                        dot={false}
                        connectNulls
                        isAnimationActive={false}
                      />

                      {/* Trajectory dots (excluding current) with opacity fade */}
                      <Scatter
                        data={trajWithOpacity}
                        shape={(props) => {
                          const { cx, cy, payload } = props;
                          return (
                            <circle cx={cx} cy={cy} r={2.5} fill={C.text}
                              fillOpacity={payload.opacity} stroke="none" />
                          );
                        }}
                        isAnimationActive={false}
                      />

                      {/* Current point — large dot with quadrant-colored ring */}
                      <Scatter
                        data={quadrantTrajectory.slice(-1)}
                        shape={(props) => {
                          const { cx, cy } = props;
                          return (
                            <g>
                              <circle cx={cx} cy={cy} r={7} fill="none" stroke={qColor} strokeWidth={1.5} />
                              <circle cx={cx} cy={cy} r={4} fill={qColor} />
                            </g>
                          );
                        }}
                        isAnimationActive={false}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>

                  {/* Quadrant label overlays */}
                  <div style={{ position: "absolute", top: 18, right: 22, fontSize: 8, color: C.green,   opacity: 0.55, letterSpacing: 1.4, fontFamily: FONT_MONO, pointerEvents: "none" }}>ACCELERATING</div>
                  <div style={{ position: "absolute", top: 18, left: 38, fontSize: 8, color: C.amber,   opacity: 0.55, letterSpacing: 1.4, fontFamily: FONT_MONO, pointerEvents: "none" }}>SLOWING</div>
                  <div style={{ position: "absolute", bottom: 36, left: 38, fontSize: 8, color: C.magenta, opacity: 0.55, letterSpacing: 1.4, fontFamily: FONT_MONO, pointerEvents: "none" }}>CONTRACTION</div>
                  <div style={{ position: "absolute", bottom: 36, right: 22, fontSize: 8, color: C.cyan,  opacity: 0.55, letterSpacing: 1.4, fontFamily: FONT_MONO, pointerEvents: "none" }}>RECOVERY</div>
                </div>
              );
            })() : (
              <div style={{ height: 200 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={regimePanelData} margin={{ top: 6, right: 14, left: 0, bottom: 4 }}>
                    <CartesianGrid stroke={C.grid} vertical={false} />
                    <XAxis
                      dataKey="label"
                      ticks={regimePanelTicks}
                      tick={{ fill: C.textDim, fontSize: 8, fontFamily: FONT_MONO }}
                      axisLine={{ stroke: C.panelEdge }}
                      tickLine={false}
                    />
                    <YAxis
                      domain={[-2.5, 2.5]}
                      tick={{ fill: C.textDim, fontSize: 8, fontFamily: FONT_MONO }}
                      axisLine={{ stroke: C.panelEdge }}
                      tickLine={false}
                      width={28}
                    />
                    <ReferenceArea y1={0.5}  y2={2.5}  fill={C.green} fillOpacity={0.04} />
                    <ReferenceArea y1={-0.5} y2={-2.5} fill={C.red}   fillOpacity={0.04} />
                    <ReferenceLine y={0.5}  stroke={C.green} strokeDasharray="2 4" strokeWidth={0.5} />
                    <ReferenceLine y={-0.5} stroke={C.red}   strokeDasharray="2 4" strokeWidth={0.5} />
                    <ReferenceLine y={0}    stroke={C.textMute} strokeWidth={0.5} />
                    <Tooltip
                      contentStyle={{
                        background: "#000",
                        border: `1px solid ${C.amber}`,
                        fontFamily: FONT_MONO,
                        fontSize: 9,
                        borderRadius: 2,
                      }}
                      labelStyle={{ color: C.amber }}
                    />
                    {(modelMode === "COINCIDENT" || modelMode === "COMPOSITE") && (
                      <Line
                        type="monotone"
                        dataKey="wei_z"
                        stroke={C.cyan}
                        strokeWidth={1.6}
                        dot={false}
                        connectNulls
                        isAnimationActive={false}
                      />
                    )}
                    {(modelMode === "LEADING" || modelMode === "COMPOSITE") && (
                      <Line
                        type="monotone"
                        dataKey="avg_z"
                        stroke={C.amber}
                        strokeWidth={1.6}
                        strokeDasharray={modelMode === "COMPOSITE" ? "2 3" : undefined}
                        dot={false}
                        connectNulls
                        isAnimationActive={false}
                      />
                    )}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}
            {modelMode === "QUADRANT" ? (
              <div style={{ marginTop: 6, fontSize: 8, color: C.textMute, letterSpacing: 0.8 }}>
                SOURCE · LEAD: <span style={{ color: C.text }}>RA AVG</span> 5Y-z · COINC: <span style={{ color: C.text }}>WEI</span> 5Y-z · trajectory = last 12 monthly samples
              </div>
            ) : (
              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 8, color: C.textMute, letterSpacing: 0.8 }}>
                <span>HIGH +0.5</span>
                <span>NORMAL band</span>
                <span>LOW -0.5</span>
              </div>
            )}
          </div>

          {/* Key indicators */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 10, color: C.textDim, letterSpacing: 1.4, marginBottom: 6 }}>KEY INDICATORS</div>
            <KVRow label="ATL GDPNOW"    value={latestG.total != null ? `${latestG.total.toFixed(2)}%` : "—"} valueColor={latestG.total != null && latestG.total >= 1 ? C.green : C.red} sub="Atlanta Fed · daily" />
            <KVRow label="NY FED"        value={data.current.nyNowcast != null ? `${data.current.nyNowcast.toFixed(2)}%` : "—"} valueColor={data.current.nyNowcast != null && data.current.nyNowcast >= 1 ? C.green : C.red} sub={`NY Fed · weekly · ${data.current.nyTargetQtr ?? ""}`} />
            <KVRow label="DALLAS WEI"    value={fmtNum(data.current.wei, 2)}  valueColor={C.green} sub="weekly · Dallas Fed" />
            <KVRow label="UNCTAD WORLD"  value={fmtNum(data.current.unctadWorld, 2, "%")} valueColor={C.green} sub="manual · weekly append" />
            <KVRow label="RA WLA"        value={fmtNum(data.current.wla, 2)}   valueColor={leadAvail ? C.amber : C.textMute} sub={leadAvail ? "weekly · RecessionAlert" : "drop xlsx in data/recessionalert/raw/"} />
            <KVRow label="GLOBAL LEI +8M" value={fmtNum(data.current.globalLei8m, 2)} valueColor={leadAvail ? C.amber : C.textMute} sub={leadAvail ? "monthly · forward window" : "drop xlsx in data/recessionalert/raw/"} />
          </div>

          {/* Regime block */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 10, color: C.textDim, letterSpacing: 1.4, marginBottom: 6 }}>REGIME STATE</div>
            <KVRow label="LEVEL"     value={regime.level}     valueColor={hedgeColor} />
            <KVRow label="DIRECTION" value={regime.direction} valueColor={hedgeColor} />
            <KVRow label="HEDGE"     value={hedge.ratio == null ? "—" : `${hedge.ratio}%`} valueColor={hedgeColor} sub={hedge.posture} />
          </div>

          {/* Quadrant inset */}
          <div style={{ background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 4, padding: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, paddingBottom: 8, borderBottom: `1px solid ${C.panelEdge}` }}>
              <span style={{ fontSize: 10, color: C.text, letterSpacing: 1.2 }}>QUADRANT</span>
              <span style={{ fontSize: 8, color: C.textMute, letterSpacing: 1 }}>COINC × LEAD</span>
            </div>
            <Quadrant coincZ={latest.coinc ?? 0} leadZ={leadAvail ? (latest.lead ?? 0) : 0} />
          </div>
        </div>
      </div>

      {/* Bottom note bar */}
      <div style={{ margin: "16px 16px 0", padding: "8px 0", borderTop: `1px solid ${C.panelEdge}`, fontSize: 9, color: C.textDim, letterSpacing: 1, display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <span>SMALLFISHMACRO · MACRO REGIME › GROWTH · live data · {data.signalAvailability.leading ? "full signal" : "partial signal (leading absent)"}</span>
        <span>Z-SCORES vs 10y rolling history · dir = 8w Δ · click <span style={{ color: C.cyan }}>CONNECT</span> to wire live feeds</span>
      </div>
    </div>
  );
}

// ========================================================================
// SMALL HELPERS
// ========================================================================
const Legend = ({ color, label, value, bold, dashed }) => (
  <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
    {dashed ? (
      <span style={{ width: 12, height: 0, borderTop: `2px dashed ${color}`, display: "inline-block" }} />
    ) : (
      <span style={{ width: 8, height: 8, background: color, display: "inline-block" }} />
    )}
    <span style={{ color: C.textDim, letterSpacing: 1 }}>{label}</span>
    <span style={{ color: C.text, fontWeight: bold ? 700 : 500 }}>{value}</span>
  </span>
);

const Cell = ({ v, bold, highlight }) => {
  const color = v > 0.05 ? C.green : v < -0.05 ? C.red : C.text;
  // Heatmap intensity background
  const intensity = Math.min(0.18, Math.abs(v) * 0.06);
  const bg = v > 0.05 ? `rgba(34,197,94,${intensity})`
           : v < -0.05 ? `rgba(239,68,68,${intensity})`
           : "transparent";
  return (
    <td
      style={{
        padding: "5px 8px",
        textAlign: "right",
        color: highlight ? C.amber : color,
        fontWeight: bold ? 700 : 500,
        background: highlight ? "transparent" : bg,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {v >= 0 ? "+" : ""}{v.toFixed(3)}
    </td>
  );
};

const Quadrant = ({ coincZ, leadZ }) => {
  const x = ((coincZ + 2.5) / 5) * 100;
  const y = (1 - (leadZ + 2.5) / 5) * 100;
  return (
    <div style={{ position: "relative", width: "100%", aspectRatio: "1.4" }}>
      <svg viewBox="0 0 100 70" preserveAspectRatio="none" width="100%" height="100%">
        <rect x="0"  y="0"  width="50" height="35" fill="#13110a" />
        <rect x="50" y="0"  width="50" height="35" fill="#0a130d" />
        <rect x="0"  y="35" width="50" height="35" fill="#130a0a" />
        <rect x="50" y="35" width="50" height="35" fill="#13100a" />
        <line x1="50" y1="0" x2="50" y2="70" stroke={C.panelEdgeStrong} strokeWidth="0.3" />
        <line x1="0" y1="35" x2="100" y2="35" stroke={C.panelEdgeStrong} strokeWidth="0.3" />
        {/* threshold lines at z = ±0.5 (mapped to 0.5/2.5 = 10% from center)*/}
        <line x1="40" y1="0" x2="40" y2="70" stroke={C.textMute} strokeWidth="0.2" strokeDasharray="0.6 0.6" />
        <line x1="60" y1="0" x2="60" y2="70" stroke={C.textMute} strokeWidth="0.2" strokeDasharray="0.6 0.6" />
        <circle cx={x} cy={y * 0.7} r="2" fill={C.amber} />
        <circle cx={x} cy={y * 0.7} r="4" fill="none" stroke={C.amber} strokeWidth="0.3" opacity="0.5" />
      </svg>
      <div style={{ position: "absolute", top: 4, left: 6, fontSize: 7, color: C.textDim, letterSpacing: 0.6 }}>LOW · ACCEL</div>
      <div style={{ position: "absolute", top: 4, right: 6, fontSize: 7, color: C.textDim, letterSpacing: 0.6 }}>HIGH · ACCEL</div>
      <div style={{ position: "absolute", bottom: 4, left: 6, fontSize: 7, color: C.textDim, letterSpacing: 0.6 }}>LOW · SLOW</div>
      <div style={{ position: "absolute", bottom: 4, right: 6, fontSize: 7, color: C.textDim, letterSpacing: 0.6 }}>HIGH · SLOW</div>
    </div>
  );
};
