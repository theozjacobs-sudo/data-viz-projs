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
    # Full names catch cases where the surname alone was too common a word ("Henry James").
    for m in re.finditer(r"\b([A-Z][\w'’\-]+(?:\s+[A-Z]\.)*(?:\s+[A-Z][\w'’\-]+){1,2})\b", text):
        if m.group(1) in g["fullnames"]:
            names.append(m.group(1))
    if g["title_re"]:
        titles.extend(g["title_re"].findall(text))
    return names, titles
