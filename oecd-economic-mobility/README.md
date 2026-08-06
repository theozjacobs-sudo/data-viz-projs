# Who's got the best economic mobility?

An interactive dashboard answering: **which country has the best economic
mobility, and how has that changed over time?** Built on the OECD SDMX API.

**Status: work in progress** — waiting on network access to `sdmx.oecd.org`
from the build environment to pull the live Income Distribution Database.
The curated intergenerational-mobility snapshot (`data/mobility_snapshot.csv`)
is in place; see `data/SOURCES.md` for provenance and verification status.

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
