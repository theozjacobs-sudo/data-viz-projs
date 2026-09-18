"""Offline tests: EPUB note-stripping, prefilter, DB merging, and the web app with the fake extractor."""
import os
import sys

os.environ["FAKE_LLM"] = "1"
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest
from ebooklib import epub

from influence_map import db as dbm
from influence_map.epub_text import load_epub
from influence_map.pipeline import ingest, plan
from influence_map.prefilter import pack, select


def make_epub(path, title="Test Book", author="Ann Author"):
    b = epub.EpubBook()
    b.set_identifier("id1")
    b.set_title(title)
    b.set_language("en")
    b.add_author(author)
    ch = epub.EpubHtml(title="Chapter 1", file_name="ch1.xhtml", lang="en")
    ch.content = """<html><body>
      <h1>Chapter One</h1>
      <p>She had been reading <i>Middlemarch</i> all winter, and "The Waste Land" in spring.<sup><a href="#fn1">1</a></sup></p>
      <p>Nothing happens in this paragraph at all, just weather and a long walk home.</p>
      <p>He preferred the film <em>Vertigo</em> to any novel he had read that year.</p>
      <aside epub:type="footnote" id="fn1"><p>1. See <i>Secret Footnote Book</i>, p. 12.</p></aside>
      <div class="footnote"><p>2. Another note citing <i>Hidden Note Novel</i>.</p></div>
    </body></html>"""
    notes = epub.EpubHtml(title="Notes", file_name="notes.xhtml", lang="en")
    notes.content = """<html><body><h2>Notes</h2><p>3. On "Endnote Only Title" see the bibliography.</p></body></html>"""
    b.add_item(ch)
    b.add_item(notes)
    b.toc = (ch,)
    b.add_item(epub.EpubNcx())
    b.add_item(epub.EpubNav())
    b.spine = ["nav", ch, notes]
    epub.write_epub(path, b)
    return path


@pytest.fixture
def book_path(tmp_path):
    return make_epub(str(tmp_path / "test.epub"))


def test_notes_are_stripped(book_path):
    book = load_epub(book_path)
    text = " ".join(p.text for p in book.paragraphs)
    assert book.title == "Test Book" and book.author == "Ann Author"
    assert "Middlemarch" in text and "Vertigo" in text
    assert "Secret Footnote Book" not in text
    assert "Hidden Note Novel" not in text
    assert "Endnote Only Title" not in text
    assert "1" not in text.split("spring.")[1][:3]  # inline marker removed


def test_prefilter_keeps_signal_paragraphs(book_path):
    book = load_epub(book_path)
    kept = select(book.paragraphs, 3)
    kept_text = " ".join(p.text for p in kept)
    assert "Middlemarch" in kept_text and "Vertigo" in kept_text
    assert "just weather" not in kept_text
    chunks = pack(kept, target_tokens=2500)
    assert len(chunks) == 1 and chunks[0].text.startswith("[¶")


def test_plan_estimate(book_path):
    p = plan(book_path)
    assert p.estimate["usd"] > 0 and p.estimate["chunks"] == 1


def test_ingest_and_queries(tmp_path, book_path):
    con = dbm.connect(str(tmp_path / "t.db"))
    bid = ingest(con, book_path, log=lambda *a: None)
    works = dbm.book_works(con, bid)
    titles = {w["title"] for w in works}
    assert "The Waste Land" in titles  # the fake extractor only sees quoted titles
    # A second book quoting the same title merges into one work and becomes a recommendation.
    second = make_epub(str(tmp_path / "b2.epub"), title="Other Book", author="Bob Writer")
    ingest(con, second, log=lambda *a: None)
    recs = dbm.recommendations(con)
    top = recs[0]
    assert top["title"] == "The Waste Land" and top["n_books"] == 2
    assert dbm.author_graph(con)["nodes"] == []  # fake extractor yields no creators, so no author edges


def test_work_merging_fills_creator(tmp_path):
    con = dbm.connect(str(tmp_path / "m.db"))
    a = dbm.upsert_work(con, "The Waste Land", None, "poem", None)
    b = dbm.upsert_work(con, "Waste Land", "T. S. Eliot", "poem", 1922)
    assert a == b
    row = con.execute("SELECT creator, year FROM works WHERE id=?", (a,)).fetchone()
    assert row["creator"] == "T. S. Eliot" and row["year"] == 1922
    c = dbm.upsert_work(con, "the waste land", "Eliot", "poem", None)
    assert c == a


