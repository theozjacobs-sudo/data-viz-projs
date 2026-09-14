"""Turn an EPUB into body-text paragraphs, dropping footnotes, endnotes, and front/back matter.

Only running prose reaches the model. Notes sections, bibliographies, indexes, and inline note
markers are stripped so that a title cited only in an endnote is never counted as a mention.
"""
from __future__ import annotations

import re
import warnings
from dataclasses import dataclass

import ebooklib
from bs4 import BeautifulSoup, Tag, XMLParsedAsHTMLWarning
from ebooklib import epub

warnings.filterwarnings("ignore", module="ebooklib")
warnings.filterwarnings("ignore", category=XMLParsedAsHTMLWarning)

# Section-level markup that is never body text.
NOTE_EPUB_TYPES = {
    "footnote", "footnotes", "endnote", "endnotes", "rearnote", "rearnotes", "noteref",
    "bibliography", "index", "toc", "landmarks", "page-list", "copyright-page",
    "acknowledgments", "colophon", "glossary", "titlepage", "halftitlepage", "cover",
}
NOTE_CLASS_RE = re.compile(
    r"(?:^|[\s_-])(footnote|footnotes|fn|fnanchor|noteref|note-ref|endnote|endnotes|"
    r"bibliography|biblio|index|toc|copyright|colophon|pg-boilerplate|pgheader)(?:$|[\s_-])",
    re.I,
)
NOTE_FILE_RE = re.compile(r"(footnote|endnote|notes?\d*|biblio|index|toc|copyright|cover|title|colophon|ack)", re.I)
NOTE_HEADING_RE = re.compile(
    r"^\s*(notes?|endnotes?|footnotes?|bibliography|works cited|references|selected bibliography|"
    r"further reading|index|acknowledg(e)?ments?|about the author|also by|copyright|contents|"
    r"table of contents|permissions|credits|a note on the (text|type|author))\b",
    re.I,
)
# A block that starts with a note number / marker, e.g. "12. See ...", "[3] ...", "† ..."
NOTE_PARA_RE = re.compile(r"^\s*(\[\d{1,3}\]|\d{1,3}\.|[†‡§*]{1,3})\s")
QUOTE_CLASS_RE = re.compile(r"(poem|poetry|stanza|verse|quot|epigraph|citation|extract|lyric)", re.I)
BLOCK_TAGS = ["p", "li", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "dd", "dt", "td", "pre", "div"]


@dataclass
class Paragraph:
    idx: int
    text: str
    has_emphasis: bool  # contained <i>/<em>/<cite> — the usual typographic signal for a title
    chapter: str
    is_quote: bool = False  # blockquote / verse / epigraph markup, or a short block wrapped in quotation marks


@dataclass
class Book:
    title: str
    author: str
    paragraphs: list[Paragraph]

    @property
    def word_count(self) -> int:
        return sum(len(p.text.split()) for p in self.paragraphs)


def _attr_words(tag: Tag, name: str) -> str:
    v = tag.get(name)
    if isinstance(v, list):
        return " ".join(v)
    return v or ""


def _is_note_container(tag: Tag) -> bool:
    et = _attr_words(tag, "epub:type").lower()
    if any(t in NOTE_EPUB_TYPES for t in et.split()):
        return True
    if tag.get("role") in {"doc-footnote", "doc-endnote", "doc-endnotes", "doc-noteref", "doc-bibliography", "doc-index", "doc-toc"}:
        return True
    cls = _attr_words(tag, "class") + " " + (tag.get("id") or "")
    if NOTE_CLASS_RE.search(cls):
        return True
    if tag.name == "aside":
        return True
    return False


def _strip_notes(soup: BeautifulSoup) -> None:
    for tag in soup.find_all(True):
        if not isinstance(tag, Tag) or tag.decomposed:
            continue
        if _is_note_container(tag):
            tag.decompose()
    # Inline note markers: <sup><a>12</a></sup>, <a href="#fn3">3</a>, [12]
    for sup in soup.find_all("sup"):
        sup.decompose()
    for a in soup.find_all("a", href=True):
        txt = a.get_text(strip=True)
        if re.fullmatch(r"\[?\d{1,3}\]?|[*†‡§]+|[a-z]", txt or ""):
            a.decompose()
    for tag in soup.find_all(["script", "style", "nav", "header", "footer", "figure", "figcaption", "table"]):
        tag.decompose()


