import React, { useState, useMemo, useEffect } from "react";
import {
  ResponsiveContainer, ComposedChart, Area, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, ReferenceArea, ReferenceLine, ReferenceDot, Brush
} from "recharts";

/* =====================================================================
   INFLATION TAB  —  U.S. Inflation Momentum & Impulse Index
   13-input inflation-impulse composite (expectations + realized prices +
   wages/rent + commodities + survey). Mirrors the "MMM Inflation Momentum
   Dashboard" concept: each input -> Level, 3m %chg, 12m %chg, Impulse (z),
   Accel; aggregated into a composite Impulse-z, a 0-100 Nowcast, breadth
   diffusion, and an adaptive-z regime.
   Drop-in for:  macro-regime/src/tabs/InflationTab.jsx
   Same dark-terminal UI as EmploymentTab / HousingTab (JetBrains Mono).
   ===================================================================== */

/* ---- Bloomberg / CFR-style dark terminal tokens (mirrors design-system) -- */
const T = {
  bg:"#000000", panel:"#0b0b0b", panel2:"#0d0d0d", border:"#1c1c1c",
  grid:"#161616", text:"#dcdcdc", dim:"#737373", faint:"#3a3a3a",
  amber:"#FFB000", green:"#16C784", red:"#FF433D", cyan:"#29D0D8",
  rec:"rgba(140,140,140,0.16)",
  mono:"'JetBrains Mono', ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace",
};

