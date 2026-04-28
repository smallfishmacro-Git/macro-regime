# RecessionAlert — manual weekly drop

The RecessionAlert WLA + Global LEI data requires a logged-in
download from https://recessionalert.com — there is no public API.

## Weekly workflow (5 seconds)
1. Log in to recessionalert.com
2. Download `WeeklyData.xlsx`
3. Rename it to `WeeklyData_YYYYMMDD.xlsx` using today's date
   (e.g. `WeeklyData_20260428.xlsx`)
4. Drop it into `data/recessionalert/raw/`
5. Run `python scripts/ingest_growth.py`

The ingest script reads the most recent xlsx (alphabetic sort —
that's why ISO-dated filenames matter).

## On first run
The script will print the discovered sheets and column names of
your xlsx. If the auto-parse fails, share that printout and the
`read_recessionalert()` function in `scripts/ingest_growth.py`
will be tweaked to match the actual structure.
