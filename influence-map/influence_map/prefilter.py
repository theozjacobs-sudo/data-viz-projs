"""Cheap heuristic pass: decide which paragraphs are worth sending to the model.

The point is cost. Most paragraphs in a novel mention nothing. A paragraph goes to the model only if
it carries a plausible signal: italic/emphasis markup, a quoted multi-word capitalized phrase, a
"Title of Work"-shaped run of capitalized words, or vocabulary that usually surrounds a citation
("novel", "wrote", "painting", "film", "directed", "symphony", ...). Paragraphs that pass are then
packed into ~2,500-token chunks so each request amortises the system prompt.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from .epub_text import Paragraph

WORK_WORDS = re.compile(
    r"\b(novel|novels|book|books|memoir|essay|essays|poem|poems|poetry|play|plays|treatise|manifesto|"
    r"story|stories|tale|tales|sonnet|epic|saga|trilogy|sequel|volume|edition|chapter|anthology|"
    r"film|films|movie|movies|documentary|cinema|screen|directed|director|screenplay|"
    r"painting|paintings|painted|canvas|portrait|fresco|mural|sculpture|statue|triptych|"
    r"symphony|sonata|opera|concerto|album|song|ballet|quartet|"
    r"wrote|written|writes|writing|author|authored|published|reading|read|reread|"
    r"translation|translated|composed|composer|photograph|exhibition|gallery|museum)\b",
    re.I,
)
# “Two Capitalized Words” or 'Two Capitalized Words' inside quotes, or 3+ capitalized words in a row
QUOTED_TITLE = re.compile(r"[\"“‘']([A-Z][\w'’-]+(?:\s+(?:[a-z]{1,3}\s+)?[A-Z][\w'’-]+){1,8})[\"”’']")
CAP_RUN = re.compile(r"\b(?:[A-Z][\w'’-]+\s+(?:(?:of|the|and|a|an|in|on|to|for|de|du|la|le|des|del|von|der)\s+)?){2,}[A-Z][\w'’-]+\b")
PROPER_NOUN = re.compile(r"\b[A-Z][a-z]{2,}\b")


@dataclass
class Chunk:
    idx: int
    paragraph_idxs: list[int]
    text: str


def score(p: Paragraph) -> int:
    s = 0
    if p.has_emphasis:
        s += 3
    if QUOTED_TITLE.search(p.text):
        s += 3
    if CAP_RUN.search(p.text):
        s += 1
    if WORK_WORDS.search(p.text):
        s += 2
    # A block with several proper nouns is more likely to name a person or work.
    if len(PROPER_NOUN.findall(p.text)) >= 3:
        s += 1
    return s


def select(paragraphs: list[Paragraph], threshold: int = 3) -> list[Paragraph]:
    """Keep paragraphs whose signal score reaches the threshold. 0 sends everything."""
    if threshold <= 0:
        return list(paragraphs)
    return [p for p in paragraphs if score(p) >= threshold]


def approx_tokens(text: str) -> int:
    return max(1, len(text) // 4)


def pack(paragraphs: list[Paragraph], target_tokens: int = 2500) -> list[Chunk]:
    chunks: list[Chunk] = []
    cur: list[Paragraph] = []
    cur_tokens = 0
    for p in paragraphs:
        t = approx_tokens(p.text)
        if cur and cur_tokens + t > target_tokens:
            chunks.append(_mk(len(chunks), cur))
            cur, cur_tokens = [], 0
        cur.append(p)
        cur_tokens += t
    if cur:
        chunks.append(_mk(len(chunks), cur))
    return chunks


def _mk(i: int, paras: list[Paragraph]) -> Chunk:
    # Each paragraph is tagged with its index so the model can cite where a mention lives.
    text = "\n\n".join(f"[¶{p.idx}] {p.text}" for p in paras)
    return Chunk(idx=i, paragraph_idxs=[p.idx for p in paras], text=text)