/* ---- Embedded DEMO scaffold ----------------------------------------
   History is synthetic but anchored to real inflation episodes (2008-09
   deflation scare, 2011 commodity push, 2015-16 oil-crash disinflation,
   2021-22 surge to ~9% headline, 2023-26 normalization). The recent tail
   uses the dashboard's published figures. The live FRED/yfinance pipeline
   (inflation.py) overwrites this entirely once DATA_URL resolves.
   columns:  d, c (impulse z), nc (nowcast 0-100), cpi (CPI YoY %),
             core (Core PCE YoY %), df (diffusion %), r (NBER flag)
*/
const SERIES_CSV = `2003-01,0.03,49.6,2.54,1.44,48,0\n2003-02,-0.03,48.8,2.39,1.54,48,0\n2003-03,-0.16,47.7,2.32,1.57,45,0\n2003-04,-0.19,47.7,2.4,1.53,44,0\n2003-05,-0.2,47.8,2.34,1.69,50,0\n2003-06,0.05,49.0,2.21,1.69,51,0\n2003-07,0.19,50.3,2.28,1.68,52,0\n2003-08,0.06,48.6,2.03,1.79,50,0\n2003-09,-0.0,47.8,2.01,1.71,54,0\n2003-10,0.04,49.1,2.19,1.75,51,0\n2003-11,0.06,48.8,2.07,1.81,49,0\n2003-12,-0.04,46.9,1.8,1.8,52,0\n2004-01,-0.06,47.8,1.96,1.89,50,0\n2004-02,-0.01,48.4,2.02,1.92,54,0\n2004-03,0.06,49.8,2.19,1.98,48,0\n2004-04,0.35,51.9,2.2,1.98,55,0\n2004-05,0.54,53.9,2.35,1.97,61,0\n2004-06,0.58,53.7,2.22,2.01,62,0\n2004-07,0.38,52.9,2.32,2.05,59,0\n2004-08,0.43,54.7,2.6,2.12,53,0\n2004-09,0.5,55.8,2.77,2.07,56,0\n2004-10,0.46,55.7,2.76,2.14,54,0\n2004-11,0.45,56.7,2.94,2.22,55,0\n2004-12,0.51,56.9,2.97,2.1,62,0\n2005-01,0.58,58.3,3.05,2.28,60,0\n2005-02,0.55,57.6,3.01,2.19,62,0\n2005-03,0.36,56.3,2.99,2.21,55,0\n2005-04,0.42,57.0,3.11,2.15,60,0\n2005-05,0.33,56.9,3.2,2.19,55,0\n2005-06,0.3,58.3,3.55,2.17,53,0\n2005-07,0.4,59.2,3.52,2.31,59,0\n2005-08,0.33,59.3,3.71,2.22,59,0\n2005-09,0.46,60.1,3.62,2.33,54,0\n2005-10,0.31,58.8,3.62,2.22,56,0\n2005-11,0.33,59.6,3.74,2.28,56,0\n2005-12,0.29,59.6,3.83,2.21,52,0\n2006-01,0.44,61.4,3.95,2.31,56,0\n2006-02,0.3,60.3,3.91,2.31,52,0\n2006-03,0.2,58.7,3.75,2.25,51,0\n2006-04,0.0,57.2,3.63,2.38,48,0\n2006-05,-0.32,53.4,3.33,2.32,46,0\n2006-06,-0.5,51.6,3.26,2.27,43,0\n2006-07,-0.52,50.1,2.95,2.3,39,0\n2006-08,-0.59,48.6,2.73,2.28,37,0\n2006-09,-0.67,47.7,2.59,2.34,38,0\n2006-10,-0.67,48.3,2.71,2.39,41,0\n2006-11,-0.61,46.9,2.33,2.36,38,0\n2006-12,-0.38,47.9,2.12,2.45,42,0\n2007-01,-0.53,46.5,2.09,2.4,39,0\n2007-02,-0.42,47.4,2.14,2.37,46,0\n2007-03,-0.3,50.2,2.59,2.33,46,0\n2007-04,-0.05,53.1,2.81,2.38,46,0\n2007-05,0.2,54.7,2.85,2.29,50,0\n2007-06,0.39,58.0,3.19,2.42,55,0\n2007-07,0.33,57.0,3.11,2.33,56,0\n2007-08,0.49,59.8,3.48,2.35,59,0\n2007-09,0.59,60.4,3.51,2.29,56,0\n2007-10,0.64,62.9,3.92,2.38,57,0\n2007-11,0.49,62.3,4.05,2.36,59,0\n2007-12,0.34,61.5,4.12,2.29,55,0\n2008-01,0.34,61.4,4.13,2.26,54,0\n2008-02,0.47,64.8,4.59,2.42,56,0\n2008-03,0.77,68.5,4.89,2.48,66,0\n2008-04,0.8,68.5,4.9,2.41,61,0\n2008-05,0.93,70.3,5.06,2.45,65,0\n2008-06,0.96,73.1,5.53,2.6,64,0\n2008-07,0.86,73.0,5.66,2.65,63,1\n2008-08,0.18,62.9,4.56,2.51,56,1\n2008-09,-1.21,47.7,3.49,2.28,35,1\n2008-10,-2.61,32.5,2.4,2.09,7,1\n2008-11,-3.51,21.6,1.37,1.94,0,1\n2008-12,-4.07,16.3,0.26,1.84,0,1\n2009-01,-3.67,13.2,-0.35,1.7,0,1\n2009-02,-2.98,15.9,-0.42,1.66,0,1\n2009-03,-2.26,19.9,-0.67,1.7,17,1\n2009-04,-1.97,19.4,-1.14,1.57,18,1\n2009-05,-1.65,21.0,-1.3,1.61,26,1\n2009-06,-1.37,21.3,-1.63,1.53,27,1\n2009-07,-1.41,19.2,-1.98,1.45,31,0\n2009-08,-0.76,26.5,-1.39,1.48,38,0\n2009-09,0.03,35.6,-0.62,1.52,48,0\n2009-10,1.13,48.0,0.4,1.53,64,0\n2009-11,1.73,55.4,1.06,1.63,78,0\n2009-12,2.09,61.9,1.97,1.58,85,0\n2010-01,2.26,65.8,2.61,1.52,89,0\n2010-02,2.01,63.0,2.4,1.49,79,0\n2010-03,1.4,58.5,2.32,1.53,73,0\n2010-04,0.55,52.6,2.37,1.47,58,0\n2010-05,-0.05,48.1,2.29,1.51,49,0\n2010-06,-0.32,45.5,2.21,1.39,42,0\n2010-07,-0.39,45.0,2.2,1.4,42,0\n2010-08,-0.46,44.2,2.11,1.43,43,0\n2010-09,-0.48,43.2,1.97,1.33,46,0\n2010-10,-0.48,42.8,1.92,1.29,39,0\n2010-11,-0.43,42.6,1.76,1.34,43,0\n2010-12,-0.54,42.0,1.82,1.3,44,0\n2011-01,-0.42,41.8,1.62,1.27,47,0\n2011-02,-0.2,43.7,1.76,1.2,44,0\n2011-03,0.08,47.1,2.02,1.28,48,0\n2011-04,0.76,54.6,2.52,1.43,66,0\n2011-05,1.06,57.3,2.63,1.48,71,0\n2011-06,1.32,60.7,2.91,1.57,71,0\n2011-07,1.29,62.1,3.22,1.65,67,0\n2011-08,1.4,64.9,3.61,1.72,76,0\n2011-09,1.37,65.3,3.78,1.69,71,0\n2011-10,1.0,61.9,3.6,1.67,69,0\n2011-11,0.58,58.5,3.49,1.67,60,0\n2011-12,-0.0,52.9,3.15,1.69,53,0\n2012-01,-0.41,49.5,2.97,1.79,41,0\n2012-02,-0.35,49.6,2.85,1.86,47,0\n2012-03,-0.61,45.1,2.29,1.8,38,0\n2012-04,-0.72,44.4,2.29,1.82,38,0\n2012-05,-0.57,44.1,1.92,1.94,44,0\n2012-06,-0.46,43.2,1.61,1.84,45,0\n2012-07,-0.64,42.4,1.71,1.86,37,0\n2012-08,-0.64,41.4,1.51,1.79,38,0\n2012-09,-0.57,41.7,1.5,1.76,40,0\n2012-10,-0.46,43.0,1.75,1.55,43,0\n2012-11,-0.52,41.4,1.47,1.6,41,0\n2012-12,-0.41,42.2,1.56,1.48,40,0\n2013-01,-0.47,41.2,1.52,1.34,40,0\n2013-02,-0.51,41.0,1.54,1.35,44,0\n2013-03,-0.38,41.9,1.5,1.38,47,0\n2013-04,-0.2,44.0,1.62,1.48,43,0\n2013-05,-0.08,45.0,1.72,1.4,49,0\n2013-06,-0.12,44.1,1.57,1.42,50,0\n2013-07,-0.09,45.8,1.86,1.48,45,0\n2013-08,-0.1,45.7,1.8,1.55,51,0\n2013-09,0.02,47.0,1.95,1.48,47,0\n2013-10,0.08,47.6,1.99,1.49,52,0\n2013-11,0.07,47.8,1.96,1.59,52,0\n2013-12,0.15,48.6,2.04,1.56,53,0\n2014-01,0.02,47.0,1.92,1.52,49,0\n2014-02,0.16,47.5,1.85,1.48,52,0\n2014-03,0.03,47.1,1.92,1.51,51,0\n2014-04,0.14,49.3,2.16,1.64,52,0\n2014-05,0.09,47.9,1.99,1.55,53,0\n2014-06,0.1,48.4,2.09,1.55,51,0\n2014-07,0.06,46.6,1.7,1.63,50,0\n2014-08,-0.19,43.5,1.49,1.47,43,0\n2014-09,-0.83,37.1,1.09,1.45,38,0\n2014-10,-1.04,34.3,0.8,1.42,33,0\n2014-11,-1.3,30.6,0.42,1.39,27,0\n2014-12,-1.32,28.8,0.13,1.28,31,0\n2015-01,-1.37,26.6,-0.26,1.22,30,0\n2015-02,-1.12,28.9,-0.18,1.31,32,0\n2015-03,-0.74,32.5,0.02,1.33,36,0\n2015-04,-0.45,34.7,0.07,1.28,43,0\n2015-05,-0.17,36.8,0.12,1.24,44,0\n2015-06,0.02,37.6,0.01,1.23,47,0\n2015-07,0.1,38.8,0.12,1.32,51,0\n2015-08,0.07,38.3,0.1,1.24,48,0\n2015-09,0.14,38.7,0.0,1.35,52,0\n2015-10,0.29,40.8,0.23,1.35,55,0\n2015-11,0.25,40.9,0.29,1.4,50,0\n2015-12,0.35,40.9,0.16,1.34,57,0\n2016-01,0.47,42.7,0.3,1.49,54,0\n2016-02,0.57,44.8,0.6,1.49,61,0\n2016-03,0.66,45.5,0.66,1.42,63,0\n2016-04,0.63,46.5,0.87,1.53,60,0\n2016-05,0.67,47.1,0.95,1.5,57,0\n2016-06,0.55,46.2,0.91,1.53,59,0\n2016-07,0.68,49.0,1.3,1.58,60,0\n2016-08,0.68,50.5,1.6,1.66,64,0\n2016-09,0.84,52.0,1.64,1.72,60,0\n2016-10,0.71,52.4,1.9,1.74,64,0\n2016-11,0.85,53.5,1.94,1.7,68,0\n2016-12,0.7,53.9,2.22,1.78,63,0\n2017-01,0.82,55.2,2.34,1.76,66,0\n2017-02,0.66,55.5,2.59,1.84,58,0\n2017-03,0.52,54.2,2.55,1.82,62,0\n2017-04,0.26,52.1,2.43,1.9,54,0\n2017-05,0.05,52.2,2.76,1.91,55,0\n2017-06,0.23,52.7,2.6,1.91,57,0\n2017-07,0.1,51.6,2.62,1.83,49,0\n2017-08,0.14,52.8,2.82,1.83,55,0\n2017-09,0.28,52.7,2.55,1.89,58,0\n2017-10,0.22,52.6,2.57,1.95,50,0\n2017-11,0.1,53.0,2.86,1.94,50,0\n2017-12,-0.03,52.2,2.89,1.92,52,0\n2018-01,0.03,51.3,2.59,1.93,48,0\n2018-02,0.03,51.7,2.72,1.89,54,0\n2018-03,-0.08,51.5,2.74,2.01,47,0\n2018-04,-0.1,52.2,2.92,2.02,51,0\n2018-05,0.13,54.1,3.01,2.01,49,0\n2018-06,0.1,52.9,2.8,1.97,52,0\n2018-07,0.07,54.1,3.08,2.01,55,0\n2018-08,-0.2,50.0,2.66,1.93,45,0\n2018-09,-0.43,47.1,2.32,1.99,41,0\n2018-10,-0.72,45.0,2.41,1.86,39,0\n2018-11,-0.85,42.3,2.04,1.82,35,0\n2018-12,-0.78,42.8,1.98,1.89,34,0\n2019-01,-0.71,41.7,1.65,1.87,36,0\n2019-02,-0.79,41.1,1.68,1.82,35,0\n2019-03,-0.48,43.7,1.81,1.76,46,0\n2019-04,-0.38,44.4,1.84,1.71,45,0\n2019-05,-0.19,46.3,2.01,1.67,50,0\n2019-06,-0.01,47.0,1.86,1.68,47,0\n2019-07,0.07,48.8,2.15,1.65,53,0\n2019-08,0.03,47.8,1.97,1.68,47,0\n2019-09,-0.05,47.0,1.99,1.6,49,0\n2019-10,-0.09,48.4,2.32,1.64,50,0\n2019-11,-0.04,49.2,2.38,1.7,48,0\n2019-12,-0.12,47.2,2.17,1.55,51,0\n2020-01,-0.55,41.7,1.74,1.36,42,0\n2020-02,-1.02,35.8,1.21,1.26,34,1\n2020-03,-1.85,27.9,0.89,1.06,24,1\n2020-04,-2.33,21.4,0.31,0.88,10,1\n2020-05,-1.85,24.8,0.28,0.93,24,0\n2020-06,-1.14,30.7,0.44,1.03,33,0\n2020-07,-0.31,38.4,0.84,1.04,44,0\n2020-08,0.2,41.9,0.76,1.13,56,0\n2020-09,0.61,46.9,1.15,1.27,58,0\n2020-10,0.78,47.0,0.95,1.2,66,0\n2020-11,0.84,49.9,1.4,1.33,64,0\n2020-12,0.98,50.2,1.22,1.38,65,0\n2021-01,1.6,60.1,2.18,1.79,78,0\n2021-02,2.23,67.2,2.64,2.0,85,0\n2021-03,3.35,79.7,3.41,2.43,100,0\n2021-04,3.91,84.6,4.15,2.76,100,0\n2021-05,4.0,88.1,4.72,3.07,100,0\n2021-06,4.32,92.5,5.5,3.36,100,0\n2021-07,3.98,94.2,5.72,3.62,100,0\n2021-08,3.69,95.7,5.84,3.92,100,0\n2021-09,3.21,95.6,6.06,4.08,100,0\n2021-10,2.85,93.9,6.5,4.38,96,0\n2021-11,2.67,92.7,6.77,4.57,94,0\n2021-12,2.68,92.8,6.99,4.97,91,0\n2022-01,2.35,90.5,7.49,4.91,84,0\n2022-02,2.1,88.7,7.61,5.01,80,0\n2022-03,1.69,85.8,7.98,4.87,74,0\n2022-04,1.38,83.7,8.46,4.95,73,0\n2022-05,1.21,82.5,8.81,5.05,69,0\n2022-06,1.17,82.2,8.93,4.97,69,0\n2022-07,0.85,80.0,8.73,4.92,67,0\n2022-08,0.08,74.6,8.32,4.93,48,0\n2022-09,-0.57,70.0,7.97,4.87,39,0\n2022-10,-0.94,67.4,7.27,4.82,36,0\n2022-11,-1.23,65.4,6.86,4.91,26,0\n2022-12,-1.42,64.1,6.39,4.76,23,0\n2023-01,-1.72,61.9,5.98,4.79,21,0\n2023-02,-1.76,58.9,5.29,4.59,19,0\n2023-03,-2.18,52.6,4.62,4.48,14,0\n2023-04,-2.16,50.7,4.13,4.53,13,0\n2023-05,-2.14,48.6,3.67,4.46,16,0\n2023-06,-2.12,44.8,2.94,4.25,17,0\n2023-07,-2.06,45.4,3.16,3.99,15,0\n2023-08,-1.99,45.1,3.09,3.81,19,0\n2023-09,-1.83,45.3,3.08,3.52,21,0\n2023-10,-1.79,45.9,3.21,3.44,19,0\n2023-11,-1.69,46.8,3.5,3.09,26,0\n2023-12,-1.62,47.0,3.52,2.95,22,0\n2024-01,-1.46,46.2,3.17,2.85,24,0\n2024-02,-1.24,48.6,3.42,2.75,27,0\n2024-03,-0.97,49.9,3.34,2.67,36,0\n2024-04,-0.93,50.0,3.25,2.74,38,0\n2024-05,-0.64,49.9,2.9,2.58,42,0\n2024-06,-0.49,51.2,2.91,2.64,41,0\n2024-07,-0.28,52.7,2.93,2.6,44,0\n2024-08,-0.12,54.2,3.01,2.63,44,0\n2024-09,-0.14,53.6,2.88,2.66,49,0\n2024-10,0.04,56.0,3.03,2.8,51,0\n2024-11,0.02,55.7,3.08,2.69,49,0\n2024-12,0.23,56.9,2.89,2.87,55,0\n2025-01,0.1,55.1,2.81,2.73,51,0\n2025-02,-0.14,53.7,2.8,2.8,51,0\n2025-03,-0.16,53.6,2.86,2.74,49,0\n2025-04,-0.35,51.5,2.8,2.68,43,0\n2025-05,-0.33,50.2,2.59,2.61,50,0\n2025-06,-0.34,49.1,2.45,2.55,44,0\n2025-07,-0.55,47.3,2.48,2.51,45,0\n2025-08,-0.36,48.7,2.55,2.54,48,0\n2025-09,-0.47,48.3,2.64,2.63,46,0\n2025-10,-0.47,46.1,2.32,2.47,46,0\n2025-11,-0.56,46.1,2.51,2.51,51,0\n2025-12,-0.49,45.7,2.37,2.52,47,0\n2026-01,-0.43,46.4,2.49,2.56,54,0\n2026-02,-0.49,44.7,2.27,2.55,57,0\n2026-03,-0.36,45.8,2.43,2.48,53,0`;
const COMPONENTS = [
  { id:"T5YIFR",  name:"5Y5Y Fwd Inflation",   fred:"T5YIFR",        unit:"%",   level:2.11,  chg3:-4.09, chg12:-0.47, impulse:-3.62, accel:-1, group:"EXPECTATIONS", since:2003 },
  { id:"T5YIE",   name:"5Y Breakeven",          fred:"T5YIE",         unit:"%",   level:2.61,  chg3:12.50, chg12:5.24,  impulse:7.26,  accel:+1, group:"EXPECTATIONS", since:2003 },
  { id:"T10YIE",  name:"10Y Breakeven",         fred:"T10YIE",        unit:"%",   level:2.36,  chg3:4.42,  chg12:2.61,  impulse:1.82,  accel:+1, group:"EXPECTATIONS", since:2003 },
  { id:"CPI",     name:"CPI YoY",               fred:"CPIAUCSL",      unit:"%",   level:2.41,  chg3:-0.24, chg12:0.01,  impulse:-0.24, accel:-1, group:"PRICES",       since:1947 },
  { id:"CORECPI", name:"Core CPI YoY",          fred:"CPILFESL",      unit:"%",   level:2.39,  chg3:-0.23, chg12:-0.41, impulse:0.18,  accel:+1, group:"PRICES",       since:1957 },
  { id:"PCE",     name:"PCE YoY",               fred:"PCEPI",         unit:"%",   level:2.40,  chg3:-0.50, chg12:0.04,  impulse:-0.55, accel:-1, group:"PRICES",       since:1959 },
  { id:"COREPCE", name:"Core PCE YoY",          fred:"PCEPILFE",      unit:"%",   level:2.50,  chg3:-0.51, chg12:-0.17, impulse:-0.34, accel:-1, group:"PRICES",       since:1959 },
  { id:"PPIXFE",  name:"PPI ex Food & Energy",  fred:"WPSFD4131",     unit:"%",   level:3.50,  chg3:0.10,  chg12:1.15,  impulse:-1.06, accel:-1, group:"PRICES",       since:1974 },
  { id:"AHE",     name:"Avg Hourly Earnings",   fred:"CES0500000003", unit:"%",   level:3.26,  chg3:-0.56, chg12:-0.91, impulse:0.35,  accel:+1, group:"WAGES/RENT",   since:2006 },
  { id:"RENT",    name:"CPI Rent (Primary)",    fred:"CUSR0000SEHA",  unit:"%",   level:2.81,  chg3:-0.55, chg12:-1.58, impulse:1.02,  accel:+1, group:"WAGES/RENT",   since:1947 },
  { id:"OIL",     name:"Oil (WTI) YoY",         fred:"DCOILWTICO",    unit:"%",   level:43.74, chg3:62.40, chg12:59.22, impulse:3.18,  accel:+1, group:"COMMODITIES",  since:1986 },
  { id:"COMMOD",  name:"Commodities YoY",       fred:"^SPGSCI (yf)",  unit:"%",   level:42.24, chg3:36.15, chg12:39.95, impulse:-3.80, accel:-1, group:"COMMODITIES",  since:1970 },
  { id:"ISMPx",   name:"ISM Prices Paid",       fred:"ISM-PRICES",    unit:"idx", level:70.5,  chg3:20.51, chg12:12.98, impulse:7.53,  accel:+1, group:"SURVEY",       since:1948 },
];
const TOP_DRIVERS = [
  { name:"PPI ex Food & Energy", pts:-0.16 },
  { name:"5Y5Y Fwd Inflation",  pts:-0.09 },
  { name:"ISM Prices Paid",     pts:+0.07 },
];
/* regime bands on the composite impulse-z (adaptive-z held at ME) */
const BANDS = { neutral_lo:-0.5, neutral_hi:0.5, hot:1.0, cold:-1.0 };
const DEMO_META = {
  source:"DEMO_SCAFFOLD",
  title:"U.S. Inflation Momentum & Impulse Index",
  subtitle:"13-input inflation-impulse composite · expectations + prices + wages/rent + commodities + survey",
  as_of:"2026-03", published:"2026-03-22",
};

