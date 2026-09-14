"""Build data/gazetteer.json.gz: notable creators and notable works, from several sources.

  --sources dbpedia,gutenberg,wikidata   (default: dbpedia,gutenberg; wikidata is slow and often degraded)

DBpedia mirrors English Wikipedia and answers in seconds; notability = number of Wikipedia pages
linking to the entry. Wikidata gives cross-language notability (sitelink counts) when it is up.
The Project Gutenberg catalogue (pg_catalog.csv, one 20 MB download) gives every pre-1930 author with
several texts and ~50k titles: exactly the canon older books cite, and it never rate-limits.

Run: python scripts/build_gazetteer.py [--min-links 30] [--words words10k.txt] [--merge data/gazetteer.json.gz]
Output is ~200 KB and is committed, so users never run this.
"""
from __future__ import annotations

import csv
import io

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


DBPEDIA = "https://dbpedia.org/sparql"
# (class, minimum inbound wiki links, creator or work kind)
DBPEDIA_CREATORS = [("Writer", 80), ("Philosopher", 60), ("Painter", 40), ("Poet", 30)]
DBPEDIA_WORKS = [("Book", 60, "book"), ("Play", 60, "play"), ("Poem", 30, "poem"), ("Artwork", 40, "artwork"),
                 ("Film", 250, "film"), ("Album", 400, "music")]


def dbpedia(cls: str, min_links: int) -> list[str]:
    q = f"""SELECT ?name (COUNT(?x) AS ?n) WHERE {{
      ?p a dbo:{cls} ; rdfs:label ?name . FILTER(LANG(?name) = "en") ?x dbo:wikiPageWikiLink ?p
    }} GROUP BY ?name HAVING (COUNT(?x) > {min_links}) LIMIT 40000"""
    url = DBPEDIA + "?" + urllib.parse.urlencode({"query": q, "format": "text/csv"})
    for i in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/csv"})
            with urllib.request.urlopen(req, timeout=300) as r:
                rows = list(csv.reader(io.StringIO(r.read().decode("utf-8"))))
            return [re.sub(r"\s*\(.*?\)$", "", row[0]).strip() for row in rows[1:] if row]
        except Exception as e:
            print("  dbpedia retry", i, e, file=sys.stderr, flush=True)
            time.sleep(10 * (i + 1))
    return []


GUTENBERG_CATALOG = "https://www.gutenberg.org/cache/epub/feeds/pg_catalog.csv"
SKIP_AUTHORS = {"Various", "Anonymous", "Unknown"}
TITLE_NOISE = re.compile(r"\b(vol|volume|works|complete|part|selections|index|no\.|edition|illustrated|catalog(ue)?|report|bulletin|proceedings|journal|magazine|gazette|world factbook)\b", re.I)


