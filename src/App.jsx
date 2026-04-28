import React, { useMemo, useState } from "react";
import {
  ComposedChart,
  Bar,
  Line,
  LineChart,
  AreaChart,
  Area,
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

// ========================================================================
// MAIN
// ========================================================================
export default function MacroRegimeGrowth() {
  const [primaryTab, setPrimaryTab] = useState("MACRO_REGIME");
  const [subTab, setSubTab] = useState("GROWTH");
  const [chartMode, setChartMode] = useState("COMPONENTS");
  const [modelMode, setModelMode] = useState("COMPOSITE");

  const gdpNow = useMemo(genGDPNow, []);
  const compZ = useMemo(genCompZ, []);
  const latest = compZ[compZ.length - 1];
  const prevLead = compZ[compZ.length - 5].lead;
  const regime = classifyRegime(latest.coinc, latest.lead, prevLead);
  const regimeKey = `${regime.level}_${regime.direction}`;
  const hedge = HEDGE_MAP[regimeKey];
  const hedgeColor = hedge.color === "green" ? C.green : hedge.color === "red" ? C.red : C.amber;
  const latestG = gdpNow[gdpNow.length - 1];
  const prevG = gdpNow[gdpNow.length - 22]; // ~1 month ago
  const m1Delta = +(latestG.total - prevG.total).toFixed(2);

  // Recent component contributions table (last 8 obs)
  const tableRows = gdpNow.slice(-8).reverse();

  // X-axis ticks
  const monthTicks = useMemo(() => {
    const seen = new Set();
    return gdpNow
      .filter((d) => {
        const k = `${d.date.getFullYear()}-${d.date.getMonth()}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((d) => d.label);
  }, [gdpNow]);

  const compZTicks = useMemo(() => {
    const seen = new Set();
    return compZ
      .filter((d) => {
        const k = `${d.date.getFullYear()}-${Math.floor(d.date.getMonth() / 6)}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((d) => d.label);
  }, [compZ]);

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
          <span style={{ color: C.amber }}>2026-04-28</span>
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
              <Pill active={chartMode === "COMPONENTS"} onClick={() => setChartMode("COMPONENTS")}>COMPONENTS</Pill>
              <Pill active={chartMode === "LEADING"}    onClick={() => setChartMode("LEADING")}>LEADING</Pill>
            </div>
          </div>

          {/* Stat tile row */}
          <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr 1fr 1fr", gap: 8, marginBottom: 14 }}>
            <StatTile
              label="GDPNOW"
              value={`${latestG.total.toFixed(3)}%`}
              sub={`Q2 26 · daily · ${m1Delta >= 0 ? "+" : ""}${m1Delta.toFixed(2)} 1M`}
              color={latestG.total > 2 ? C.green : latestG.total < 0.5 ? C.red : C.amber}
            />
            <StatTile label="Δ 1M"  value={`${m1Delta >= 0 ? "+" : ""}${m1Delta.toFixed(2)}`} sub="vs ~22 obs ago" color={m1Delta >= 0 ? C.green : C.red} valueSize={20} />
            <StatTile label="WEI"    value="1.87"  sub="Dallas Fed · weekly" color={C.text} valueSize={20} />
            <StatTile label="WORLD"  value="2.61%" sub="UNCTAD nowcast · monthly" color={C.text} valueSize={20} />
          </div>

          {/* Atlanta Fed components panel */}
          <Panel style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, paddingBottom: 8, borderBottom: `1px solid ${C.panelEdge}` }}>
              <div style={{ fontSize: 10, letterSpacing: 1.4, color: C.text }}>
                US ATLANTA FED GDPNOW <span style={{ color: C.amber }}>{latestG.total.toFixed(3)}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 8, color: C.textMute, letterSpacing: 1 }}>RANGE</span>
                {["6M", "1Y", "2Y", "MAX"].map((r) => (
                  <span
                    key={r}
                    style={{
                      fontSize: 8,
                      padding: "2px 7px",
                      color: r === "1Y" ? "#000" : C.textDim,
                      background: r === "1Y" ? C.amber : "transparent",
                      border: `1px solid ${r === "1Y" ? C.amber : C.panelEdgeStrong}`,
                      letterSpacing: 1,
                      cursor: "pointer",
                      borderRadius: 1,
                    }}
                  >
                    {r}
                  </span>
                ))}
              </div>
            </div>

            {/* Component legend */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginBottom: 8, fontSize: 8, letterSpacing: 1 }}>
              <Legend color={C.white} label="GDPNOW" value={latestG.total.toFixed(3)} bold />
              <Legend color={C.pceGoods} label="PCE GOODS" value={latestG.pceGoods.toFixed(3)} />
              <Legend color={C.pceServices} label="PCE SERVICES" value={latestG.pceServices.toFixed(3)} />
              <Legend color={C.fixedInv} label="FIXED INV" value={latestG.fixedInv.toFixed(3)} />
              <Legend color={C.govt} label="GOVT" value={latestG.govt.toFixed(3)} />
              <Legend color={C.netExports} label="NET EXPORTS" value={latestG.netExports.toFixed(3)} />
              <Legend color={C.inventories} label="INVENTORIES" value={latestG.inventories.toFixed(3)} />
            </div>

            <div style={{ height: 280 }}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={gdpNow} margin={{ top: 6, right: 30, left: 0, bottom: 6 }} stackOffset="sign">
                  <CartesianGrid stroke={C.grid} vertical={false} />
                  <XAxis
                    dataKey="label"
                    ticks={monthTicks}
                    tick={{ fill: C.textDim, fontSize: 8, fontFamily: FONT_MONO }}
                    axisLine={{ stroke: C.panelEdge }}
                    tickLine={false}
                  />
                  <YAxis
                    domain={[-1.2, 4.5]}
                    tick={{ fill: C.textDim, fontSize: 8, fontFamily: FONT_MONO }}
                    axisLine={{ stroke: C.panelEdge }}
                    tickLine={false}
                    width={36}
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
                  <Bar dataKey="pceGoods"    stackId="s" fill={C.pceGoods}    isAnimationActive={false} />
                  <Bar dataKey="pceServices" stackId="s" fill={C.pceServices} isAnimationActive={false} />
                  <Bar dataKey="fixedInv"    stackId="s" fill={C.fixedInv}    isAnimationActive={false} />
                  <Bar dataKey="govt"        stackId="s" fill={C.govt}        isAnimationActive={false} />
                  <Bar dataKey="netExports"  stackId="s" fill={C.netExports}  isAnimationActive={false} />
                  <Bar dataKey="inventories" stackId="s" fill={C.inventories} isAnimationActive={false} />
                  <Line type="monotone" dataKey="total" stroke={C.white} strokeWidth={1.6} dot={false} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </Panel>

          {/* Recent contributions table */}
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
              SOURCE · Atlanta Fed · <span style={{ color: C.cyan }}>gdpnow-history.csv</span> + <span style={{ color: C.cyan }}>gdpnow-forecast-evolution.xlsx</span> · daily
            </div>
          </Panel>
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
              HEDGE: <span style={{ color: hedgeColor, fontWeight: 700 }}>{hedge.ratio}%</span>
            </span>
          </div>

          {/* Composite chart */}
          <div style={{ background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 4, padding: 16, marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, paddingBottom: 8, borderBottom: `1px solid ${C.panelEdge}` }}>
              <span style={{ fontSize: 10, color: C.text, letterSpacing: 1.2 }}>COMPOSITE Z·SCORE</span>
              <div style={{ display: "flex", gap: 12, fontSize: 8, color: C.textDim, letterSpacing: 1 }}>
                <span><span style={{ color: C.cyan }}>━</span> COINC {latest.coinc >= 0 ? "+" : ""}{latest.coinc.toFixed(2)}</span>
                <span><span style={{ color: C.amber }}>━</span> LEAD {latest.lead >= 0 ? "+" : ""}{latest.lead.toFixed(2)}</span>
              </div>
            </div>
            <div style={{ height: 200 }}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={compZ} margin={{ top: 6, right: 14, left: 0, bottom: 4 }}>
                  <CartesianGrid stroke={C.grid} vertical={false} />
                  <XAxis
                    dataKey="label"
                    ticks={compZTicks}
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
                  <Line type="monotone" dataKey="coinc" stroke={C.cyan}  strokeWidth={1.4} dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="lead"  stroke={C.amber} strokeWidth={1.4} dot={false} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 8, color: C.textMute, letterSpacing: 0.8 }}>
              <span>HIGH +0.5</span>
              <span>NORMAL band</span>
              <span>LOW -0.5</span>
            </div>
          </div>

          {/* Key indicators */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 10, color: C.textDim, letterSpacing: 1.4, marginBottom: 6 }}>KEY INDICATORS</div>
            <KVRow label="GDPNOW (US)"   value={`${latestG.total.toFixed(2)}%`} valueColor={latestG.total >= 1 ? C.green : C.red} sub="Atlanta Fed · daily" />
            <KVRow label="DALLAS WEI"    value="1.87"  valueColor={C.green} sub="weekly · z = +0.42" />
            <KVRow label="UNCTAD WORLD"  value="2.61%" valueColor={C.green} sub="monthly · z = +0.18" />
            <KVRow label="RA WLA"        value="3.4"   valueColor={C.amber} sub="weekly · 8w Δ -1.6" />
            <KVRow label="GLOBAL LEI +8M" value="38.24" valueColor={C.amber} sub="monthly · forward window" />
          </div>

          {/* Regime block */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 10, color: C.textDim, letterSpacing: 1.4, marginBottom: 6 }}>REGIME STATE</div>
            <KVRow label="LEVEL"     value={regime.level}     valueColor={hedgeColor} />
            <KVRow label="DIRECTION" value={regime.direction} valueColor={hedgeColor} />
            <KVRow label="HEDGE"     value={`${hedge.ratio}%`} valueColor={hedgeColor} sub={hedge.posture} />
          </div>

          {/* Quadrant inset */}
          <div style={{ background: C.panel, border: `1px solid ${C.panelEdge}`, borderRadius: 4, padding: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, paddingBottom: 8, borderBottom: `1px solid ${C.panelEdge}` }}>
              <span style={{ fontSize: 10, color: C.text, letterSpacing: 1.2 }}>QUADRANT</span>
              <span style={{ fontSize: 8, color: C.textMute, letterSpacing: 1 }}>COINC × LEAD</span>
            </div>
            <Quadrant coincZ={latest.coinc} leadZ={latest.lead} />
          </div>
        </div>
      </div>

      {/* Bottom note bar */}
      <div style={{ margin: "16px 16px 0", padding: "8px 0", borderTop: `1px solid ${C.panelEdge}`, fontSize: 9, color: C.textDim, letterSpacing: 1, display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <span>SMALLFISHMACRO · MACRO REGIME › GROWTH · prototype · synthetic data</span>
        <span>Z-SCORES vs 10y rolling history · dir = 8w Δ · click <span style={{ color: C.cyan }}>CONNECT</span> to wire live feeds</span>
      </div>
    </div>
  );
}

// ========================================================================
// SMALL HELPERS
// ========================================================================
const Legend = ({ color, label, value, bold }) => (
  <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
    <span style={{ width: 8, height: 8, background: color, display: "inline-block" }} />
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
