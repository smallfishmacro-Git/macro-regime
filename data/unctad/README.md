# UNCTAD World GDP Nowcast — manual weekly append

UNCTAD publishes the World GDP Nowcast at
https://unctadstat.unctad.org/EN/Nowcasts.html
The page is JS-rendered so we don't auto-fetch.

## Weekly workflow (10 seconds)
1. Visit the page above
2. Select "gross domestic product" tab
3. Note the latest nowcast value (e.g. "2.61%" for the current quarter)
4. Append a row to `manual.csv`:
       2026-04-29,2.63

Use ISO date format (YYYY-MM-DD). One row per weekly update.