def gutenberg(min_texts: int = 3, path: str = "") -> tuple[dict[str, str], dict[str, int]]:
    """Returns ({full name: surname}, {title: kind}) from the Gutenberg catalogue."""
    if path:
        raw = open(path, encoding="utf-8").read()
    else:
        req = urllib.request.Request(GUTENBERG_CATALOG, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=300) as r:
            raw = r.read().decode("utf-8")
    rows = [r for r in csv.DictReader(io.StringIO(raw)) if r.get("Type") == "Text"]
    count: dict[str, int] = {}
    for r in rows:
        for a in r["Authors"].split("; "):
            a = re.sub(r",\s*-?\d{3,4}\??-\d{0,4}\??$|,\s*-?\d{3,4}\??$", "", a).strip()  # drop ", 1865-1936"
            a = re.sub(r"\s*\[.*?\]", "", a).strip()
            if a and a not in SKIP_AUTHORS:
                count[a] = count.get(a, 0) + 1
    names: dict[str, str] = {}
    for a, n in count.items():
        if n < min_texts:
            continue
        # "Wells, H. G. (Herbert George)" -> surname Wells; full names "H. G. Wells" and "Herbert George Wells"
        m = re.match(r"^([^,]+),\s*([^,(]+?)(?:\s*\(([^)]+)\))?\s*(?:,.*)?$", a)
        if not m:
            if " " not in a and len(a) > 3:  # mononyms: Voltaire, Homer, Sophocles
                names[a] = a
            continue
        last, first, expanded = m.group(1).strip(), m.group(2).strip(), (m.group(3) or "").strip()
        last_word = last.split()[-1]
        names[f"{first} {last}"] = last_word
        if expanded:
            names[f"{expanded} {last}"] = last_word
    titles: dict[str, str] = {}
    for r in rows:
        if r["Language"] not in ("en", "fr", "de", "it", "es", "la", "el"):
            continue
        t = r["Title"].split("\n")[0].split(":")[0].split(";")[0].strip().rstrip(".")
        if 2 <= len(t.split()) <= 6 and not TITLE_NOISE.search(t) and re.match(r"^[A-Z]", t):
            titles[t] = "book"
    return names, titles


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-links", type=int, default=30, help="minimum Wikipedia language editions")
    ap.add_argument("--min-links-works", type=int, default=25)
    ap.add_argument("--words", default="", help="common English word list; names/titles in it are excluded")
    ap.add_argument("--out", default="data/gazetteer.json.gz")
    ap.add_argument("--merge", default="", help="existing gazetteer to merge into (use with --only to retry failed classes)")
    ap.add_argument("--only", default="", help="comma-separated QIDs to fetch; others are skipped")
    ap.add_argument("--sources", default="dbpedia,gutenberg")
    ap.add_argument("--gutenberg-catalog", default="", help="local pg_catalog.csv instead of downloading")
    ap.add_argument("--min-texts", type=int, default=3, help="Gutenberg: texts an author needs to count")
    a = ap.parse_args()
    sources = {x.strip() for x in a.sources.split(",")}
    only = {q.strip() for q in a.only.split(",") if q.strip()}

    common = set()
    if a.words:
        common = {w.strip().lower() for w in open(a.words) if w.strip()}

    names: dict[str, int] = {}
    if "dbpedia" in sources:
        for cls, min_links in DBPEDIA_CREATORS:
            rows = dbpedia(cls, min_links)
            print(f"dbpedia {cls}: {len(rows)}", file=sys.stderr, flush=True)
            for name in rows:
                if re.search(r"[^\w\s.'’\-]", name) or len(name) > 40:
                    continue
                names[name] = max(names.get(name, 0), min_links)
    for qid, label in CREATOR_CLASSES.items():
        if "wikidata" not in sources or (only and qid not in only):
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
    if "dbpedia" in sources:
        for cls, min_links, kind in DBPEDIA_WORKS:
            rows = dbpedia(cls, min_links)
            print(f"dbpedia {cls}: {len(rows)}", file=sys.stderr, flush=True)
            for t in rows:
                if len(t) < 4 or len(t) > 60 or re.search(r"[\[\]:/]", t):
                    continue
                words = t.split()
                if len(words) == 1 and (t.lower() in common or not t[0].isupper()):
                    continue
                if len(words) == 2 and all(w.lower() in common for w in words):
                    continue
                titles.setdefault(t, kind)
    if "gutenberg" in sources:
        g_names, g_titles = gutenberg(a.min_texts, a.gutenberg_catalog)
        print(f"gutenberg: {len(g_names)} names, {len(g_titles)} titles", file=sys.stderr, flush=True)
        for full, last in g_names.items():
            if re.search(r"[^\w\s.'’\-]", full) or len(full) > 40:
                continue
            fullnames.add(full)
            if len(last) < 4 or not last[0].isupper():
                continue
            if last.lower() in common:
                surnames_common.add(last)
            else:
                surnames.setdefault(last, 0)
        for t, kind in g_titles.items():
            words = t.split()
            if len(words) == 2 and all(w.lower() in common for w in words):
                continue
            titles.setdefault(t, kind)
    for qid, kind in WORK_CLASSES.items():
        if "wikidata" not in sources or (only and qid not in only):
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
