"""FastAPI app: upload EPUBs, browse what each book cites, see the author graph and a reading list."""
from __future__ import annotations

import html
import json
import os
import threading
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from . import db as dbm
from .links import link_for
from .llm import CANON_MODEL, EXTRACT_MODEL, PRICES
from .pipeline import ingest

STATIC = Path(__file__).resolve().parent.parent / "static"
KIND_LABEL = {"book": "Books", "play": "Plays", "poem": "Poems", "film": "Film & TV", "artwork": "Art", "music": "Music", "other": "Other",
              "person": "People named without a specific work"}
KIND_ORDER = ["book", "play", "poem", "film", "artwork", "music", "other", "person"]


def e(s) -> str:
    return html.escape("" if s is None else str(s))


def page(title: str, body: str, extra_head: str = "") -> HTMLResponse:
    nav = ('<nav><a href="/">Library</a><a href="/graph">Influence graph</a><a href="/reading">Reading list</a></nav>')
    return HTMLResponse(
        f"<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>"
        f"<title>{e(title)} · Influence Map</title><link rel='stylesheet' href='/static/style.css'>{extra_head}</head>"
        f"<body><header><a class='brand' href='/'>Influence Map</a>{nav}</header><main>{body}</main></body></html>"
    )


def make_app(db_path: str = "library.db", upload_dir: str = "uploads") -> FastAPI:
    app = FastAPI(title="Influence Map")
    app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")
    os.makedirs(upload_dir, exist_ok=True)
    lock = threading.Lock()

    def con():
        return dbm.connect(db_path)

    # ------------------------------------------------------------------ library
    @app.get("/", response_class=HTMLResponse)
    def index():
        c = con()
        rows = dbm.books(c)
        running = any(r["status"] == "running" for r in rows)
        opts = "".join(f"<option value='{m}' {'selected' if m == EXTRACT_MODEL else ''}>{m} (${p[0]:.0f}/M in)</option>" for m, p in PRICES.items())
        form = f"""
        <section class='card'>
          <h2>Add books</h2>
          <form method='post' action='/upload' enctype='multipart/form-data' class='upload'>
            <input type='file' name='files' accept='.epub,.txt' multiple required>
            <label>Extraction model <select name='model'>{opts}</select></label>
            <label>Filter strictness <input type='number' name='threshold' value='3' min='0' max='6' title='0 sends every paragraph'></label>
            <label><input type='checkbox' name='batch' value='1'> Batch API (half price, up to an hour)</label>
            <button type='submit'>Upload &amp; scan</button>
          </form>
          <p class='muted'>Footnotes, endnotes, bibliographies and indexes are stripped before anything reaches the model. Second pass on {e(CANON_MODEL)} merges duplicates.</p>
        </section>"""
        if not rows:
            lst = "<p class='muted'>No books yet.</p>"
        else:
            trs = []
            for r in rows:
                st = r["status"]
                badge = {"running": "<span class='badge run'>scanning…</span>", "error": f"<span class='badge err' title='{e(r['error'])}'>error</span>"}.get(st, "")
                cost = f"${r['cost_usd']:.3f}" if r["cost_usd"] is not None else "—"
                trs.append(
                    f"<tr><td><a href='/book/{r['id']}'>{e(r['title'])}</a> {badge}</td><td>{e(r['author'])}</td>"
                    f"<td class='num'>{r['words'] or 0:,}</td><td class='num'>{r['paragraphs_sent']}/{r['paragraphs_total']}</td>"
                    f"<td class='num'>{r['n_works']}</td><td class='num'>{cost}</td>"
                    f"<td><form method='post' action='/book/{r['id']}/delete' onsubmit='return confirm(\"Remove this book?\")'><button class='link'>remove</button></form></td></tr>"
                )
            total = sum((r["cost_usd"] or 0) for r in rows)
            lst = (f"<table><thead><tr><th>Title</th><th>Author</th><th class='num'>Words</th><th class='num'>¶ sent</th><th class='num'>Works cited</th><th class='num'>Cost</th><th></th></tr></thead>"
                   f"<tbody>{''.join(trs)}</tbody><tfoot><tr><td colspan='5'>{len(rows)} books</td><td class='num'>${total:.2f}</td><td></td></tr></tfoot></table>")
        refresh = "<meta http-equiv='refresh' content='5'>" if running else ""
        return page("Library", form + f"<section class='card'><h2>Library</h2>{lst}</section>", refresh)

    @app.post("/upload")
    async def upload(background: BackgroundTasks, files: list[UploadFile] = File(...), model: str = Form(EXTRACT_MODEL),
                     threshold: int = Form(3), batch: str | None = Form(None)):
        paths = []
        for f in files:
            name = os.path.basename(f.filename or "book.epub")
            dest = os.path.join(upload_dir, name)
            with open(dest, "wb") as out:
                out.write(await f.read())
            paths.append(dest)

        def run():
            with lock:  # one book at a time keeps rate limits and the SQLite file happy
                c = con()
                for p in paths:
                    try:
                        ingest(c, p, threshold=threshold, model=model, batch=bool(batch))
                    except Exception as ex:  # row is already marked error
                        print("ingest failed:", p, ex)

        background.add_task(run)
        return RedirectResponse("/", status_code=303)

    @app.post("/book/{book_id}/delete")
    def delete(book_id: int):
        dbm.delete_book(con(), book_id)
        return RedirectResponse("/", status_code=303)

    # ------------------------------------------------------------------ book page
    @app.get("/book/{book_id}", response_class=HTMLResponse)
    def book(book_id: int):
        c = con()
        b = c.execute("SELECT * FROM books WHERE id=?", (book_id,)).fetchone()
        if not b:
            raise HTTPException(404)
        works = dbm.book_works(c, book_id)
        by_kind: dict[str, list] = {}
        for w in works:
            by_kind.setdefault(w["kind"], []).append(w)
        sections = []
        for kind in KIND_ORDER:
            ws = by_kind.get(kind)
            if not ws:
                continue
            items = []
            for w in ws:
                ms = dbm.work_mentions(c, book_id, w["id"])
                quotes = "".join(f"<li>¶{m['paragraph']} <span class='how'>{e(m['how'])}</span> “{e(m['quote'])}”</li>" for m in ms[:8])
                more = f"<li class='muted'>…and {len(ms) - 8} more</li>" if len(ms) > 8 else ""
                yr = f" <span class='muted'>({w['year']})</span>" if w["year"] else ""
                who = f" <span class='creator'>{e(w['creator'])}</span>" if w["creator"] and kind != "person" else ""
                items.append(
                    f"<details><summary><a href='{e(link_for(w['title'], w['creator'], kind))}' target='_blank' rel='noopener'>{e(w['title'])}</a>{who}{yr}"
                    f"<span class='count'>{w['n']}×</span></summary><ul class='quotes'>{quotes}{more}</ul></details>"
                )
            sections.append(f"<section class='card'><h2>{KIND_LABEL.get(kind, kind)} <span class='muted'>{len(ws)}</span></h2>{''.join(items)}</section>")
        if not sections:
            sections.append(f"<section class='card'><p class='muted'>Nothing extracted yet ({e(b['status'])}).</p></section>")
        head = (f"<h1>{e(b['title'])}</h1><p class='sub'>{e(b['author'])} · {b['words'] or 0:,} words · {len(works)} works cited · "
                f"{b['paragraphs_sent']} of {b['paragraphs_total']} paragraphs scanned on {e(b['model'])}"
                + (f" · ${b['cost_usd']:.3f}" if b["cost_usd"] is not None else "") + "</p>")
        return page(b["title"], head + "".join(sections))

    # ------------------------------------------------------------------ graph
    @app.get("/graph", response_class=HTMLResponse)
    def graph():
        body = ("<h1>Who cites whom</h1><p class='sub'>Arrows run from an uploaded author to the creators they mention. "
                "Thicker = more mentions. Filled nodes are authors in your library; click a node to isolate it.</p>"
                "<div id='graph' class='card'></div><div id='side' class='card'></div>")
        head = ("<script src='https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js'></script>"
                "<script defer src='/static/graph.js'></script>")
        return page("Influence graph", body, head)

    @app.get("/api/graph")
    def api_graph():
        return JSONResponse(dbm.author_graph(con()))

    # ------------------------------------------------------------------ reading list
    @app.get("/reading", response_class=HTMLResponse)
    def reading():
        c = con()
        recs = dbm.recommendations(c, 150)
        n_books = c.execute("SELECT COUNT(*) FROM books").fetchone()[0]
        rows = []
        for r in recs:
            yr = f" ({r['year']})" if r["year"] else ""
            rows.append(
                f"<tr><td><a href='{e(link_for(r['title'], r['creator'], r['kind']))}' target='_blank' rel='noopener'>{e(r['title'])}</a>"
                f"<span class='muted'>{yr}</span></td><td>{e(r['creator'] or '')}</td><td>{e(KIND_LABEL.get(r['kind'], r['kind']))}</td>"
                f"<td class='num'>{r['n_books']}</td><td class='num'>{r['n_mentions']}</td><td class='muted small'>{e(r['cited_by'])}</td></tr>"
            )
        table = (f"<table><thead><tr><th>Work</th><th>Creator</th><th>Kind</th><th class='num'>Books citing</th><th class='num'>Mentions</th><th>Cited by</th></tr></thead>"
                 f"<tbody>{''.join(rows)}</tbody></table>") if rows else "<p class='muted'>Upload a few books first.</p>"
        body = (f"<h1>What to read next</h1><p class='sub'>Works cited across your {n_books} books that you have not uploaded, "
                "ranked by how many different books cite them, then by how seriously (quoted or discussed beats named).</p>"
                f"<section class='card'>{table}</section>")
        return page("Reading list", body)

    @app.get("/api/reading")
    def api_reading():
        return JSONResponse([dict(r) for r in dbm.recommendations(con(), 500)])

    @app.get("/api/books")
    def api_books():
        return JSONResponse([dict(r) for r in dbm.books(con())])

    @app.get("/api/book/{book_id}")
    def api_book(book_id: int):
        c = con()
        return JSONResponse([{**dict(w), "url": link_for(w["title"], w["creator"], w["kind"])} for w in dbm.book_works(c, book_id)])

    return app


app = make_app(os.environ.get("INFLUENCE_DB", "library.db"))
