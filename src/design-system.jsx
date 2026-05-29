// ========================================================================
// DESIGN SYSTEM — shared tokens + primitives, aligned to smallfish-rates-regime
// ========================================================================
// Leaf module — must not import from App.jsx or any per-tab component, so
// App.jsx and src/tabs/* can both import from here without a cycle.
// ========================================================================

export const C = {
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

export const FONT_MONO = `"JetBrains Mono", "Fira Code", ui-monospace, Menlo, monospace`;

// ========================================================================
// PRIMITIVES
// ========================================================================
export const Tab = ({ active, children, onClick, size = "lg" }) => {
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

export const Pill = ({ active, children, onClick }) => (
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

export const Panel = ({ children, style }) => (
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

export const StatTile = ({ label, value, sub, color = C.text, valueSize = 18 }) => (
  <div style={{ background: C.bg, border: `1px solid ${C.panelEdge}`, padding: "8px 10px", borderRadius: 3 }}>
    <div style={{ fontSize: 9, color: C.textDim, letterSpacing: 1.5 }}>{label}</div>
    <div style={{ fontSize: valueSize, color, fontWeight: 700, letterSpacing: 0.2, marginTop: 2, lineHeight: 1 }}>
      {value}
    </div>
    {sub && <div style={{ fontSize: 9, color: C.textDim, marginTop: 3 }}>{sub}</div>}
  </div>
);

export const KVRow = ({ label, value, valueColor = C.text, sub }) => (
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

export const Legend = ({ color, label, value, bold, dashed }) => (
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
