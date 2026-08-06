#!/usr/bin/env python3
"""Merge the curated/fetched datasets and render the dashboard.

Reads  data/mobility_snapshot.csv  (generations + earnings elasticity)
       data/gini_provisional.csv   (curated Gini, latest + mid-1980s)
       data/idd_data.csv           (live SDMX pull — optional, preferred)
Writes site/index.html             (site/template.html with data inlined)

Stdlib only. Re-run after fetch_oecd.py succeeds to upgrade the dashboard
from provisional to live OECD data.
"""
import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SITE = ROOT / "site"
TOKEN = "/*__DATA__*/null"


def read_csv(path):
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def num(row, key):
    v = row.get(key, "").strip()
    return float(v) if v else None


def load_live_idd():
    """If fetch_oecd.py has run, build per-country annual Gini series from it.

    Returns (series, latest, mid80s) keyed by iso3, or (None, {}, {}).
    The live CSV is csvfilewithlabels: REF_AREA, MEASURE, TIME_PERIOD, OBS_VALUE
    columns among others; we keep INC_DISP_GINI for the total population.
    """
    path = DATA / "idd_data.csv"
    if not path.exists():
        return None, {}, {}
    series = {}
    for row in read_csv(path):
        # The v2 API ignores the c[AGE] filter, so the CSV carries every age
        # breakdown and definition; keep total population, current definition.
        if row.get("MEASURE") != "INC_DISP_GINI":
            continue
        if row.get("AGE") != "_T" or row.get("DEFINITION") != "D_CUR":
            continue
        iso3 = row.get("REF_AREA", "")
        try:
            year = int(row.get("TIME_PERIOD", ""))
            val = float(row.get("OBS_VALUE", ""))
        except ValueError:
            continue
        series.setdefault(iso3, {})
        # Prefer the newer methodology when both report the same year.
        meth = row.get("METHODOLOGY", "")
        if year not in series[iso3] or meth == "METH2012":
            series[iso3][year] = val
    latest, mid80s = {}, {}
    for iso3, by_year in series.items():
        years = sorted(by_year)
        latest[iso3] = {"gini": by_year[years[-1]], "year": years[-1]}
        anchor = [y for y in years if 1983 <= y <= 1989]
        if anchor:
            mid80s[iso3] = {"gini": by_year[anchor[0]], "year": anchor[0]}
    series_out = {k: sorted([y, v] for y, v in d.items()) for k, d in series.items()}
    return series_out, latest, mid80s


def main() -> int:
    mobility = {r["iso3"]: r for r in read_csv(DATA / "mobility_snapshot.csv")}
    gini = {r["iso3"]: r for r in read_csv(DATA / "gini_provisional.csv")}
    live_series, live_latest, live_mid80s = load_live_idd()

    countries = []
    for iso3, m in mobility.items():
        g = gini.get(iso3, {})
        row = {
            "iso3": iso3,
            "name": m["country"],
            "generations": int(m["generations_to_mean_income"]),
            "elasticity": num(m, "earnings_elasticity"),
            "elasticitySource": m["elasticity_source"],
            "gini": num(g, "gini_latest"),
            "giniYear": num(g, "gini_latest_year"),
            "gini85": num(g, "gini_mid80s"),
            "gini85Year": num(g, "gini_mid80s_year"),
            "scope": g.get("scope", ""),
        }
        if iso3 in live_latest:
            row["gini"] = round(live_latest[iso3]["gini"], 3)
            row["giniYear"] = live_latest[iso3]["year"]
            row["scope"] = "oecd_idd_live"
        if iso3 in live_mid80s:
            row["gini85"] = round(live_mid80s[iso3]["gini"], 3)
            row["gini85Year"] = live_mid80s[iso3]["year"]
        countries.append(row)
    countries.sort(key=lambda r: (r["generations"], r["name"]))

    payload = {
        "live": live_series is not None,
        "countries": countries,
        "series": live_series or {},
    }

    template = (SITE / "template.html").read_text(encoding="utf-8")
    assert TOKEN in template, "template is missing the data token"
    out = template.replace(TOKEN, json.dumps(payload, separators=(",", ":")))
    (SITE / "index.html").write_text(out, encoding="utf-8")
    mode = "LIVE OECD API data" if payload["live"] else "provisional curated data"
    print(f"site/index.html written with {mode}: {len(countries)} countries")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
