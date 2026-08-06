# Who's got the best economic mobility?

An interactive dashboard answering: **which country has the best economic
mobility, and how has that changed over time?** Built on the OECD SDMX API.

**Status: v2 — live OECD data.** `fetch_oecd.py` pulls the Income Distribution
Database (IDD) from `sdmx.oecd.org`; `build_data.py` merges it with the curated
mobility snapshot and renders `site/index.html`. Gini levels, latest years, and
the per-country sparkline series now come straight from the API (45 countries
of annual series; the 30 dashboard countries' latest Gini all carry
`scope: oecd_idd_live`). Generations-to-mean-income and earnings elasticities
remain curated from OECD *A Broken Social Elevator?* (2018) — they are one-off
report figures with no API dataflow (see the catalog sweep below and
`data/SOURCES.md`).

## The answer (v2, unchanged by the live data)

**Denmark** has the best measured economic mobility: 2 generations for a
bottom-decile family to reach mean income, the weakest parent-child earnings
persistence, and near-lowest inequality (live Gini 0.276). Norway, Finland and
Sweden follow at 3 generations; the US and UK sit at 5 (below the
4.5-generation OECD average) with live Ginis of 0.394 and 0.367; Brazil and
South Africa need 9, Colombia 11. Inequality rose almost everywhere since the
mid-1980s — fastest in the Nordics that started most equal — which the Great
Gatsby relationship suggests means slower elevators ahead.

## Layout

```
scripts/fetch_oecd.py   # pull raw data from the OECD SDMX API (stdlib only)
scripts/build_data.py   # merge curated + live data -> site/index.html
data/                   # raw CSV pull + curated datasets + provenance notes
site/template.html      # dashboard shell with a /*__DATA__*/ token
site/index.html         # rendered self-contained dashboard (committed)
```

## Regenerate

```bash
python3 scripts/fetch_oecd.py    # requires network access to sdmx.oecd.org
python3 scripts/build_data.py    # falls back to provisional data if no fetch
open site/index.html
```

`data/idd_data.csv` is committed as the Gini-only subset of the API pull
(the full pull is 44 MB; the catalog and datastructure XMLs are fetched but
not committed). `build_data.py` works identically with the trimmed file.

## Catalog sweep: what the OECD publishes on mobility (2026-08)

Sweep of the full dataflow catalog (1,543 dataflows) for
mobility/intergenerational/inequality/earnings names. Findings:

- **No dataflow carries intergenerational mobility data.** The only
  "mobility" hits are geographic (`DSD_REG_DEMO@DF_MOBILITY`, population
  mobility within regions) and bibliometric (`DSD_BIBLIO_F`, researcher
  flows). The *Broken Social Elevator* figures (generations to mean income,
  earnings elasticity) exist only in the 2018 report — hence the curated CSV.
- **Inequality:** `OECD.WISE.INE / DSD_WISE_IDD@DF_IDD` (Income Distribution
  Database) is the canonical source — Gini, S80/S20, poverty rates. This is
  what we pull. Regional variant: `DSD_REG_SOC@DF_INCOME_INEQ`. Well-being
  inequality: `DSD_HSL@DF_HSL_CWB_INEQ`. SDG 10: `DSD_SDG@DF_SDG_G_10`.
- **Earnings:** `OECD.ELS.SAE / DSD_EARNINGS@*` (decile ratios of gross
  earnings `DEC_I`, gender/age wage gaps, minimum-vs-average wages) and
  `DSD_EAR@DF_HOU_EAR` (hourly earnings) — candidate upgrades if the
  dashboard ever adds an earnings-dispersion panel. Education-related
  earnings premia live under `OECD.EDU.IMEP / DSD_EAG_LSO_EA@*`.

## The OECD SDMX API in one minute

- Catalog of everything: `https://sdmx.oecd.org/public/rest/dataflow/all/all/latest`
- A dataset ("dataflow") is addressed as `AGENCY,DATAFLOW_ID,VERSION` — e.g. the
  Income Distribution Database is `OECD.WISE.INE,DSD_WISE_IDD@DF_IDD,1.0`.
- Data pulls: `…/rest/data/<flow>/<key>?format=csvfilewithlabels`, where `<key>`
  is dot-separated dimension codes (blank = wildcard). The v2 endpoint accepts
  `c[DIMENSION]=code` query filters instead, which is easier.
- Gotcha: the v2 `c[AGE]=_T` filter is ignored on this dataflow — the CSV comes
  back with every age band and definition, so filter client-side on
  `AGE=_T`, `DEFINITION=D_CUR`, preferring `METHODOLOGY=METH2012`.