def _section_is_notes(soup: BeautifulSoup, name: str) -> bool:
    body = soup.body or soup
    if _is_note_container(body):
        return True
    for h in body.find_all(["h1", "h2", "h3", "title"], limit=3):
        if NOTE_HEADING_RE.match(h.get_text(" ", strip=True)):
            return True
    if NOTE_FILE_RE.search(name.rsplit("/", 1)[-1]):
        text = body.get_text(" ", strip=True)
        # Short files with a note-ish name are front/back matter; long ones are usually chapters.
        if len(text) < 4000:
            return True
    return False


def _blocks(soup: BeautifulSoup):
    body = soup.body or soup
    seen = set()
    for tag in body.find_all(BLOCK_TAGS):
        # Only leaf-ish blocks: skip divs that contain other block tags.
        if tag.name == "div" and tag.find(BLOCK_TAGS):
            continue
        if any(id(p) in seen for p in tag.parents):
            continue
        seen.add(id(tag))
        yield tag


def _is_quote(block: Tag, text: str) -> bool:
    if block.name == "blockquote" or block.find_parent("blockquote") is not None:
        return True
    for t in [block, *block.parents]:
        if isinstance(t, Tag) and t.name != "[document]" and QUOTE_CLASS_RE.search(_attr_words(t, "class")):
            return True
    return _text_is_quote(text)


def _text_is_quote(text: str) -> bool:
    return len(text.split()) <= 80 and text[:1] in "\"“‘'" and text.rstrip(".,;!?")[-1:] in "\"”’'"


def _looks_like_toc(text: str) -> bool:
    """A contents list or index rendered as one block: mostly Title Case, no sentence punctuation."""
    words = text.split()
    if len(words) < 25:
        return False
    caps = sum(1 for w in words if w[:1].isupper())
    stops = sum(text.count(ch) for ch in ".;?!")
    return caps / len(words) > 0.6 and stops < len(words) / 8


def _chapter_title(soup: BeautifulSoup) -> str:
    h = (soup.body or soup).find(["h1", "h2", "h3"])
    return h.get_text(" ", strip=True)[:120] if h else ""


def load_epub(path: str) -> Book:
    book = epub.read_epub(path, options={"ignore_ncx": True})
    title = next((t[0] for t in book.get_metadata("DC", "title")), "") or path.rsplit("/", 1)[-1]
    creators = [c[0] for c in book.get_metadata("DC", "creator")]
    author = "; ".join(creators) if creators else "Unknown"

    # Spine order matters more than item order.
    by_id = {item.get_id(): item for item in book.get_items()}
    ordered = [by_id[i[0]] for i in book.spine if i[0] in by_id]
    docs = [it for it in ordered if it.get_type() == ebooklib.ITEM_DOCUMENT]
    if not docs:
        docs = list(book.get_items_of_type(ebooklib.ITEM_DOCUMENT))

    paragraphs: list[Paragraph] = []
    idx = 0
    for doc in docs:
        soup = BeautifulSoup(doc.get_content(), "lxml")
        if _section_is_notes(soup, doc.get_name()):
            continue
        _strip_notes(soup)
        chapter = _chapter_title(soup)
        for block in _blocks(soup):
            text = re.sub(r"\s+", " ", block.get_text(" ")).strip()
            if len(text) < 20 or NOTE_PARA_RE.match(text) or _looks_like_toc(text):
                continue
            if block.name in {"h1", "h2", "h3", "h4", "h5", "h6"} and NOTE_HEADING_RE.match(text):
                continue
            has_emph = block.find(["i", "em", "cite"]) is not None
            paragraphs.append(Paragraph(idx=idx, text=text, has_emphasis=has_emph, chapter=chapter, is_quote=_is_quote(block, text)))
            idx += 1
    return Book(title=title, author=author, paragraphs=paragraphs)


def load_txt(path: str, title: str = "", author: str = "") -> Book:
    """Plain-text fallback. Paragraphs are blank-line separated; no note stripping beyond markers."""
    raw = open(path, encoding="utf-8", errors="replace").read()
    paras = []
    for i, chunk in enumerate(re.split(r"\n\s*\n", raw)):
        text = re.sub(r"\s+", " ", chunk).strip()
        if len(text) >= 20 and not NOTE_PARA_RE.match(text):
            paras.append(Paragraph(idx=len(paras), text=text, has_emphasis=False, chapter="", is_quote=_text_is_quote(text)))
    return Book(title=title or path.rsplit("/", 1)[-1], author=author or "Unknown", paragraphs=paras)