function parseSeries(csv){
  return csv.trim().split("\n").map(l=>{
    const p=l.split(",");
    return { d:p[0], c:+p[1], nc:+p[2], cpi:+p[3], core:+p[4], df:+p[5], r:+p[6] };
  });
}
const DEMO = { meta:DEMO_META, series:parseSeries(SERIES_CSV), components:COMPONENTS, drivers:TOP_DRIVERS, bands:BANDS };

/* ---- LIVE DATA -----------------------------------------------------
   Points at the inflation.json the daily-ingest workflow commits to the
   macro-regime repo. Hard-coded (not a DEV/PROD switch) because builds
   aren't run locally. If the fetch fails the component falls back to DEMO.
*/
const DATA_URL = "https://raw.githubusercontent.com/smallfishmacro-Git/macro-regime/main/data/inflation.json";

/* ---- helpers -------------------------------------------------------- */
const NN = v => v!=null && !Number.isNaN(v);
const SP = (v,dp=2) => NN(v) ? (v>0?"+":"") + v.toFixed(dp) : "n/a";
const PCT = (v,dp=1) => NN(v) ? v.toFixed(dp)+"%" : "n/a";
function lastValid(rows, key){
  let vi=-1, pi=-1;
  for(let i=rows.length-1;i>=0;i--){
    if(NN(rows[i][key])){ if(vi<0) vi=i; else { pi=i; break; } }
  }
  return { v: vi>=0?rows[vi][key]:null, d: vi>=0?rows[vi].d:null, p: pi>=0?rows[pi][key]:null };
}
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const fmtMon = d => { const [y,m]=d.split("-"); return MONTHS[+m-1]+"-"+y.slice(2); };

