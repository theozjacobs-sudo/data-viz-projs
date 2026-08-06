# Who's got the best economic mobility?

An interactive dashboard answering: **which country has the best economic
mobility, and how has that changed over time?** Built on the OECD SDMX API.

**Status: v1 shipped on provisional data.** The dashboard (`site/index.html`)
is built and published; because `sdmx.oecd.org` wasn't reachable from the build
environment, Gini figures are curated from OECD/World Bank publications rather
than pulled live (see `data/SOURCES.md`). Re-running `fetch_oecd.py` +
`build_data.py` with network access upgrades everything to live API data —
the page shows a "provisional data" banner until then.

## The answer (v1)

**Denmark** has the best measured economic mobility: 2 generations for a
bottom-decile family to reach mean income, the weakest parent-child earnings
persistence, and near-lowest inequality. Norway, Finland and Sweden follow at
3 generations; the US and UK sit at 5 (below the 4.5-generation OECD average);
Brazil and South Africa need 9, Colombia 11. Over time the ladder's rungs have
moved apart: inequality rose almost everywhere since the mid-1980s — fastest
in the Nordics that started most equal, and from an already-high base in the
US/UK — which the Great Gatsby relationship suggests means slower elevators
ahead. France (flat for 40 years) is the main counter-example.

## Layout

```
scripts/fetch_oecd.py   # pull raw data from the OECD SDMX API (stdlib only)
scripts/build_data.py   # clean/reshape -> site/data.json          (planned)
data/                   # raw CSVs + curated datasets + provenance notes
site/index.html         # self-contained interactive dashboard      (planned)
```

## Regenerate

```bash
python3 scripts/fetch_oecd.py    # requires network access to sdmx.oecd.org
python3 scripts/build_data.py
open site/index.html
```

## The OECD SDMX API in one minute

- Catalog of everything: `https://sdmx.oecd.org/public/rest/dataflow/all/all/latest`
- A dataset ("dataflow") is addressed as `AGENCY,DATAFLOW_ID,VERSION` — e.g. the
  Income Distribution Database is `OECD.WISE.INE,DSD_WISE_IDD@DF_IDD,1.0`.
- Data pulls: `…/rest/data/<flow>/<key>?format=csvfilewithlabels`, where `<key>`
  is dot-separated dimension codes (blank = wildcard). The v2 endpoint accepts
  `c[DIMENSION]=code` query filters instead, which is easier.
