import React, { useEffect, useMemo, useState } from "react";
import {
  ComposedChart,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  ReferenceArea,
  Brush,
} from "recharts";
import { C, FONT_MONO, Panel, Pill, StatTile, Legend } from "../design-system";

// ========================================================================
// DATA LAYER — fetch + normalize /data/equity_regime.json
// ========================================================================
// Producer (market-dashboard/equity_regime_updater.py) was patched 2026-05-29
// to emit valid JSON (null instead of NaN), so a plain .json() works now.
// Local dev uses public/data/equity_regime.json (fast, gitignored copy).
// Production fetches directly from the market-dashboard repo's raw URL —
// single source of truth, always reflects the daily pipeline output.
const EQUITY_REGIME_URL = import.meta.env.DEV
  ? "/data/equity_regime.json"
  : "https://raw.githubusercontent.com/smallfishmacro-Git/market-dashboard/main/data/datasets/equity_regime.json";

function useEquityRegimeData() {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  useEffect(() => {
    let cancelled = false;
    fetch(EQUITY_REGIME_URL, { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${EQUITY_REGIME_URL}`);
        return r.json();
      })
      .then((raw) => {
        if (cancelled) return;
        const labelFmt = (d) =>
          d.toLocaleDateString("en-US", { month: "short", year: "2-digit" })
            .replace(/(\w{3}) (\d{2})/, "$1 '$2");
        const series = (raw.series || []).map((d) => {
          const dateObj = new Date(d.date);
          return { ...d, dateObj, label: labelFmt(dateObj) };
        });
        const composite = (raw.composite || []).map((d) => {
          const dateObj = new Date(d.date);
          return { ...d, dateObj, label: labelFmt(dateObj) };
        });
        setState({ loading: false, error: null, data: { ...raw, series, composite } });
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
// CONSTANTS / HELPERS
// ========================================================================
// US NBER-dated recessions overlaid on full-series charts. Translated to the
// closest matching `label` values in the loaded series so it works with the
// category XAxis used everywhere here.
const RECESSIONS = [
  { x1: "2007-12-01", x2: "2009-06-30" },  // GFC
  { x1: "2020-02-01", x2: "2020-04-30" },  // COVID
];

// Hero-chart range filter — ms-window anchored to "now" (real wall clock).
const ONE_YEAR_MS  = 365 * 24 * 60 * 60 * 1000;
const FIVE_YEAR_MS = 5 * ONE_YEAR_MS;
const TEN_YEAR_MS  = 10 * ONE_YEAR_MS;

function recessionBandsForSeries(series) {
  if (!series.length) return [];
  return RECESSIONS.map(({ x1, x2 }) => {
    const d1 = new Date(x1).getTime();
    const d2 = new Date(x2).getTime();
    // l1/l2 = label-string boundaries (used by charts with a label XAxis).
    // date1/date2 = ISO-date boundaries (used by the hero chart whose XAxis
    // dataKey is `date` — unique per row, so ReferenceArea can position
    // unambiguously, unlike `label` which repeats for rows in the same month).
    let l1 = null, l2 = null, date1 = null, date2 = null;
    for (const r of series) {
      const t = r.dateObj.getTime();
      if (t < d1 || t > d2) continue;
      if (l1 === null) { l1 = r.label; date1 = r.date; }
      l2 = r.label;
      date2 = r.date;
    }
    return { l1, l2, date1, date2 };
  }).filter((b) => b.l1 && b.l2);
}

const regimeColor = (regime) => {
  if (regime === "CONTRACTION" || regime === "WEAKENING") return C.red;
  if (regime === "IMPROVING" || regime === "EARNINGS EXPANSION") return C.green;
  return C.textDim;
};

const scoreColor = (score) => {
  if (score >= 2) return C.green;
  if (score >= 0) return C.amber;
  return C.red;
};

const componentColor = (v) => {
  if (v === 1) return C.green;
  if (v === -1) return C.red;
  return C.textDim;
};

const fmtPct = (v, digits = 2) =>
  v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
const fmtUsd = (v, digits = 2) =>
  v == null ? "—" : `$${v.toFixed(digits)}`;

const PanelTitle = ({ children, sub }) => (
  <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10 }}>
    <span style={{ fontSize: 11, color: C.amber, letterSpacing: 1.5, fontWeight: 600 }}>{children}</span>
    {sub && <span style={{ fontSize: 9, color: C.textDim, letterSpacing: 1 }}>{sub}</span>}
  </div>
);

const tooltipStyle = {
  background: C.panel,
  border: `1px solid ${C.panelEdge}`,
  fontFamily: FONT_MONO,
  fontSize: 10,
};

// ========================================================================
// MAIN
// ========================================================================
export default function EquityTab() {
  const { loading, error, data } = useEquityRegimeData();
  const [equityChartRange, setEquityChartRange] = useState("MAX");

  // ====================================================================
  // HOOKS — all useMemo calls must run before the early returns below.
  // React identifies hooks by call order; placing useMemo after a
  // conditional return breaks Rules of Hooks once data flips loading→loaded.
  // `series` / `composite` are null-safe locals so each memo body can run
  // on the first render (data still null) and short-circuit on empty input.
  // ====================================================================
  const series = data?.series ?? [];
  const composite = data?.composite ?? [];

  const forwardEpsRebased = useMemo(() => {
    if (!series.length) return [];
    const latestDate = series[series.length - 1].dateObj;
    const cutoff = new Date(latestDate);
    cutoff.setMonth(cutoff.getMonth() - 24);
    const window = series.filter((r) => r.dateObj >= cutoff);
    if (!window.length) return [];
    const findFirst = (key) => {
      for (const r of window) if (r[key] != null) return r[key];
      return null;
    };
    const base = {
      eps_cy:  findFirst("eps_cy"),
      eps_ny:  findFirst("eps_ny"),
      eps_q:   findFirst("eps_q"),
      eps_ttm: findFirst("eps_ttm"),
    };
    return window.map((r) => ({
      ...r,
      r_cy:  base.eps_cy  != null && r.eps_cy  != null ? (r.eps_cy  / base.eps_cy)  * 100 : null,
      r_ny:  base.eps_ny  != null && r.eps_ny  != null ? (r.eps_ny  / base.eps_ny)  * 100 : null,
      r_q:   base.eps_q   != null && r.eps_q   != null ? (r.eps_q   / base.eps_q)   * 100 : null,
      r_ttm: base.eps_ttm != null && r.eps_ttm != null ? (r.eps_ttm / base.eps_ttm) * 100 : null,
    }));
  }, [series]);

  // Hero-chart range-filtered slice. Anchors to today's wall clock so "5Y"
  // means "5 years back from now"; as new weekly rows append the window slides.
  const heroData = useMemo(() => {
    if (!series.length) return [];
    const now = Date.now();
    const cutoff = {
      "1Y":  now - ONE_YEAR_MS,
      "5Y":  now - FIVE_YEAR_MS,
      "10Y": now - TEN_YEAR_MS,
      "MAX": 0,
    }[equityChartRange];
    return series.filter((d) => d.dateObj.getTime() >= cutoff);
  }, [series, equityChartRange]);

  // X-axis ticks for the hero chart — derived from heroData (the *filtered*
  // slice). Adaptive: 1Y shows monthly first-of-month rows, longer ranges
  // show yearly first-of-year rows (every other year on MAX to keep the axis
  // legible). Values are ISO date strings to match XAxis dataKey="date".
  const heroDateTicks = useMemo(() => {
    if (!heroData.length) return [];
    const monthly = equityChartRange === "1Y";
    const seen = new Set();
    const firsts = [];
    for (const r of heroData) {
      const k = monthly
        ? `${r.dateObj.getFullYear()}-${r.dateObj.getMonth()}`
        : `${r.dateObj.getFullYear()}`;
      if (!seen.has(k)) { seen.add(k); firsts.push(r); }
    }
    const stride = equityChartRange === "MAX" ? 2 : 1;
    const strided = firsts.filter((_, i) => i % stride === 0);
    if (firsts.length && strided[strided.length - 1] !== firsts[firsts.length - 1]) {
      strided.push(firsts[firsts.length - 1]);
    }
    return strided.map((r) => r.date);
  }, [heroData, equityChartRange]);

  const scoreHistory = useMemo(() => {
    if (!composite.length) return [];
    const months = new Map();
    for (const r of composite) {
      const k = `${r.dateObj.getFullYear()}-${String(r.dateObj.getMonth() + 1).padStart(2, "0")}`;
      const prev = months.get(k);
      if (!prev || r.dateObj > prev.dateObj) months.set(k, r);
    }
    return Array.from(months.values()).sort((a, b) => a.dateObj - b.dateObj).slice(-24);
  }, [composite]);

  const recessionBands = useMemo(() => recessionBandsForSeries(series), [series]);

  const fullSeriesTicks = useMemo(() => {
    if (!series.length) return [];
    const seen = new Set();
    const firstOfYear = [];
    for (const r of series) {
      const y = r.dateObj.getFullYear();
      if (!seen.has(y)) { seen.add(y); firstOfYear.push(r); }
    }
    const strided = firstOfYear.filter((_, i) => i % 2 === 0);
    if (firstOfYear.length && strided[strided.length - 1] !== firstOfYear[firstOfYear.length - 1]) {
      strided.push(firstOfYear[firstOfYear.length - 1]);
    }
    return strided.map((r) => r.label);
  }, [series]);

  const rebaseTicks = useMemo(() => {
    if (!forwardEpsRebased.length) return [];
    const seen = new Set();
    const firstOfMonth = [];
    for (const r of forwardEpsRebased) {
      const k = `${r.dateObj.getFullYear()}-${r.dateObj.getMonth()}`;
      if (!seen.has(k)) { seen.add(k); firstOfMonth.push(r); }
    }
    const strided = firstOfMonth.filter((_, i) => i % 3 === 0);
    if (firstOfMonth.length && strided[strided.length - 1] !== firstOfMonth[firstOfMonth.length - 1]) {
      strided.push(firstOfMonth[firstOfMonth.length - 1]);
    }
    return strided.map((r) => r.label);
  }, [forwardEpsRebased]);

  // ====================================================================
  // EARLY RETURNS — safe now that all hooks above have been called.
  // ====================================================================
  if (loading) {
    return (
      <div style={{ background: C.bg, minHeight: 240, color: C.textDim, fontFamily: FONT_MONO,
        display: "flex", alignItems: "center", justifyContent: "center", letterSpacing: 1.5, fontSize: 11 }}>
        LOADING /data/equity_regime.json …
      </div>
    );
  }
  if (error || !data) {
    return (
      <div style={{ background: C.bg, color: C.red, fontFamily: FONT_MONO,
        padding: 24, fontSize: 11, letterSpacing: 1 }}>
        <div style={{ marginBottom: 8 }}>FAILED TO LOAD /data/equity_regime.json</div>
        <div style={{ color: C.textDim }}>{error}</div>
        <button
          onClick={() => window.location.reload()}
          style={{ marginTop: 12, background: "transparent", color: C.amber,
            border: `1px solid ${C.amber}`, padding: "4px 14px", fontFamily: FONT_MONO,
            fontSize: 10, letterSpacing: 1, cursor: "pointer", borderRadius: 2 }}
        >
          RETRY
        </button>
      </div>
    );
  }

  // ====================================================================
  // DISPLAY-ONLY DERIVATIONS — no hooks, only run after data is loaded.
  // ====================================================================
  const latest = data.latest || {};

  // Breadth: tile colors by 52w rolling baseline (trigger reference);
  // sub-line text shows distance from long-term median in pp.
  const breadthVsMedian = latest.rev_breadth != null && latest.rev_breadth_median_lt != null
    ? latest.rev_breadth - latest.rev_breadth_median_lt
    : null;
  const breadthTone = (() => {
    if (latest.rev_breadth == null || latest.rev_breadth_baseline_52w == null) return C.amber;
    if (latest.rev_breadth > latest.rev_breadth_baseline_52w) return C.green;
    if (latest.rev_breadth < latest.rev_breadth_baseline_52w) return C.red;
    return C.amber;
  })();

  const lastRebased = forwardEpsRebased[forwardEpsRebased.length - 1] || {};

  // Hero chart label helpers — render a small annotation only at the rightmost
  // data point. Recharts calls the renderer per-point; we no-op for all but the
  // last index. Re-derived from heroData so the label moves when range changes.
  const heroLastIdx = heroData.length - 1;
  const heroSubText = heroData.length
    ? `${heroData[0].dateObj.getFullYear()} → today · weekly`
    : "weekly";
  const renderLastLabel = (color, suffix) => (props) => {
    const { x, y, index, value } = props;
    if (index !== heroLastIdx || !Number.isFinite(value)) return null;
    return (
      <text x={x + 6} y={y + 4} fill={color} fontSize={11} fontFamily={FONT_MONO} fontWeight={700}>
        {value > 0 ? "+" : ""}{value.toFixed(1)}{suffix}
      </text>
    );
  };
  // Date-axis formatters for the hero chart (XAxis dataKey is `date`, ISO string).
  const heroXTickFormatter = (d) => {
    const dt = new Date(d);
    return equityChartRange === "1Y"
      ? dt.toLocaleDateString("en-US", { month: "short" })
      : dt.getFullYear().toString();
  };
  const heroTooltipLabelFormatter = (d) =>
    new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
  const heroBrushTickFormatter = (d) => {
    const dt = typeof d === "string" ? new Date(d) : d;
    return dt.getFullYear().toString();
  };

  const qChg3m = (() => {
    if (series.length < 14 || latest.eps_q_yoy == null) return null;
    for (let i = series.length - 14; i >= 0; i--) {
      const v = series[i].eps_q_yoy;
      if (v != null) return latest.eps_q_yoy - v;
    }
    return null;
  })();

  const factorDefs = [
    { key: "growth",    name: "GROWTH",    desc: "CY BLENDED YoY > 0" },
    { key: "breadth",   name: "BREADTH",   desc: `> 52w median (${latest.rev_breadth_baseline_52w != null ? latest.rev_breadth_baseline_52w.toFixed(1) : "—"})` },
    { key: "accel",     name: "ACCEL",     desc: "BREADTH rising 4w" },
    { key: "quarterly", name: "QUARTERLY", desc: "Q EPS YoY > 0" },
  ];

  return (
    <div style={{ padding: "0 16px 16px", fontFamily: FONT_MONO, color: C.text }}>
      {/* REGIME BANNER */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 14px",
          marginBottom: 12,
          background: `${regimeColor(latest.regime)}22`,
          border: `1px solid ${regimeColor(latest.regime)}`,
          borderRadius: 3,
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
          <span style={{ fontSize: 10, color: C.textDim, letterSpacing: 1.5 }}>REGIME</span>
          <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: 1.8, color: regimeColor(latest.regime) }}>
            {latest.regime}
          </span>
          <span style={{ fontSize: 11, color: C.text, fontWeight: 600 }}>
            SCORE {latest.score >= 0 ? "+" : ""}{latest.score} / 4
          </span>
        </div>
        <span style={{ fontSize: 10, color: C.textDim, letterSpacing: 1 }}>as of {latest.asof}</span>
      </div>

      {/* KPI STRIP */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 8, marginBottom: 12 }}>
        <StatTile
          label="CY1 EPS"
          value={fmtUsd(latest.eps_cny)}
          sub={fmtPct(latest.eps_cny_yoy) + " YoY"}
          color={latest.eps_cny_yoy == null ? C.text : latest.eps_cny_yoy > 0 ? C.green : C.red}
        />
        <StatTile
          label="CY2 EPS"
          value={fmtUsd(latest.eps_ny)}
          sub="next CY · blended"
          color={C.text}
        />
        <StatTile
          label="Q EPS"
          value={fmtUsd(latest.eps_q)}
          sub={fmtPct(latest.eps_q_yoy) + " YoY"}
          color={latest.eps_q_yoy == null ? C.text : latest.eps_q_yoy > 0 ? C.green : C.red}
        />
        <StatTile
          label="REV BREADTH"
          value={latest.rev_breadth != null ? latest.rev_breadth.toFixed(1) : "—"}
          sub={breadthVsMedian != null
            ? `${breadthVsMedian > 0 ? "+" : ""}${breadthVsMedian.toFixed(1)}pp vs median`
            : "—"}
          color={breadthTone}
        />
        <StatTile
          label="TTM EPS"
          value={fmtUsd(latest.eps_ttm)}
          sub="trailing 12m"
          color={C.text}
        />
        <Panel
          style={{
            background: C.bg,
            border: `1px solid ${scoreColor(latest.score)}`,
            padding: "8px 10px",
            borderRadius: 3,
          }}
        >
          <div style={{ fontSize: 9, color: C.textDim, letterSpacing: 1.5 }}>REGIME SCORE</div>
          <div style={{ fontSize: 18, color: scoreColor(latest.score), fontWeight: 700, letterSpacing: 0.2, marginTop: 2, lineHeight: 1 }}>
            {latest.score >= 0 ? "+" : ""}{latest.score} / 4
          </div>
          <div style={{ fontSize: 9, color: C.textDim, marginTop: 3 }}>composite</div>
        </Panel>
      </div>

      {/* HERO CHART — CY BLENDED EPS YoY% × REVISIONS BREADTH (dual y-axis + range zoom) */}
      <Panel style={{ marginBottom: 12 }}>
        {/* Title bar: title | range pills | dynamic subtitle */}
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 10, gap: 12 }}>
          <span style={{ fontSize: 11, color: C.amber, letterSpacing: 1.5, fontWeight: 600 }}>
            ▸ CY BLENDED EPS YoY% × REVISIONS BREADTH
          </span>
          <div style={{ display: "flex", gap: 4 }}>
            {["1Y", "5Y", "10Y", "MAX"].map((r) => (
              <Pill key={r} active={equityChartRange === r} onClick={() => setEquityChartRange(r)}>{r}</Pill>
            ))}
          </div>
          <span style={{ fontSize: 9, color: C.textDim, letterSpacing: 1 }}>{heroSubText}</span>
        </div>
        <ResponsiveContainer width="100%" height={310}>
          {/* margin.right widened to keep the latest-value labels from being clipped.
              XAxis dataKey is `date` (unique ISO per row), not `label`, so
              ReferenceArea can position cleanly without duplicate-category collisions. */}
          <ComposedChart data={heroData} margin={{ top: 4, right: 56, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={C.grid} strokeDasharray="2 4" />
            <XAxis dataKey="date" ticks={heroDateTicks} tickFormatter={heroXTickFormatter} tick={{ fontSize: 9, fill: C.textDim }} stroke={C.panelEdge} interval={0} />
            <YAxis yAxisId="left"  tick={{ fontSize: 9, fill: C.cyan }}  stroke={C.panelEdge} width={36} domain={[-50, 50]} ticks={[-50, -25, 0, 25, 50]} allowDataOverflow={false} />
            <YAxis yAxisId="right" tick={{ fontSize: 9, fill: C.amber }} stroke={C.panelEdge} width={32} orientation="right" domain={[10, 70]}  ticks={[10, 25, 40, 55, 70]}    allowDataOverflow={false} />
            <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: C.text }} labelFormatter={heroTooltipLabelFormatter} />
            {/* Recession bands BEFORE the lines so they paint underneath. */}
            {recessionBands.map((b, i) => (
              <ReferenceArea
                key={i}
                yAxisId="left"
                x1={b.date1}
                x2={b.date2}
                y1={-50}
                y2={50}
                fill="rgba(255, 82, 82, 0.10)"
                stroke="none"
                ifOverflow="extendDomain"
              />
            ))}
            <ReferenceLine yAxisId="left"  y={0}  stroke={C.textDim}  strokeDasharray="3 3" />
            <ReferenceLine yAxisId="right" y={40} stroke={C.textMute} strokeDasharray="3 3" />
            <Line yAxisId="left"  type="monotone" dataKey="eps_cny_yoy" stroke={C.cyan}  strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls={false} label={renderLastLabel(C.cyan,  "%")} />
            <Line yAxisId="right" type="monotone" dataKey="rev_breadth" stroke={C.amber} strokeWidth={1.5} strokeDasharray="4 2" dot={false} isAnimationActive={false} connectNulls={false} label={renderLastLabel(C.amber, "")} />
            {/* Brush remounts on pill change (key={equityChartRange}) so its
                window resets to span the new heroData; defaults to full range. */}
            <Brush
              key={equityChartRange}
              dataKey="date"
              height={26}
              stroke={C.amber}
              fill="rgba(13, 15, 20, 0.6)"
              travellerWidth={8}
              tickFormatter={heroBrushTickFormatter}
            />
          </ComposedChart>
        </ResponsiveContainer>
        <div style={{ display: "flex", gap: 14, marginTop: 8, fontSize: 10, flexWrap: "wrap" }}>
          <Legend color={C.cyan}  label="CY BLENDED EPS YoY%" value={fmtPct(latest.eps_cny_yoy)} bold />
          <Legend color={C.amber} label="REV BREADTH (rhs)"   value={latest.rev_breadth != null ? latest.rev_breadth.toFixed(1) : "—"} bold dashed />
        </div>
      </Panel>

      {/* QUARTERLY EPS YoY% — full width (breadth panel was removed; breadth is on hero) */}
      <Panel style={{ marginBottom: 12 }}>
        <PanelTitle sub="quarterly · YoY">▸ QUARTERLY EPS — % CHG YoY</PanelTitle>
        <ResponsiveContainer width="100%" height={180}>
          <LineChart data={series} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={C.grid} strokeDasharray="2 4" />
            <XAxis dataKey="label" ticks={fullSeriesTicks} tick={{ fontSize: 9, fill: C.textDim }} stroke={C.panelEdge} interval={0} />
            <YAxis tick={{ fontSize: 9, fill: C.textDim }} stroke={C.panelEdge} width={36} domain={[-80, 80]} />
            <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: C.text }} />
            <ReferenceLine y={0} stroke={C.textDim} strokeDasharray="3 3" />
            {recessionBands.map((b, i) => (
              <ReferenceArea key={i} x1={b.l1} x2={b.l2} fill="rgba(255,82,82,0.06)" stroke="none" />
            ))}
            <Line type="monotone" dataKey="eps_q_yoy" stroke={C.green} strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls={false} />
          </LineChart>
        </ResponsiveContainer>
        <div style={{ marginTop: 6, fontSize: 9, color: C.textDim, letterSpacing: 0.5 }}>
          Current:{" "}
          <span style={{ color: latest.eps_q_yoy != null && latest.eps_q_yoy >= 0 ? C.green : C.red, fontWeight: 600 }}>
            {fmtPct(latest.eps_q_yoy)}
          </span>
          {qChg3m != null && (
            <>
              {"  ·  3m chg: "}
              <span style={{ color: qChg3m >= 0 ? C.green : C.red, fontWeight: 600 }}>
                {qChg3m >= 0 ? "+" : ""}{qChg3m.toFixed(2)}pp
              </span>
            </>
          )}
        </div>
      </Panel>

      {/* REGIME COMPOSITE */}
      <Panel style={{ marginBottom: 12 }}>
        <PanelTitle sub="4 factors · monthly history">▸ REGIME COMPOSITE — 4-FACTOR SCORE</PanelTitle>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 14 }}>
          {factorDefs.map((f) => {
            const v = latest.components?.[f.key] ?? 0;
            const c = componentColor(v);
            const mark = v === 1 ? "✓" : v === -1 ? "✗" : "·";
            return (
              <div key={f.key} style={{ background: C.bg, border: `1px solid ${C.panelEdge}`, padding: "8px 10px", borderRadius: 3 }}>
                <div style={{ fontSize: 9, color: C.textDim, letterSpacing: 1.5 }}>{f.name}</div>
                <div style={{ fontSize: 18, color: c, fontWeight: 700, marginTop: 2, lineHeight: 1 }}>
                  {v > 0 ? "+1" : v < 0 ? "−1" : "0"}
                </div>
                <div style={{ fontSize: 8, color: C.textMute, marginTop: 4, letterSpacing: 0.5 }}>
                  trigger: {f.desc} <span style={{ color: c }}>{mark}</span>
                </div>
              </div>
            );
          })}
        </div>
        <div>
          <div style={{ fontSize: 9, color: C.textDim, letterSpacing: 1.4, marginBottom: 4 }}>
            24M SCORE HISTORY · monthly
          </div>
          <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
            {scoreHistory.map((r, i) => {
              const s = r.score ?? 0;
              const intensity = Math.min(0.85, 0.18 + Math.abs(s) * 0.16);
              const bg = s > 0 ? `rgba(0,200,83,${intensity})`
                       : s < 0 ? `rgba(255,82,82,${intensity})`
                       : `rgba(90,94,106,0.25)`;
              return (
                <div
                  key={i}
                  title={`${r.label} · score ${s >= 0 ? "+" : ""}${s}`}
                  style={{ width: 14, height: 20, background: bg, border: `1px solid ${C.panelEdge}`, borderRadius: 1 }}
                />
              );
            })}
          </div>
          {scoreHistory.length > 0 && (
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4, fontSize: 8, color: C.textMute, letterSpacing: 0.5 }}>
              <span>{scoreHistory[0].label}</span>
              <span>{scoreHistory[scoreHistory.length - 1].label}</span>
            </div>
          )}
        </div>
      </Panel>

      {/* FORWARD EPS LEVELS — REBASED */}
      <Panel>
        <PanelTitle sub="last 24 months · base 100">▸ FORWARD EPS LEVELS — REBASED 100</PanelTitle>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={forwardEpsRebased} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke={C.grid} strokeDasharray="2 4" />
            <XAxis dataKey="label" ticks={rebaseTicks} tick={{ fontSize: 9, fill: C.textDim }} stroke={C.panelEdge} interval={0} />
            <YAxis tick={{ fontSize: 9, fill: C.textDim }} stroke={C.panelEdge} width={36} domain={["dataMin - 2", "dataMax + 2"]} />
            <Tooltip contentStyle={tooltipStyle} labelStyle={{ color: C.text }} />
            <ReferenceLine y={100} stroke={C.textDim} strokeDasharray="3 3" />
            <Line type="monotone" dataKey="r_cy"  stroke={C.cyan}    strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls />
            <Line type="monotone" dataKey="r_ny"  stroke={C.amber}   strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={false} connectNulls />
            <Line type="monotone" dataKey="r_q"   stroke={C.green}   strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls />
            <Line type="monotone" dataKey="r_ttm" stroke={C.magenta} strokeWidth={1.5} strokeDasharray="4 3" dot={false} isAnimationActive={false} connectNulls />
          </LineChart>
        </ResponsiveContainer>
        <div style={{ display: "flex", gap: 14, marginTop: 8, fontSize: 10, flexWrap: "wrap" }}>
          <Legend color={C.cyan}    label="CY"  value={lastRebased.r_cy  != null ? `${(lastRebased.r_cy  - 100).toFixed(1)}%` : "—"} />
          <Legend color={C.amber}   label="NY"  value={lastRebased.r_ny  != null ? `${(lastRebased.r_ny  - 100).toFixed(1)}%` : "—"} dashed />
          <Legend color={C.green}   label="Q"   value={lastRebased.r_q   != null ? `${(lastRebased.r_q   - 100).toFixed(1)}%` : "—"} />
          <Legend color={C.magenta} label="TTM" value={lastRebased.r_ttm != null ? `${(lastRebased.r_ttm - 100).toFixed(1)}%` : "—"} dashed />
        </div>
      </Panel>
    </div>
  );
}