const RANGES = [["1Y",12],["3Y",36],["5Y",60],["10Y",120],["MAX",9999]];

/* right-axis benchmarks (composite impulse-z is always on the left) */
const BENCH = {
  cpi:  { key:"cpi",  name:"CPI YoY",        axis:"HEADLINE CPI YoY %", color:T.amber, reversed:false,
           fmt:v=>PCT(v,1), dom:(mn,mx)=>[Math.min(Math.floor(mn-1),-1), Math.max(Math.ceil(mx+1),5)] },
  core: { key:"core", name:"Core PCE YoY",   axis:"CORE PCE YoY %",     color:T.amber, reversed:false,
           fmt:v=>PCT(v,1), dom:(mn,mx)=>[Math.min(Math.floor(mn-0.5),0), Math.max(Math.ceil(mx+0.5),3)] },
  nc:   { key:"nc",   name:"Nowcast",        axis:"INFLATION NOWCAST 0-100", color:T.red, reversed:false,
           fmt:v=>v.toFixed(0), dom:()=>[0,100] },
  df:   { key:"df",   name:"Diffusion",      axis:"% INPUTS RISING", color:T.green, reversed:false,
           fmt:v=>PCT(v,0), dom:()=>[0,100] },
};

function recRuns(rows){
  const out=[]; let st=null;
  rows.forEach((r,i)=>{
    if(r.r===1 && st===null) st=r.d;
    if(r.r===0 && st!==null){ out.push([st, rows[i-1].d]); st=null; }
  });
  if(st!==null) out.push([st, rows[rows.length-1].d]);
  return out;
}