def test_web_app(tmp_path, book_path):
    from fastapi.testclient import TestClient

    from influence_map.app import make_app

    app = make_app(str(tmp_path / "w.db"), str(tmp_path / "up"))
    client = TestClient(app)
    assert client.get("/").status_code == 200
    with open(book_path, "rb") as f:
        r = client.post("/upload", files={"files": ("test.epub", f, "application/epub+zip")},
                        data={"model": "claude-haiku-4-5", "threshold": "3"}, follow_redirects=False)
    assert r.status_code == 303
    books = client.get("/api/books").json()
    assert len(books) == 1 and books[0]["status"] == "done"
    page = client.get(f"/book/{books[0]['id']}").text
    assert "The Waste Land" in page and "openlibrary.org" in page
    assert client.get("/graph").status_code == 200
    assert client.get("/api/graph").json()["nodes"] == []
    assert "What to read next" in client.get("/reading").text
    r = client.post(f"/book/{books[0]['id']}/delete", follow_redirects=False)
    assert r.status_code == 303 and client.get("/api/books").json() == []


def test_prefilter_new_signals():
    from influence_map.epub_text import Paragraph
    from influence_map.prefilter import score

    verse = Paragraph(idx=1, text="“If England was what England seems”", has_emphasis=False, chapter="", is_quote=True)
    assert score(verse) >= 3
    caps = Paragraph(idx=2, text="We know that the hero of GHOSTS is mad, and we know why he is mad.", has_emphasis=False, chapter="")
    assert score(caps) >= 2
    trailing = Paragraph(idx=3, text="Mr. Shaw’s philosophy was that presented in “The Quintessence of Ibsenism.” It was brief.", has_emphasis=False, chapter="")
    assert score(trailing) >= 3
    plain = Paragraph(idx=4, text="The tower still rises ninety feet into the air, and the arch still stands.", has_emphasis=False, chapter="")
    assert score(plain) < 3


def test_quote_block_detection(tmp_path):
    from influence_map.epub_text import load_epub

    b = epub.EpubBook(); b.set_identifier("q"); b.set_title("Q"); b.set_language("en"); b.add_author("A")
    ch = epub.EpubHtml(title="c", file_name="c.xhtml", lang="en")
    ch.content = """<html><body><p>Some ordinary sentence about nothing much at all here.</p>
      <p class="poem">I tell you naught for your comfort, yea, naught for your desire.</p>
      <blockquote><p>Blessed is he that expecteth nothing, for he shall not be disappointed.</p></blockquote></body></html>"""
    b.add_item(ch); b.spine = [ch]; b.add_item(epub.EpubNcx()); b.add_item(epub.EpubNav())
    epub.write_epub(str(tmp_path / "q.epub"), b)
    paras = load_epub(str(tmp_path / "q.epub")).paragraphs
    flags = {p.text[:10]: p.is_quote for p in paras}
    assert flags["Some ordin"] is False and flags["I tell you"] is True and flags["Blessed is"] is True


def test_person_mentions_flatten():
    from influence_map.llm import _flatten
    from influence_map.schema import ChunkResult

    r = ChunkResult.model_validate({"mentions": [], "people": [{"name": "George Bernard Shaw", "paragraph": 3, "quote": "Mr. Shaw"}]})
    ms = _flatten(r)
    assert ms[0].kind == "person" and ms[0].creator == "George Bernard Shaw" and ms[0].paragraph == 3


def test_export_and_password(tmp_path, book_path):
    from fastapi.testclient import TestClient

    from influence_map.app import make_app
    from influence_map.export import export

    con = dbm.connect(str(tmp_path / "e.db"))
    ingest(con, book_path, log=lambda *a: None)
    files = export(str(tmp_path / "e.db"), str(tmp_path / "site"))
    assert "index.html" in files and "book-1.html" in files
    index = (tmp_path / "site" / "index.html").read_text()
    assert "href='book-1.html'" in index and "enctype='multipart" not in index and "action='/book" not in index
    assert "api/graph.json" in (tmp_path / "site" / "static" / "graph.js").read_text()
    assert (tmp_path / "site" / "api" / "graph.json").exists()

    guarded = TestClient(make_app(str(tmp_path / "e.db"), str(tmp_path / "up"), password="hunter2"))
    assert guarded.get("/").status_code == 401
    assert guarded.get("/", auth=("anyone", "hunter2")).status_code == 200
    assert guarded.get("/", auth=("anyone", "wrong")).status_code == 401
