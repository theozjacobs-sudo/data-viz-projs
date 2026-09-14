"""Build data/gazetteer.json.gz from Wikidata: notable creators and notable works.

Run: python scripts/build_gazetteer.py [--min-links 30] [--words words10k.txt]
Needs network. Takes a few minutes. Output is a few MB and is committed, so users never run this.
"""
from __future__ import annotations

import argparse
import gzip
import json
import re
import sys
import time
import urllib.parse
import urllib.request

ENDPOINT = "https://query.wikidata.org/sparql"
UA = "influence-map/0.1 (https://github.com/theozjacobs-sudo/data-viz-projs)"

# occupation QIDs -> creator type
CREATOR_CLASSES = {
    "Q36180": "writer", "Q49757": "poet", "Q6625963": "novelist", "Q214917": "playwright",
    "Q4964182": "philosopher", "Q11774202": "essayist", "Q1930187": "journalist-author",
    "Q2526255": "film director", "Q28389": "screenwriter", "Q1028181": "painter",
    "Q1281618": "sculptor", "Q36834": "composer", "Q177220": "singer", "Q33231": "photographer",
    "Q201788": "historian", "Q1234713": "theologian", "Q170790": "mathematician", "Q901": "scientist",
}
# instance-of QIDs -> work kind
WORK_CLASSES = {
    "Q8261": "book", "Q7725634": "book", "Q571": "book", "Q47461344": "book", "Q35760": "book",
    "Q5185279": "poem", "Q37484": "poem", "Q25379": "play", "Q11424": "film", "Q5398426": "film",
    "Q3305213": "artwork", "Q860861": "artwork", "Q207628": "music", "Q482994": "music", "Q1344": "music",
    "Q9748": "music", "Q179461": "book", "Q1667921": "book",
}


PAUSE = 62  # WDQS sometimes rate-limits anonymous clients to one request a minute; be polite by default


def sparql(query: str, retries: int = 6) -> list[dict]:
    url = ENDPOINT + "?" + urllib.parse.urlencode({"query": query, "format": "json"})
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/sparql-results+json"})
            with urllib.request.urlopen(req, timeout=300) as r:
                rows = json.load(r)["results"]["bindings"]
            time.sleep(PAUSE)
            return rows
        except Exception as e:  # timeouts, 429s and truncated bodies are routine
            print("  retry", i, e, file=sys.stderr, flush=True)
            time.sleep(PAUSE * (i + 1))
    return []


def fetch_creators(qid: str, min_links: int) -> list[tuple[str, int]]:
    q = f"""SELECT ?label ?links WHERE {{
      ?p wdt:P106 wd:{qid}; wikibase:sitelinks ?links; rdfs:label ?label .
      FILTER(?links >= {min_links}) FILTER(LANG(?label) = "en")
    }}"""
    return [(b["label"]["value"], int(b["links"]["value"])) for b in sparql(q)]


def fetch_works(qid: str, min_links: int) -> list[tuple[str, int]]:
    q = f"""SELECT ?label ?links WHERE {{
      ?w wdt:P31 wd:{qid}; wikibase:sitelinks ?links; rdfs:label ?label .
      FILTER(?links >= {min_links}) FILTER(LANG(?label) = "en")
    }}"""
    return [(b["label"]["value"], int(b["links"]["value"])) for b in sparql(q)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-links", type=int, default=30, help="minimum Wikipedia language editions")
    ap.add_argument("--min-links-works", type=int, default=25)
    ap.add_argument("--words", default="", help="common English word list; names/titles in it are excluded")
    ap.add_argument("--out", default="data/gazetteer.json.gz")
    ap.add_argument("--merge", default="", help="existing gazetteer to merge into (use with --only to retry failed classes)")
    ap.add_argument("--only", default="", help="comma-separated QIDs to fetch; others are skipped")
    a = ap.parse_args()
    only = {q.strip() for q in a.only.split(",") if q.strip()}

    common = set()
    if a.words:
        common = {w.strip().lower() for w in open(a.words) if w.strip()}

    names: dict[str, int] = {}
    for qid, label in CREATOR_CLASSES.items():
        if only and qid not in only:
            continue
        rows = fetch_creators(qid, a.min_links)
        print(f"{label}: {len(rows)}", file=sys.stderr, flush=True)
        for name, links in rows:
            if re.search(r"[^\w\s.'’\-]", name) or len(name) > 40:
                continue
            names[name] = max(names.get(name, 0), links)

    surnames: dict[str, int] = {}
    surnames_common: set[str] = set()  # Gray, Pope, Lamb, Wells, Swift: only count with an honorific or initial
    fullnames: set[str] = set()
    for name, links in names.items():
        parts = name.replace(".", " ").split()
        if len(parts) >= 2:
            fullnames.add(name)
        last = parts[-1]
        if len(last) < 4 or not last[0].isupper():
            continue
        if last.lower() in common:
            surnames_common.add(last)
            continue
        surnames[last] = max(surnames.get(last, 0), links)

    titles: dict[str, str] = {}
    for qid, kind in WORK_CLASSES.items():
        if only and qid not in only:
            continue
        rows = fetch_works(qid, a.min_links_works)
        print(f"{kind} {qid}: {len(rows)}", file=sys.stderr, flush=True)
        for t, links in rows:
            if len(t) < 4 or len(t) > 60 or re.search(r"[\(\)\[\]:/]", t):
                continue
            words = t.split()
            if len(words) == 1 and (t.lower() in common or not t[0].isupper()):
                continue  # "It", "Her", "Jaws", "Persuasion"...
            if len(words) == 2 and all(w.lower() in common for w in words):
                continue  # "The Road", "Little Women" style titles are too common as phrases
            titles[t] = kind

    if a.merge:
        with gzip.open(a.merge, "rt", encoding="utf-8") as f:
            prev = json.load(f)
        for k in prev.get("surnames", []):
            surnames.setdefault(k, 0)
        surnames_common.update(prev.get("surnames_common", []))
        fullnames.update(prev.get("fullnames", []))
        titles = {**prev.get("titles", {}), **titles}
    out = {"surnames": sorted(surnames), "surnames_common": sorted(surnames_common), "fullnames": sorted(fullnames), "titles": titles}
    with gzip.open(a.out, "wt", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    print(f"wrote {a.out}: {len(surnames)} surnames, {len(surnames_common)} common-word surnames, {len(fullnames)} full names, {len(titles)} titles", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
