# smallfish-macro-regime

Macro regime dashboard for the SmallFish Macro Terminal.

Part of the SmallFish Macro Terminal suite alongside:
- smallfish-btd (Buy The Dip)
- smallfish-market-risk (Market Risk)
- market-dashboard (Streamlit data hub)

## Tabs
- **GROWTH** (v1) — US growth nowcast and regime model based on Atlanta Fed GDPNow, Dallas Fed WEI, UNCTAD World Nowcast, and RecessionAlert WLA + Global LEI.
- INFLATION (planned)
- LIQUIDITY (planned)
- POLICY (planned)
- NEWS (planned)
- BRIEFING (planned)

## Stack
- Vite + React 18 frontend
- Python serverless API on Vercel
- Daily data ingest via GitHub Actions
- Source data: free / public (Atlanta Fed CSVs, FRED API, UNCTAD, RecessionAlert)
