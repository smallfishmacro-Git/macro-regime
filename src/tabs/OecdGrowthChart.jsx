// ============================================================================
// OECD G20 CLI — chart sub-view rendered inside MACRO REGIME > GROWTH
// ----------------------------------------------------------------------------
// Slots into the GROWTH section's LEFT Panel as the chartMode === "OECD" branch,
// mirroring the COINCIDENT / LEADING / NOWCAST chart blocks. Self-contained:
// fetches its own data/oecd.json (raw GitHub URL, written by oecd_cli.py), so it
// adds no logic to App.jsx's useGrowthData / growth.json path.
//
//   G20 CLI          white, thick   — LEFT axis (auto-zoom ~90..104)
//   Diffusion (MoM)  green, thin    — RIGHT axis (0..100 %)
//   Diffusion (YoY)  amber, dotted  — RIGHT axis (0..100 %)
//   NBER recessions  faint gray bands · 50% breadth threshold dashed
// ============================================================================

import React, { useEffect, useMemo, useState } from "react";
import {
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  ReferenceArea,
} from "recharts";
import { C, FONT_MONO, Legend } from "../design-system";

const OECD_DATA_URL =
  "https://raw.githubusercontent.com/smallfishmacro-Git/macro-regime/main/data/oecd.json";

const REC_FILL = "rgba(130,136,148,0.16)"; // faint gray recession band on dark bg
const RANGE_DAYS = { "10Y": 3650, "25Y": 9131, MAX: Infinity };

