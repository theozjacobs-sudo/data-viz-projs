"""Outbound links for a work. No API keys: these are search URLs on catalogues that resolve well."""
from __future__ import annotations

from urllib.parse import quote_plus


def link_for(title: str, creator: str | None, kind: str) -> str:
    q = quote_plus(f"{title} {creator or ''}".strip())
    if kind in ("film",):
        return f"https://letterboxd.com/search/{q}/"
    if kind == "artwork":
        return f"https://artsandculture.google.com/search?q={q}"
    if kind == "music":
        return f"https://musicbrainz.org/search?query={q}&type=work&method=indexed"
    # books, plays, poems, essays, other
    return f"https://openlibrary.org/search?q={q}"