/* regime on composite impulse-z.  red = inflation pressure building,
   green = disinflation, amber = neutral (matches the dashboard coding). */
function regimeOf(s, b){
  const c = s[s.length-1].c;
  const c3 = s.length>3 ? c - s[s.length-4].c : 0;
  if(c >= b.hot)        return {label:"INFLATING",     color:T.red,   note:"Impulse hot · broad price acceleration"};
  if(c >= b.neutral_hi) return {label:"REFLATING",     color:T.red,   note:"Momentum turning up from neutral"};
  if(c >  b.neutral_lo) return c3>0
       ? {label:"NEUTRAL · FIRMING", color:T.amber, note:"In-band, but impulse rising"}
       : {label:"NEUTRAL",            color:T.amber, note:"Impulse near zero · no clear trend"};
  if(c >  b.cold)       return {label:"DISINFLATING",  color:T.green, note:"Momentum easing below neutral"};
  return {label:"DEFLATION RISK", color:T.green, note:"Impulse deeply negative"};
}

/* ---- regime background shading ------------------------------------------
   classify each month by the composite impulse-z, then paint the chart
   background by regime over time (red = inflation pressure, amber = neutral,
   green = disinflation). Mirrors how NBER recessions are shaded. */
function regimeColorAt(c, b){
  if(c==null || Number.isNaN(c)) return null;
  if(c >= b.neutral_hi) return T.red;     // INFLATING / REFLATING
  if(c >  b.neutral_lo) return T.amber;   // NEUTRAL
  return T.green;                          // DISINFLATING / DEFLATION RISK
}
/* group consecutive same-regime months into [x0,x1,color] runs. runs shorter
   than MIN_RUN months are absorbed into the previous run so the ribbon reads
   as regimes rather than month-to-month flicker around the band edges. */
function regimeBands(rows, b, MIN_RUN=3){
  const raw=[]; let start=null, col=null, len=0;
  rows.forEach((r,i)=>{
    const cc=regimeColorAt(r.c, b);
    if(col===null){ start=r.d; col=cc; len=1; }
    else if(cc===col){ len++; }
    else { raw.push({x0:start, x1:rows[i-1].d, col, len}); start=r.d; col=cc; len=1; }
  });
  if(col!==null && rows.length) raw.push({x0:start, x1:rows[rows.length-1].d, col, len});
  const merged=[];
  raw.forEach(run=>{
    if(merged.length && run.len < MIN_RUN) merged[merged.length-1].x1 = run.x1;
    else merged.push({...run});
  });
  return merged;
}

function narrative(data){
  const s=data.series, last=s[s.length-1], prev=s[s.length-2];
  const dir = last.c>prev.c ? "rose to" : last.c<prev.c ? "eased to" : "held at";
  const rising = Math.round(last.df/100*13);
  const cpiL = lastValid(s,"cpi"), coreL = lastValid(s,"core");
  return `Inflation impulse-z ${dir} ${SP(last.c)} in ${fmtMon(last.d)}, with the 0-100 nowcast at `
       + `${last.nc.toFixed(1)}. ${rising} of 13 inputs carry a positive impulse (diffusion ${last.df.toFixed(0)}%). `
       + `Realized headline CPI is ${NN(cpiL.v)?cpiL.v.toFixed(1)+"%":"n/a"} and core PCE `
       + `${NN(coreL.v)?coreL.v.toFixed(1)+"%":"n/a"}.`;
}

/* ---- tiny UI atoms -------------------------------------------------- */
function Stat({label, value, sub, color, deltaTxt, deltaColor}){
  return (
    <div style={{background:T.panel, border:`1px solid ${T.border}`, padding:"11px 13px", flex:1, minWidth:140}}>
      <div style={{color:T.dim, fontSize:9.5, letterSpacing:1.4, textTransform:"uppercase"}}>{label}</div>
      <div style={{display:"flex", alignItems:"baseline", gap:8, marginTop:5}}>
        <div style={{color:color||T.text, fontSize:22, fontWeight:700, lineHeight:1}}>{value}</div>
        {deltaTxt!=null && <div style={{color:deltaColor, fontSize:11, fontWeight:600}}>{deltaTxt}</div>}
      </div>
      {sub && <div style={{color:T.dim, fontSize:9.5, marginTop:5, letterSpacing:0.4}}>{sub}</div>}
    </div>
  );
}
function Pill({active, onClick, children}){
  return (
    <button onClick={onClick} style={{
      background: active?T.cyan:"transparent", color: active?"#000":T.dim,
      border:`1px solid ${active?T.cyan:T.border}`, fontFamily:T.mono, fontSize:10.5,
      fontWeight:600, letterSpacing:0.6, padding:"3px 10px", cursor:"pointer"}}>
      {children}
    </button>
  );
}
function ChartTip({active, payload, label, bench}){
  if(!active||!payload||!payload.length) return null;
  const row = payload[0] && payload[0].payload;
  if(!row) return null;
  const b = BENCH[bench];
  return (
    <div style={{background:"#000", border:`1px solid ${T.faint}`, padding:"8px 10px", fontFamily:T.mono, fontSize:11}}>
      <div style={{color:T.text, fontWeight:700, marginBottom:5}}>{fmtMon(label)}{row.r?"  · recession":""}</div>
      <Row k="Impulse z" v={SP(row.c)} c={row.c>=0?T.red:T.green}/>
      <Row k={b.name} v={b.fmt(row[b.key])} c={b.color}/>
      <Row k="Nowcast" v={row.nc.toFixed(0)} c={T.dim}/>
      <Row k="Diffusion" v={row.df.toFixed(0)+"%"} c={T.dim}/>
    </div>
  );
}
const Row = ({k,v,c}) => (
  <div style={{display:"flex", justifyContent:"space-between", gap:18}}>
    <span style={{color:T.dim}}>{k}</span><span style={{color:c, fontWeight:600}}>{v}</span>
  </div>
);
const Panel = ({title, right, children, pad=true}) => (
  <div style={{background:T.panel2, border:`1px solid ${T.border}`}}>
    {(title||right) &&
      <div style={{display:"flex", justifyContent:"space-between", alignItems:"center",
                   padding:"8px 12px", borderBottom:`1px solid ${T.border}`}}>
        <div style={{color:T.text, fontSize:10.5, letterSpacing:1.4, textTransform:"uppercase"}}>{title}</div>
        {right}
      </div>}
    <div style={{padding: pad?12:0}}>{children}</div>
  </div>
);
const Lg = ({c,t,sq}) => (
  <span style={{display:"inline-flex", alignItems:"center", gap:6}}>
    <span style={{width:sq?9:13, height:sq?9:3, background:c, display:"inline-block"}}/>{t}
  </span>
);