export default function OecdGrowthChart() {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [range, setRange] = useState("MAX");

  useEffect(() => {
    let alive = true;
    fetch(OECD_DATA_URL, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j) => alive && setState({ loading: false, error: null, data: j }))
      .catch(
        (e) =>
          alive &&
          setState({ loading: false, error: String(e.message || e), data: null })
      );
    return () => {
      alive = false;
    };
  }, []);

  const { loading, error, data } = state;
  const series = data?.series || [];

  // ---- range filter ----
  const chartData = useMemo(() => {
    if (!series.length) return [];
    const days = RANGE_DAYS[range] ?? Infinity;
    if (days === Infinity) return series;
    const cutoff = series[series.length - 1].t - days * 86400000;
    return series.filter((r) => r.t >= cutoff);
  }, [series, range]);

  // ---- LEFT (CLI) axis auto-zoom with padding ----
  const cliDomain = useMemo(() => {
    let lo = Infinity,
      hi = -Infinity;
    for (const r of chartData)
      if (r.cli != null) {
        lo = Math.min(lo, r.cli);
        hi = Math.max(hi, r.cli);
      }
    if (!isFinite(lo)) return [90, 104];
    const pad = Math.max(0.5, (hi - lo) * 0.08);
    return [Math.floor(lo - pad), Math.ceil(hi + pad)];
  }, [chartData]);

  // ---- decade/year ticks across the visible span ----
  const ticks = useMemo(() => {
    if (!chartData.length) return [];
    const y0 = new Date(chartData[0].t).getUTCFullYear();
    const y1 = new Date(chartData[chartData.length - 1].t).getUTCFullYear();
    const span = y1 - y0;
    const stride = span > 40 ? 10 : span > 18 ? 5 : span > 8 ? 2 : 1;
    const first = Math.ceil(y0 / stride) * stride;
    const out = [];
    for (let y = first; y <= y1; y += stride) out.push(Date.UTC(y, 0, 1));
    return out;
  }, [chartData]);

  // ---- recession windows -> epoch ms (UTC), matching the series t field ----
  const recessions = useMemo(
    () => (data?.recessions || []).map(([a, b]) => [Date.parse(a), Date.parse(b)]),
    [data]
  );

  const fmtYear = (t) => String(new Date(t).getUTCFullYear());
  const last = series.length ? series[series.length - 1] : null;
  const pct = (v) => (v == null ? "—" : `${v.toFixed(1)}%`);

  if (loading) return <div style={MSG}>LOADING OECD G20 CLI …</div>;
  if (error || !series.length)
    return (
      <div style={MSG}>
        <div style={{ color: C.amber, marginBottom: 6 }}>OECD CLI DATA NOT YET GENERATED</div>
        <div style={{ fontSize: 9, color: C.textMute }}>
          run <code style={{ color: C.text }}>python oecd_cli.py</code> — or trigger the
          daily-ingest workflow
        </div>
      </div>
    );

  return (
    <>
      {/* legend + range selector */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
          marginTop: 4,
        }}
      >
        <div style={{ display: "flex", flexWrap: "wrap", gap: 14, fontSize: 8, letterSpacing: 1 }}>
          <Legend color={C.white} label="G20 CLI" value={last?.cli != null ? last.cli.toFixed(2) : "—"} bold />
          <Legend color={C.green} label="DIFFUSION MoM" value={pct(last?.mom)} />
          <Legend color={C.amber} label="DIFFUSION YoY" value={pct(last?.yoy)} dashed />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 8, color: C.textMute, letterSpacing: 1 }}>RANGE</span>
          {["10Y", "25Y", "MAX"].map((r) => (
            <button key={r} onClick={() => setRange(r)} style={rangeBtn(r === range)}>
              {r}
            </button>
          ))}
        </div>
      </div>

      {/* dual-axis chart */}
      <div style={{ width: "100%", height: 460 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 6, right: 44, left: 0, bottom: 6 }}>
            {recessions.map(([x0, x1], i) => (
              <ReferenceArea
                key={`rec-${i}`}
                yAxisId="cli"
                x1={x0}
                x2={x1}
                fill={REC_FILL}
                fillOpacity={1}
                strokeOpacity={0}
                ifOverflow="hidden"
              />
            ))}
            <CartesianGrid stroke={C.panelEdge} strokeDasharray="2 4" vertical={false} />
            <XAxis
              dataKey="t"
              type="number"
              domain={["dataMin", "dataMax"]}
              ticks={ticks}
              tickFormatter={fmtYear}
              tick={{ fill: C.textDim, fontSize: 8, fontFamily: FONT_MONO }}
              axisLine={{ stroke: C.panelEdge }}
              tickLine={false}
            />
            {/* LEFT — G20 CLI */}
            <YAxis
              yAxisId="cli"
              orientation="left"
              domain={cliDomain}
              allowDecimals={false}
              tick={{ fill: C.textDim, fontSize: 8, fontFamily: FONT_MONO }}
              axisLine={{ stroke: C.panelEdge }}
              tickLine={false}
              width={34}
            />
            {/* RIGHT — diffusion 0..100 */}
            <YAxis
              yAxisId="diff"
              orientation="right"
              domain={[0, 100]}
              ticks={[0, 25, 50, 75, 100]}
              tick={{ fill: C.textDim, fontSize: 8, fontFamily: FONT_MONO }}
              axisLine={{ stroke: C.panelEdge }}
              tickLine={false}
              width={34}
              tickFormatter={(v) => `${v}%`}
            />
            {/* 50% breadth threshold (half the members rising) */}
            <ReferenceLine yAxisId="diff" y={50} stroke={C.textMute} strokeDasharray="2 4" strokeWidth={0.5} />
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
              labelFormatter={(t) =>
                new Date(t).toLocaleDateString("en-US", { month: "short", year: "numeric" })
              }
              formatter={(v, n) => [
                v == null ? "—" : n === "G20 CLI" ? v.toFixed(2) : `${v.toFixed(1)}%`,
                n,
              ]}
            />
            {/* Diffusion MoM — thin green (right axis) */}
            <Line
              yAxisId="diff"
              type="monotone"
              dataKey="mom"
              name="DIFFUSION MoM"
              stroke={C.green}
              strokeWidth={1}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
            {/* Diffusion YoY — amber dotted (right axis) */}
            <Line
              yAxisId="diff"
              type="monotone"
              dataKey="yoy"
              name="DIFFUSION YoY"
              stroke={C.amber}
              strokeWidth={1.2}
              strokeDasharray="2 3"
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
            {/* G20 CLI — thick white hero line (left axis, drawn on top) */}
            <Line
              yAxisId="cli"
              type="monotone"
              dataKey="cli"
              name="G20 CLI"
              stroke={C.white}
              strokeWidth={2.4}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* source footer */}
      <div style={{ marginTop: 8, fontSize: 8, color: C.textMute, letterSpacing: 0.8 }}>
        SOURCE · OECD SDMX · <span style={{ color: C.white }}>G20 CLI</span> (amplitude-adj,{" "}
        {data.n_countries} members) · breadth <span style={{ color: C.green }}>MoM</span> /{" "}
        <span style={{ color: C.amber }}>YoY</span> · monthly · as of {data.as_of}
      </div>
    </>
  );
}

// ---- local styles (reference imported design tokens) ----
const MSG = {
  height: 460,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  fontFamily: FONT_MONO,
  fontSize: 11,
  color: C.textDim,
  letterSpacing: 1,
  textAlign: "center",
};

const rangeBtn = (active) => ({
  fontSize: 8,
  padding: "2px 7px",
  color: active ? "#000" : C.textDim,
  background: active ? C.amber : "transparent",
  border: `1px solid ${active ? C.amber : C.panelEdgeStrong}`,
  letterSpacing: 1,
  cursor: "pointer",
  borderRadius: 1,
  fontFamily: FONT_MONO,
});
