#!/usr/bin/env python3
"""Why did inequality rise? Decompositions from the live IDD pull.

Reads  data/idd_data.csv  (needs INC_DISP_GINI, INC_MRKT_GINI,
       D9_5_INC_DISP, D5_1_INC_DISP — fetch_oecd.py provides them)
Prints three analyses (results written up in ANALYSIS.md):

1. Market-vs-redistribution decomposition (working age, mid-1980s -> latest):
   disposable Gini = market Gini x (1 - redistribution share). Holding the
   1980s redistribution share fixed against today's market Gini splits the
   observed change into a market component and a redistribution component.
2. Where the distribution stretched: P90/P50 (top pulling away) vs P50/P10
   (floor falling behind), total population.
3. Great Gatsby correlation: earnings persistence vs latest and mid-80s Gini.

Stdlib only.
"""
import csv
import json
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "idd_data.csv"


def series(measure, age):
    """iso3 -> {year: value}; current definition, METH2012 wins overlap years."""
    out, meth = defaultdict(dict), defaultdict(dict)
    with DATA.open(newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if r["MEASURE"] != measure or r["AGE"] != age or r["DEFINITION"] != "D_CUR":
                continue
            try:
                y, v = int(r["TIME_PERIOD"]), float(r["OBS_VALUE"])
            except ValueError:
                continue
            iso = r["REF_AREA"]
            if y not in out[iso] or (
                r["METHODOLOGY"] == "METH2012" and meth[iso].get(y) != "METH2012"
            ):
                out[iso][y] = v
                meth[iso][y] = r["METHODOLOGY"]
    return out


def decomposition():
    disp = series("INC_DISP_GINI", "Y18T65")
    mkt = series("INC_MRKT_GINI", "Y18T65")
    print("1. Working-age Gini: market vs redistribution, mid-1980s -> latest")
    print(f"{'iso':4} {'years':>9}  {'redist then':>11} {'redist now':>10}"
          f"  {'dDisp':>6} {'market part':>11} {'redistr part':>12}")
    for iso in sorted(mkt):
        m, d = mkt[iso], disp.get(iso, {})
        old = [y for y in set(m) & set(d) if 1983 <= y <= 1990]
        common = set(m) & set(d)
        if not old or not common or max(common) <= 2015:
            continue
        y0, y1 = min(old), max(common)
        r0, r1 = 1 - d[y0] / m[y0], 1 - d[y1] / m[y1]
        cf = m[y1] * (1 - r0)  # today's market Gini, 1980s redistribution
        print(f"{iso:4} {y0}-{y1}  {r0:11.1%} {r1:10.1%}"
              f"  {d[y1]-d[y0]:+6.3f} {cf-d[y0]:+11.3f} {d[y1]-cf:+12.3f}")


def stretch():
    top, bot = series("D9_5_INC_DISP", "_T"), series("D5_1_INC_DISP", "_T")
    print("\n2. Where the distribution stretched (total population)")
    print(f"{'iso':4} {'years':>9}  {'P90/P50':>22}  {'P50/P10':>22}")
    for iso in sorted(set(top) & set(bot)):
        t, b = top[iso], bot[iso]
        common = sorted(set(t) & set(b))
        old = [y for y in common if y <= 1990]
        if not old or not common or common[-1] <= 2015:
            continue
        y0, y1 = old[0], common[-1]
        print(f"{iso:4} {y0}-{y1}  {t[y0]:5.2f} -> {t[y1]:5.2f} ({t[y1]-t[y0]:+.2f})"
              f"   {b[y0]:5.2f} -> {b[y1]:5.2f} ({b[y1]-b[y0]:+.2f})")


def gatsby():
    html = (ROOT / "site" / "index.html").read_text(encoding="utf-8")
    start = html.find('{"live":')
    depth = 0
    for i in range(start, len(html)):
        if html[i] == "{":
            depth += 1
        elif html[i] == "}":
            depth -= 1
            if depth == 0:
                countries = json.loads(html[start:i + 1])["countries"]
                break
    cs = [c for c in countries if c["elasticity"] is not None]

    def corr(pairs):
        xs, ys = zip(*pairs)
        n = len(xs)
        mx, my = sum(xs) / n, sum(ys) / n
        cov = sum((x - mx) * (y - my) for x, y in pairs)
        vx = sum((x - mx) ** 2 for x in xs)
        vy = sum((y - my) ** 2 for y in ys)
        return cov / (vx * vy) ** 0.5, n

    r_now = corr([(c["gini"], c["elasticity"]) for c in cs if c["gini"]])
    both = [c for c in cs if c["gini"] and c["gini85"]]
    r_now_s = corr([(c["gini"], c["elasticity"]) for c in both])
    r_then_s = corr([(c["gini85"], c["elasticity"]) for c in both])
    print("\n3. Great Gatsby correlation (Gini vs earnings persistence)")
    print(f"   latest Gini, n={r_now[1]}: r={r_now[0]:+.2f}")
    print(f"   same {r_now_s[1]} countries: latest r={r_now_s[0]:+.2f},"
          f" mid-80s r={r_then_s[0]:+.2f}")


if __name__ == "__main__":
    decomposition()
    stretch()
    gatsby()