/* ===================================================================== */
export default function InflationTab(){
  const [data, setData] = useState(DEMO);
  const [bench, setBench] = useState("cpi");
  const [rangeI, setRangeI] = useState(4);   // default MAX
  const isDemo = data.meta && data.meta.source === "DEMO_SCAFFOLD";

  useEffect(()=>{
    if(!DATA_URL) return;
    let live=true;
    fetch(DATA_URL).then(r=>r.ok?r.json():Promise.reject()).then(j=>{
      if(live && j && j.series && j.series.length) setData(j);
    }).catch(()=>{ /* keep DEMO */ });
    return ()=>{ live=false; };
  },[]);

  const S = data.series;
  const b = data.bands || BANDS;
  const comps = data.components || COMPONENTS;
  const drivers = data.drivers || TOP_DRIVERS;
  const months = RANGES[rangeI][1];
  const view = useMemo(()=> months>=9999 ? S : S.slice(Math.max(0,S.length-months)), [S, months]);

  const last = S[S.length-1], prev = S[S.length-2];
  const reg = useMemo(()=> regimeOf(S, b), [S, b]);

  /* axis domains */
  const cs = view.map(r=>r.c);
  let lo=Math.min(...cs,0)-0.4, hi=Math.max(...cs,0)+0.4;
  const leftDom=[Math.floor(lo), Math.ceil(hi)];
  const bm=BENCH[bench];
  const bs=view.map(r=>r[bm.key]).filter(NN);
  const rightDom= bs.length ? bm.dom(Math.min(...bs), Math.max(...bs)) : [0,1];

  /* x-axis year ticks */
  const span=view.length;
  const step= span<=40?1: span<=90?2: span<=200?5:10;
  const ticks=view.filter(r=>r.d.endsWith("-01") && (+r.d.slice(0,4))%step===0).map(r=>r.d);

  const runs=recRuns(view);
  const regBands=regimeBands(view, b);
  const rising = Math.round(last.df/100*13);

  /* deltas */
  const c3 = S.length>3 ? last.c - S[S.length-4].c : 0;
  const dC=last.c-prev.c, dNc=last.nc-prev.nc, dDf=last.df-prev.df;
  const cpiNow = lastValid(S,"cpi"); const dCpi = (NN(cpiNow.v)&&NN(cpiNow.p))?cpiNow.v-cpiNow.p:NaN;
  /* rising inflation = red; falling = green */
  const dCol = (x, up_is_bad=true) => !NN(x)||x===0?T.dim : (up_is_bad? (x>0?T.red:T.green) : (x>0?T.green:T.red));

  return (
    <div style={{background:T.bg, color:T.text, fontFamily:T.mono, padding:"16px 18px",
                 minHeight:"100%", boxSizing:"border-box"}}>

      {/* header */}
      <div style={{display:"flex", justifyContent:"space-between", alignItems:"flex-start",
                   borderBottom:`1px solid ${T.border}`, paddingBottom:12}}>
        <div>
          <div style={{display:"flex", alignItems:"center", gap:10}}>
            <span style={{color:T.cyan, fontSize:15, fontWeight:700, letterSpacing:1.5}}>INFLATION</span>
            <span style={{color:T.faint}}>·</span>
            <span style={{color:T.text, fontSize:13, fontWeight:600, letterSpacing:0.5}}>{data.meta.title}</span>
          </div>
          <div style={{color:T.dim, fontSize:10.5, marginTop:5, letterSpacing:0.4}}>{data.meta.subtitle}</div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{display:"inline-flex", alignItems:"center", gap:8}}>
            {isDemo &&
              <span title="Synthetic scaffold — set DATA_URL to go live"
                    style={{color:T.amber, border:`1px solid ${T.amber}`, fontSize:9, fontWeight:700,
                            letterSpacing:1, padding:"2px 6px"}}>DEMO DATA</span>}
            <span style={{background:reg.color, color:"#000", fontSize:11, fontWeight:700,
                          letterSpacing:1, padding:"3px 10px"}}>{reg.label}</span>
          </div>
          <div style={{color:T.dim, fontSize:10, marginTop:6}}>AS OF {fmtMon(data.meta.as_of).toUpperCase()} · pub {data.meta.published}</div>
        </div>
      </div>

      {/* narrative line */}
      <div style={{color:T.text, fontSize:11.5, lineHeight:1.55, margin:"12px 0", opacity:0.92}}>
        <span style={{color:reg.color, fontWeight:700}}>▍</span> {narrative(data)}
        <span style={{color:T.dim}}>  {reg.note}.</span>
      </div>

      {/* KPI row */}
      <div style={{display:"flex", gap:8, flexWrap:"wrap"}}>
        <Stat label="Inflation Impulse z" value={SP(last.c)} color={last.c>=0?T.red:T.green}
              sub="standardized 13-input momentum" deltaTxt={(dC>=0?"▲":"▼")+" "+Math.abs(dC).toFixed(2)+" MoM"} deltaColor={dCol(dC)}/>
        <Stat label="Δ Impulse vs 3m" value={SP(c3)} color={c3>=0?T.red:T.green}
              sub="momentum of the momentum" deltaTxt={c3>=0?"firming":"fading"} deltaColor={dCol(c3)}/>
        <Stat label="Diffusion" value={rising+"/13"} color={T.text}
              sub={last.df.toFixed(0)+"% of inputs rising"} deltaTxt={(dDf>0?"+":"")+dDf.toFixed(0)+" pp"} deltaColor={dCol(dDf)}/>
        <Stat label="Nowcast · 0-100" value={last.nc.toFixed(1)} color={last.nc>=60?T.red:last.nc>=45?T.amber:T.green}
              sub="level + impulse blend" deltaTxt={(dNc>0?"+":"")+dNc.toFixed(1)} deltaColor={dCol(dNc)}/>
        <Stat label="Headline CPI YoY" value={NN(cpiNow.v)?cpiNow.v.toFixed(1)+"%":"n/a"} color={T.amber}
              sub={cpiNow.d&&cpiNow.d!==last.d?`realized · as of ${fmtMon(cpiNow.d)}`:"realized · BLS / FRED"}
              deltaTxt={NN(dCpi)?((dCpi>0?"+":"")+dCpi.toFixed(1)+" pp"):"—"} deltaColor={dCol(dCpi)}/>
      </div>

      {/* hero chart */}
      <div style={{marginTop:14}}>
        <Panel
          title={"INFLATION IMPULSE-Z  vs  "+bm.name}
          right={
            <div style={{display:"flex", gap:14, alignItems:"center"}}>
              <div style={{display:"flex", gap:5}}>
                {Object.keys(BENCH).map(k=>
                  <Pill key={k} active={bench===k} onClick={()=>setBench(k)}>{BENCH[k].name}</Pill>)}
              </div>
              <span style={{width:1, height:16, background:T.border}}/>
              <div style={{display:"flex", gap:5}}>
                {RANGES.map((r,i)=><Pill key={r[0]} active={rangeI===i} onClick={()=>setRangeI(i)}>{r[0]}</Pill>)}
              </div>
            </div>
          }>
          {/* legend */}
          <div style={{display:"flex", gap:14, padding:"2px 2px 10px", fontSize:10, color:T.dim, flexWrap:"wrap", alignItems:"center"}}>
            <Lg c={T.cyan} t="impulse z (left)"/>
            <Lg c={bm.color} t={bm.axis+" (right)"}/>
            <Lg c={T.rec} t="NBER recession" sq/>
            <span style={{color:T.faint}}>regime:</span>
            <Lg c={T.red} t="inflating" sq/>
            <Lg c={T.amber} t="neutral" sq/>
            <Lg c={T.green} t="disinflating" sq/>
            <span style={{marginLeft:"auto", color:T.faint}}>hot &gt; {b.hot} · cold &lt; {b.cold}</span>
          </div>
          <ResponsiveContainer width="100%" height={380}>
            <ComposedChart data={view} margin={{top:8,right:58,left:4,bottom:4}}>
              <defs>
                <linearGradient id="ciFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%"  stopColor={T.cyan} stopOpacity={0.28}/>
                  <stop offset="100%" stopColor={T.cyan} stopOpacity={0.02}/>
                </linearGradient>
              </defs>
              <CartesianGrid stroke={T.grid} strokeDasharray="2 4" vertical={false}/>
              {/* regime background ribbon (red = inflation pressure, amber = neutral, green = disinflation) */}
              {regBands.map((g,i)=> g.col &&
                <ReferenceArea key={"reg"+i} x1={g.x0} x2={g.x1} yAxisId="left"
                               fill={g.col} fillOpacity={g.col===T.amber?0.06:0.11} strokeOpacity={0}/>)}
              {/* NBER recession (gray, layered on top of the regime tint) */}
              {runs.map(([x0,x1],i)=>
                <ReferenceArea key={i} x1={x0} x2={x1} yAxisId="left" fill={T.rec} fillOpacity={1} strokeOpacity={0}/>)}
              {/* threshold lines */}
              <ReferenceLine yAxisId="left" y={0} stroke={T.faint} strokeDasharray="3 3"/>
              <ReferenceLine yAxisId="left" y={b.hot}  stroke={T.red}   strokeOpacity={0.45} strokeDasharray="4 4"/>
              <ReferenceLine yAxisId="left" y={b.cold} stroke={T.green} strokeOpacity={0.40} strokeDasharray="4 4"/>

              <XAxis dataKey="d" ticks={ticks} tickFormatter={d=>d.slice(0,4)}
                     tick={{fill:T.dim, fontSize:10}} stroke={T.border} minTickGap={10}/>
              <YAxis yAxisId="left" domain={leftDom} tick={{fill:T.cyan, fontSize:10}} stroke={T.border}
                     width={34} label={{value:"z", angle:-90, position:"insideLeft", fill:T.dim, fontSize:9, dy:10}}/>
              <YAxis yAxisId="right" orientation="right" domain={rightDom} reversed={bm.reversed}
                     tickFormatter={bm.fmt} tick={{fill:bm.color, fontSize:10}} stroke={T.border} width={48}/>

              <Tooltip content={<ChartTip bench={bench}/>} cursor={{stroke:T.faint, strokeWidth:1}}/>

              <Area  yAxisId="left"  type="monotone" dataKey="c" stroke={T.cyan} strokeWidth={1.6}
                     fill="url(#ciFill)" dot={false} isAnimationActive={false} name="Impulse z"/>
              <Line  yAxisId="right" type="monotone" dataKey={bm.key} stroke={bm.color} strokeWidth={1.4}
                     dot={false} isAnimationActive={false} name={bm.name}/>

              <ReferenceDot yAxisId="left" x={view[view.length-1].d} y={view[view.length-1].c} r={3} fill={T.cyan} stroke="#000"
                            label={{value:SP(view[view.length-1].c), position:"left", fill:T.cyan, fontSize:11, fontWeight:700}}/>
              {(()=>{ const be=lastValid(view,bm.key); return NN(be.v) && (
                <ReferenceDot yAxisId="right" x={be.d} y={be.v} r={3} fill={bm.color} stroke="#000"
                              label={{value:bm.fmt(be.v), position:"right", fill:bm.color, fontSize:11, fontWeight:700}}/>
              ); })()}

              <Brush dataKey="d" height={20} stroke={T.faint} fill="#070707"
                     travellerWidth={8} tickFormatter={fmtMon}/>
            </ComposedChart>
          </ResponsiveContainer>
        </Panel>
      </div>

      {/* lower grid: 13-input breadth + (nowcast mini, diffusion mini) */}
      <div style={{display:"grid", gridTemplateColumns:"1.25fr 1fr", gap:12, marginTop:12}}>

        {/* input breadth */}
        <Panel title={"Input breadth · "+rising+"/13 rising"}
               right={<span style={{color:T.dim, fontSize:9.5}}>impulse z · level · 3m / 12m %Δ</span>}>
          <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:"9px 18px"}}>
            {comps.map(c=>{
              const pos=c.impulse>=0; const w=Math.min(Math.abs(c.impulse),4)/4*50;
              return (
                <div key={c.id}>
                  <div style={{display:"flex", justifyContent:"space-between", alignItems:"baseline"}}>
                    <span style={{color:T.text, fontSize:10.5}} title={c.fred}>
                      {c.name} <span style={{color:c.accel>0?T.red:T.green, fontSize:9.5}} title="accel: 3m vs 12m">{c.accel>0?"↑":"↓"}</span>
                    </span>
                    <span style={{color:pos?T.red:T.green, fontSize:11, fontWeight:700}} title="impulse z">
                      {SP(c.impulse)}
                    </span>
                  </div>
                  {/* centered impulse bar (right = inflationary, left = disinflationary) */}
                  <div style={{position:"relative", height:5, background:"#141414", marginTop:5}}>
                    <div style={{position:"absolute", left:"50%", top:0, bottom:0, width:1, background:T.faint}}/>
                    <div style={{position:"absolute", top:0, bottom:0, background:pos?T.red:T.green,
                                 left: pos? "50%" : (50-w)+"%", width:w+"%", opacity:0.85}}/>
                  </div>
                  <div style={{color:T.faint, fontSize:8.5, marginTop:3, letterSpacing:0.3}}>
                    {c.level.toFixed(2)}{c.unit==="%"?"%":""} · {SP(c.chg3,1)} / {SP(c.chg12,1)} · {c.group}
                  </div>
                </div>
              );
            })}
          </div>
          {/* top drivers */}
          <div style={{borderTop:`1px solid ${T.border}`, marginTop:11, paddingTop:9}}>
            <div style={{color:T.dim, fontSize:9, letterSpacing:1.2, textTransform:"uppercase", marginBottom:6}}>Top impulse drivers (pts)</div>
            <div style={{display:"flex", gap:14, flexWrap:"wrap"}}>
              {drivers.map((d,i)=>(
                <span key={i} style={{fontSize:10, color:T.text}}>
                  <span style={{color:T.dim}}>{i+1}.</span> {d.name}
                  <span style={{color:d.pts>=0?T.red:T.green, fontWeight:700, marginLeft:5}}>{SP(d.pts)}</span>
                </span>
              ))}
            </div>
          </div>
          <div style={{borderTop:`1px solid ${T.border}`, marginTop:11, paddingTop:9,
                       color:T.dim, fontSize:9.5, lineHeight:1.5}}>
            Each input is standardized into an impulse z (rolling-history momentum).
            <span style={{color:T.red}}> red</span> = inflationary contribution,
            <span style={{color:T.green}}> green</span> = disinflationary.
            ↑/↓ = accel (3m %Δ vs 12m %Δ).
          </div>
        </Panel>

        <div style={{display:"flex", flexDirection:"column", gap:12}}>
          {/* nowcast */}
          <Panel title="Inflation nowcast · 0-100">
            <ResponsiveContainer width="100%" height={132}>
              <ComposedChart data={view} margin={{top:6,right:10,left:-18,bottom:0}}>
                <defs>
                  <linearGradient id="ncFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={T.red} stopOpacity={0.35}/>
                    <stop offset="100%" stopColor={T.red} stopOpacity={0.02}/>
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={T.grid} strokeDasharray="2 4" vertical={false}/>
                {runs.map(([x0,x1],i)=><ReferenceArea key={i} x1={x0} x2={x1} fill={T.rec} strokeOpacity={0}/>)}
                <ReferenceLine y={50} stroke={T.faint} strokeDasharray="3 3"
                               label={{value:"50", position:"right", fill:T.faint, fontSize:8}}/>
                <XAxis dataKey="d" ticks={ticks} tickFormatter={d=>d.slice(0,4)}
                       tick={{fill:T.dim, fontSize:9}} stroke={T.border} hide/>
                <YAxis domain={[0,100]} ticks={[0,50,100]} tick={{fill:T.dim, fontSize:9}} stroke={T.border} width={28}/>
                <Tooltip content={<ChartTip bench="nc"/>} cursor={{stroke:T.faint}}/>
                <Area type="monotone" dataKey="nc" stroke={T.red} strokeWidth={1.3} fill="url(#ncFill)" dot={false} isAnimationActive={false}/>
              </ComposedChart>
            </ResponsiveContainer>
            <div style={{display:"flex", gap:14, fontSize:9, color:T.dim, paddingTop:4}}>
              <Lg c={T.red} t="nowcast (>50 = above-target/firming)"/>
            </div>
          </Panel>

          {/* diffusion */}
          <Panel title="Breadth diffusion · % inputs rising">
            <ResponsiveContainer width="100%" height={132}>
              <ComposedChart data={view} margin={{top:6,right:10,left:-18,bottom:0}}>
                <defs>
                  <linearGradient id="dfFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={T.cyan} stopOpacity={0.3}/>
                    <stop offset="100%" stopColor={T.cyan} stopOpacity={0.02}/>
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={T.grid} strokeDasharray="2 4" vertical={false}/>
                {runs.map(([x0,x1],i)=><ReferenceArea key={i} x1={x0} x2={x1} fill={T.rec} strokeOpacity={0}/>)}
                <ReferenceLine y={50} stroke={T.faint} strokeDasharray="3 3"/>
                <XAxis dataKey="d" ticks={ticks} tickFormatter={d=>d.slice(0,4)}
                       tick={{fill:T.dim, fontSize:9}} stroke={T.border}/>
                <YAxis domain={[0,100]} ticks={[0,50,100]} tick={{fill:T.dim, fontSize:9}} stroke={T.border} width={28}/>
                <Tooltip content={<ChartTip bench="df"/>} cursor={{stroke:T.faint}}/>
                <Area type="monotone" dataKey="df" stroke={T.cyan} strokeWidth={1.3} fill="url(#dfFill)" dot={false} isAnimationActive={false}/>
              </ComposedChart>
            </ResponsiveContainer>
            <div style={{display:"flex", gap:14, fontSize:9, color:T.dim, paddingTop:4}}>
              <Lg c={T.cyan} t="share of 13 inputs with positive impulse"/>
            </div>
          </Panel>
        </div>
      </div>

      {/* methodology footer */}
      <div style={{marginTop:14, borderTop:`1px solid ${T.border}`, paddingTop:10,
                   color:T.dim, fontSize:9.5, lineHeight:1.6}}>
        <span style={{color:T.text, letterSpacing:1, textTransform:"uppercase"}}>Methodology</span>  ·
        13 inflation inputs spanning market expectations, realized consumer/producer prices, wages &amp; rent,
        commodities, and survey prices. Each input is reduced to a Level, a 3- and 12-month % change, and a
        standardized <strong>impulse z</strong>; the equally-weighted mean is the composite. The 0-100 nowcast
        blends a level component (where inflation sits vs the ~2% target) with the impulse; diffusion is the share
        of inputs with a positive impulse; the regime is an adaptive-z read of the composite.
        {isDemo && <span style={{color:T.amber}}> Showing synthetic scaffold data — set <code>DATA_URL</code> for the live feed. </span>}
        <span style={{color:T.faint}}> Sources: FRED (T5YIFR, T5YIE, T10YIE, CPIAUCSL, CPILFESL, PCEPI, PCEPILFE, WPSFD4131, CES0500000003, CUSR0000SEHA, DCOILWTICO) · yfinance (commodity index) · ISM prices (manual/regional-Fed proxy). Benchmarks USREC · BLS/BEA.</span>
      </div>
    </div>
  );
}
