"""Glue: file -> paragraphs -> prefilter -> chunks -> model -> canonical works -> SQLite."""
from __future__ import annotations

import os
import time
from dataclasses import dataclass

from . import db as dbm
from .epub_text import Book, load_epub, load_txt
from .llm import CANON_MODEL, EXTRACT_MODEL, estimate_cost, get_extractor
from .prefilter import pack, select
from .schema import CanonicalWork, Mention


@dataclass
class Plan:
    book: Book
    sent: int
    chunks: list
    estimate: dict


def load(path: str) -> Book:
    if path.lower().endswith(".epub"):
        return load_epub(path)
    return load_txt(path)


def plan(path: str, threshold: int = 3, model: str = EXTRACT_MODEL, batch: bool = False) -> Plan:
    book = load(path)
    kept = select(book.paragraphs, threshold)
    chunks = pack(kept)
    return Plan(book=book, sent=len(kept), chunks=chunks, estimate=estimate_cost(chunks, model, batch))


def _attach(mentions: list[Mention], works: list[CanonicalWork]):
    """Map each raw mention onto its canonical work via raw_titles (fallback: normalised title)."""
    by_raw: dict[str, CanonicalWork] = {}
    for w in works:
        for rt in w.raw_titles + [w.title]:
            by_raw[dbm.norm(rt)] = w
    pairs = []
    for m in mentions:
        w = by_raw.get(dbm.norm(m.title))
        if w is None:
            # Not merged by the canon pass: keep it as its own work rather than drop data.
            w = CanonicalWork(title=m.title, creator=m.creator, kind=m.kind, year=m.year, raw_titles=[m.title])
            by_raw[dbm.norm(m.title)] = w
            works.append(w)
        pairs.append((m, w))
    return pairs


def ingest(con, path: str, threshold: int = 3, model: str = EXTRACT_MODEL, canon_model: str = CANON_MODEL,
           batch: bool = False, progress=None, log=print) -> int:
    t0 = time.time()
    p = plan(path, threshold, model, batch)
    book = p.book
    log(f"{book.title} — {book.author}: {book.word_count:,} words, {len(book.paragraphs)} paragraphs, "
        f"{p.sent} sent in {len(p.chunks)} chunks, est ${p.estimate['usd']:.3f} on {model}")

    with dbm.tx(con):
        cur = con.execute(
            "INSERT INTO books(title, author, source_file, words, paragraphs_total, paragraphs_sent, chunks, model, status) "
            "VALUES (?,?,?,?,?,?,?,?,'running')",
            (book.title, book.author, os.path.basename(path), book.word_count, len(book.paragraphs), p.sent, len(p.chunks), model),
        )
        book_id = cur.lastrowid

    try:
        ex = get_extractor(model=model, canon_model=canon_model, batch=batch)
        mentions = ex.extract(p.chunks, progress=progress)
        # Drop the book citing itself and anything with no title.
        self_key = dbm.norm(book.title)
        mentions = [m for m in mentions if m.title.strip() and dbm.norm(m.title) != self_key]
        log(f"  {len(mentions)} raw mentions; canonicalising on {ex.canon_model}")
        works = ex.canonicalize(book.title, book.author, mentions)
        works = [w for w in works if dbm.norm(w.title) != self_key]
        pairs = _attach(mentions, works)
        with dbm.tx(con):
            for m, w in pairs:
                wid = dbm.upsert_work(con, w.title, w.creator, w.kind, w.year)
                con.execute(
                    "INSERT INTO mentions(book_id, work_id, paragraph, quote, how, raw_title) VALUES (?,?,?,?,?,?)",
                    (book_id, wid, m.paragraph, m.quote, m.how, m.title),
                )
            cost = ex.usage.cost(batch=batch)
            con.execute("UPDATE books SET status='done', cost_usd=? WHERE id=?", (cost, book_id))
        log(f"  done: {len(set(id(w) for _, w in pairs))} works, {len(pairs)} mentions, ${cost:.3f}, {time.time()-t0:.0f}s")
    except Exception as e:  # keep the row so the UI can show the failure
        with dbm.tx(con):
            con.execute("UPDATE books SET status='error', error=? WHERE id=?", (str(e)[:500], book_id))
        raise
    return book_id
