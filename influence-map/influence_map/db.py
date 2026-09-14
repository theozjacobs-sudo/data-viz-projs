"""SQLite store. One file, three tables, plus the derived graph and recommendation queries."""
from __future__ import annotations

import re
import sqlite3
from contextlib import contextmanager

SCHEMA = """
CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL, source_file TEXT,
  words INTEGER, paragraphs_total INTEGER, paragraphs_sent INTEGER, chunks INTEGER,
  model TEXT, cost_usd REAL, status TEXT DEFAULT 'done', error TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS works (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, creator TEXT, kind TEXT NOT NULL, year INTEGER,
  norm_key TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS mentions (
  id INTEGER PRIMARY KEY, book_id INTEGER REFERENCES books(id) ON DELETE CASCADE,
  work_id INTEGER REFERENCES works(id), paragraph INTEGER, quote TEXT, how TEXT, raw_title TEXT
);
CREATE INDEX IF NOT EXISTS idx_mentions_book ON mentions(book_id);
CREATE INDEX IF NOT EXISTS idx_mentions_work ON mentions(work_id);
"""


def norm(s: str | None) -> str:
    s = (s or "").lower()
    s = re.sub(r"^(the|a|an)\s+", "", s)
    s = re.sub(r"[^a-z0-9]+", " ", s).strip()
    return s


def surname(creator: str | None) -> str:
    if not creator:
        return ""
    c = creator.split(";")[0].split(",")[0].strip()
    return norm(c.split()[-1]) if c.split() else ""


def work_key(title: str, creator: str | None) -> str:
    return f"{norm(title)}|{surname(creator)}"


def connect(path: str) -> sqlite3.Connection:
    con = sqlite3.connect(path, check_same_thread=False)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    con.executescript(SCHEMA)
    return con


@contextmanager
def tx(con: sqlite3.Connection):
    try:
        yield con
        con.commit()
    except Exception:
        con.rollback()
        raise


def upsert_work(con, title, creator, kind, year) -> int:
    key = work_key(title, creator)
    row = con.execute("SELECT id, creator, year FROM works WHERE norm_key=?", (key,)).fetchone()
    if row:
        # Fill in blanks learned from a later book.
        if (not row["creator"] and creator) or (not row["year"] and year):
            con.execute("UPDATE works SET creator=COALESCE(creator,?), year=COALESCE(year,?) WHERE id=?", (creator, year, row["id"]))
        return row["id"]
    # Same title, no creator known yet on one side: merge onto the titled+creator version.
    if creator:
        bare = con.execute("SELECT id FROM works WHERE norm_key=?", (f"{norm(title)}|",)).fetchone()
        if bare:
            con.execute("UPDATE works SET creator=?, year=COALESCE(year,?), norm_key=? WHERE id=?", (creator, year, key, bare["id"]))
            return bare["id"]
    else:
        like = con.execute("SELECT id FROM works WHERE norm_key LIKE ?", (f"{norm(title)}|%",)).fetchone()
        if like:
            return like["id"]
    cur = con.execute("INSERT INTO works(title, creator, kind, year, norm_key) VALUES (?,?,?,?,?)", (title, creator, kind, year, key))
    return cur.lastrowid


# ---- queries -----------------------------------------------------------------------------------

def books(con):
    return con.execute(
        """SELECT b.*, (SELECT COUNT(DISTINCT work_id) FROM mentions m WHERE m.book_id=b.id) AS n_works
           FROM books b ORDER BY created_at DESC"""
    ).fetchall()


def book_works(con, book_id: int):
    return con.execute(
        """SELECT w.*, COUNT(m.id) AS n, MIN(m.paragraph) AS first_para,
                  SUM(m.how='discussed') AS discussed, SUM(m.how='quoted') AS quoted
           FROM mentions m JOIN works w ON w.id=m.work_id WHERE m.book_id=?
           GROUP BY w.id ORDER BY n DESC, w.title"""
        , (book_id,)).fetchall()


def work_mentions(con, book_id: int, work_id: int):
    return con.execute("SELECT * FROM mentions WHERE book_id=? AND work_id=? ORDER BY paragraph", (book_id, work_id)).fetchall()


def library_keys(con) -> dict[str, int]:
    """norm title -> book id, for every uploaded book, so recommendations skip what you own."""
    return {norm(r["title"]): r["id"] for r in con.execute("SELECT id, title FROM books")}


def recommendations(con, limit: int = 100):
    owned = library_keys(con)
    rows = con.execute(
        """SELECT w.*, COUNT(DISTINCT m.book_id) AS n_books, COUNT(m.id) AS n_mentions,
                  SUM(m.how IN ('discussed','quoted')) AS n_engaged,
                  GROUP_CONCAT(DISTINCT b.author) AS cited_by
           FROM mentions m JOIN works w ON w.id=m.work_id JOIN books b ON b.id=m.book_id
           GROUP BY w.id ORDER BY n_books DESC, n_engaged DESC, n_mentions DESC LIMIT ?""",
        (limit * 2,),
    ).fetchall()
    out = []
    for r in rows:
        if norm(r["title"]) in owned:
            continue
        out.append(r)
        if len(out) >= limit:
            break
    return out


def author_graph(con):
    """Nodes are creators. Edge A->B: A (an uploaded author) cites B's work. Weight = mentions."""
    rows = con.execute(
        """SELECT b.author AS src, w.creator AS dst, COUNT(m.id) AS n, COUNT(DISTINCT b.id) AS n_books,
                  COUNT(DISTINCT w.id) AS n_works
           FROM mentions m JOIN works w ON w.id=m.work_id JOIN books b ON b.id=m.book_id
           WHERE w.creator IS NOT NULL AND w.creator<>''
           GROUP BY b.author, w.creator"""
    ).fetchall()
    uploaded = {r["author"]: r["title"] for r in con.execute("SELECT author, title FROM books")}
    nodes: dict[str, dict] = {}
    edges = []
    for r in rows:
        src, dst = r["src"], r["dst"]
        if surname(src) == surname(dst):
            continue  # self-citation
        for name in (src, dst):
            nodes.setdefault(name, {"id": name, "uploaded": name in uploaded, "in": 0, "out": 0})
        nodes[src]["out"] += r["n"]
        nodes[dst]["in"] += r["n"]
        edges.append({"source": src, "target": dst, "n": r["n"], "n_books": r["n_books"], "n_works": r["n_works"]})
    return {"nodes": list(nodes.values()), "edges": edges}


def delete_book(con, book_id: int):
    with tx(con):
        con.execute("DELETE FROM mentions WHERE book_id=?", (book_id,))
        con.execute("DELETE FROM books WHERE id=?", (book_id,))
        con.execute("DELETE FROM works WHERE id NOT IN (SELECT DISTINCT work_id FROM mentions)")
