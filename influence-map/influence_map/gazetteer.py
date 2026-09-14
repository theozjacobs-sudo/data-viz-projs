"""Lookup of notable creator names and work titles, built from Wikidata by scripts/build_gazetteer.py.

Used as one more prefilter signal: a paragraph that names Sophocles or Middlemarch is worth sending
even if it has no italics and none of the usual vocabulary. Matching is case-sensitive on
capitalised tokens so that "pope" or "gray" in running prose do not fire.
"""
from __future__ import annotations

import gzip
import json
import re
from functools import lru_cache
from pathlib import Path

PATH = Path(__file__).resolve().parent.parent / "data" / "gazetteer.json.gz"
TOKEN = re.compile(r"[A-Z][\w'’\-]+")
# "Mr. Wells", "H. G. Wells", "Sir Walter", "Dean Swift": a common-word surname is a name when introduced like this.
NAME_TOKEN = r"[A-Z][a-z\-]+(?:['’][A-Z][a-z]+)?"  # Wells, Saint-Simon, O'Brien; stops before a possessive 's
HONORIFIC_NAME = re.compile(r"\b(?:(?:Mr|Mrs|Miss|Ms|Dr|Sir|Lord|Lady|Dame|Dean|St|Saint|Professor|Bishop|Father)\.?|(?:[A-Z]\.\s*)+)\s*(" + NAME_TOKEN + r")\b")
FULLNAME = re.compile(r"(?<![\w.])((?:[A-Z]\.\s*)*" + NAME_TOKEN + r"(?:\s+[A-Z]\.)*(?:\s+(?:de|van|von|di|da|la|le|del|der))?(?:\s+" + NAME_TOKEN + r"){1,2})\b")


@lru_cache(maxsize=1)
def load() -> dict:
    if not PATH.exists():
        return {"surnames": set(), "fullnames": set(), "titles": {}, "title_re": None}
    with gzip.open(PATH, "rt", encoding="utf-8") as f:
        g = json.load(f)
    titles = g.get("titles", {})
    # One alternation regex for multi-word titles, longest first; single-word titles use the token set.
    multi = sorted((t for t in titles if " " in t), key=len, reverse=True)
    title_re = re.compile(r"(?<![\w'’])(" + "|".join(re.escape(t) for t in multi) + r")(?![\w'’])") if multi else None
    return {
        "surnames": set(g.get("surnames", [])),
        "surnames_common": set(g.get("surnames_common", [])),
        "fullnames": set(g.get("fullnames", [])),
        "single_titles": {t for t in titles if " " not in t},
        "title_re": title_re,
        "n": (len(g.get("surnames", [])), len(g.get("fullnames", [])), len(titles)),
    }


def hits(text: str) -> tuple[list[str], list[str]]:
    """Return (names, titles) found in text. Empty lists if the gazetteer is absent."""
    g = load()
    if not g["surnames"] and not g["title_re"]:
        return [], []
    text = re.sub(r"\s+", " ", text)
    names, titles = [], []
    toks = TOKEN.findall(text)
    for i, tok in enumerate(toks):
        t = tok.strip("'’-")
        if t in g["single_titles"]:
            titles.append(t)
        if t in g["surnames"]:
            # Sentence-initial capitalised words are ambiguous ("Frost covered the field"); require
            # either a preceding capitalised token (a first name / honorific) or a mid-sentence position.
            names.append(t)
    # Full names catch cases where the surname alone was too common a word ("Henry James", "H. G. Wells").
    for m in FULLNAME.finditer(text):
        cand = re.sub(r"\.\s*", ". ", m.group(1)).strip()
        if cand in g["fullnames"]:
            names.append(cand)
    for m in HONORIFIC_NAME.finditer(text):
        if m.group(1) in g["surnames_common"] or m.group(1) in g["surnames"]:
            names.append(m.group(1))
    if g["title_re"]:
        titles.extend(g["title_re"].findall(text))
    return names, titles
