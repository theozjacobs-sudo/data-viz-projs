"""Write a static, read-only copy of the site from library.db, for GitHub Pages or any file host.

Every page the app serves is rendered once and saved with relative links, so the folder works from
any URL prefix. Upload and delete controls are omitted.
"""
from __future__ import annotations

import os
import re
import shutil
from pathlib import Path

from .app import STATIC, make_app
from . import db as dbm


def export(db_path: str, out: str) -> list[str]:
    from fastapi.testclient import TestClient

    app = make_app(db_path, readonly=True)
    client = TestClient(app)
    con = dbm.connect(db_path)
    ids = [r["id"] for r in con.execute("SELECT id FROM books WHERE status='done'")]

    def relink(html: str) -> str:
        html = re.sub(r"href='/book/(\d+)'", r"href='book-\1.html'", html)
        html = html.replace("href='/graph'", "href='graph.html'").replace("href='/reading'", "href='reading.html'")
        html = html.replace("href='/'", "href='index.html'").replace("'/static/", "'static/")
        return html

    outp = Path(out)
    outp.mkdir(parents=True, exist_ok=True)
    written = []
    pages = {"index.html": "/", "graph.html": "/graph", "reading.html": "/reading"}
    pages.update({f"book-{i}.html": f"/book/{i}" for i in ids})
    for name, route in pages.items():
        r = client.get(route)
        r.raise_for_status()
        (outp / name).write_text(relink(r.text), encoding="utf-8")
        written.append(name)
    (outp / "api").mkdir(exist_ok=True)
    (outp / "api" / "graph.json").write_text(client.get("/api/graph").text, encoding="utf-8")
    (outp / "api" / "reading.json").write_text(client.get("/api/reading").text, encoding="utf-8")
    (outp / "api" / "books.json").write_text(client.get("/api/books").text, encoding="utf-8")
    shutil.copytree(STATIC, outp / "static", dirs_exist_ok=True)
    js = (outp / "static" / "graph.js").read_text(encoding="utf-8").replace("fetch('/api/graph')", "fetch('api/graph.json')")
    (outp / "static" / "graph.js").write_text(js, encoding="utf-8")
    (outp / ".nojekyll").write_text("")
    return written
