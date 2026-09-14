"""Model calls. Two passes:

1. extract  - bulk pass over prefiltered chunks. Default model is Claude Haiku 4.5 because this is
              where nearly all the tokens go and the task (spot titles in a paragraph) is easy.
2. canonicalize - one small call per book on Claude Opus 5 that merges raw mentions into
              deduplicated works with a creator and year. This is where judgement matters and
              it costs a few thousand tokens.

Set EXTRACT_MODEL / CANON_MODEL to override. FAKE_LLM=1 swaps in a regex extractor for tests.
"""
from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass, field

from .prefilter import QUOTED_TITLE, Chunk
from .schema import CanonResult, CanonicalWork, ChunkResult, Mention

EXTRACT_MODEL = os.environ.get("EXTRACT_MODEL", "claude-haiku-4-5")
CANON_MODEL = os.environ.get("CANON_MODEL", "claude-opus-5")

# USD per million tokens (input, output). Batch API halves both.
PRICES = {
    "claude-haiku-4-5": (1.00, 5.00),
    "claude-sonnet-5": (2.00, 10.00),
    "claude-opus-5": (5.00, 25.00),
    "claude-fable-5-1": (10.00, 50.00),
}

EXTRACT_SYSTEM = """You read passages from a book and list every other creative work the passage mentions in its running text.

Include: books, essays, poems, plays, films, TV series, paintings, sculptures, photographs, musical works, albums, operas. Include works that are quoted, discussed, named in passing, or clearly alluded to without a title (e.g. "the Danish prince's soliloquy" -> Hamlet). Include sacred and classical texts (the Iliad, Genesis) when they are referenced as works.

Exclude: the book you are reading itself; periodicals, newspapers, and journals; publishers; characters; places; bare author names with no work attached; generic references ("a novel", "his poems"); mentions that are clearly in a footnote, citation, or bibliography entry.

For each mention give the standard title, the creator if stated or widely known, the kind, the ¶ index the mention sits in, and a short verbatim quote. Titles in the text may be italicised, quoted, or plain; normalise obvious variants (drop leading "the" only if that is the standard title). Do not invent works. If a paragraph mentions nothing, return no entries for it. Return an empty list if the passage mentions nothing."""

CANON_SYSTEM = """You are given the book's own title and author, plus a list of raw work mentions extracted paragraph by paragraph from that book. Merge duplicates into canonical works.

Rules: treat spelling variants, partial titles, translated titles, and "the X" / "X" as the same work when they clearly are. Fill in creator and year of first publication or release when widely known; leave null when genuinely uncertain. Never include the book itself. Keep every raw title string in raw_titles so mentions can be traced back. Prefer the creator's common name (George Eliot, not Mary Ann Evans)."""


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read: int = 0
    cache_write: int = 0
    calls: int = 0
    by_model: dict = field(default_factory=dict)

    def add(self, model: str, u) -> None:
        self.calls += 1
        self.input_tokens += u.input_tokens
        self.output_tokens += u.output_tokens
        self.cache_read += getattr(u, "cache_read_input_tokens", 0) or 0
        self.cache_write += getattr(u, "cache_creation_input_tokens", 0) or 0
        m = self.by_model.setdefault(model, [0, 0, 0, 0])
        m[0] += u.input_tokens
        m[1] += u.output_tokens
        m[2] += getattr(u, "cache_read_input_tokens", 0) or 0
        m[3] += getattr(u, "cache_creation_input_tokens", 0) or 0

    def cost(self, batch: bool = False) -> float:
        total = 0.0
        for model, (inp, out, cr, cw) in self.by_model.items():
            pi, po = PRICES.get(model, (5.0, 25.0))
            total += (inp * pi + out * po + cr * pi * 0.1 + cw * pi * 1.25) / 1e6
        return total * (0.5 if batch else 1.0)


def estimate_cost(chunks: list[Chunk], model: str = EXTRACT_MODEL, batch: bool = False) -> dict:
    """Rough pre-flight estimate. Output is assumed ~8% of input (titles are short)."""
    pi, po = PRICES.get(model, (5.0, 25.0))
    sys_tokens = len(EXTRACT_SYSTEM) // 4 + 200
    inp = sum(len(c.text) // 4 for c in chunks) + sys_tokens * len(chunks)
    out = int(inp * 0.08)
    canon = (2500 * PRICES[CANON_MODEL][0] + 1500 * PRICES[CANON_MODEL][1]) / 1e6
    cost = (inp * pi + out * po) / 1e6 * (0.5 if batch else 1.0) + canon
    return {"model": model, "chunks": len(chunks), "input_tokens": inp, "output_tokens": out, "usd": round(cost, 3)}


# --------------------------------------------------------------------------------------------
# Real client
# --------------------------------------------------------------------------------------------

def _client():
    import anthropic

    return anthropic.Anthropic()


def _extract_params(chunk: Chunk, model: str) -> dict:
    params = dict(
        model=model,
        max_tokens=4096,
        system=[{"type": "text", "text": EXTRACT_SYSTEM, "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": f"Passages:\n\n{chunk.text}"}],
    )
    if not model.startswith("claude-haiku"):
        # Current-generation models default to adaptive thinking; keep it cheap for this easy task.
        params["output_config"] = {"effort": "low"}
    return params


def _output_format_schema() -> dict:
    try:
        from anthropic.lib._parse._transform import transform_schema

        return transform_schema(ChunkResult)
    except Exception:  # pragma: no cover - private import
        return ChunkResult.model_json_schema()


class ClaudeExtractor:
    def __init__(self, model: str = EXTRACT_MODEL, canon_model: str = CANON_MODEL, batch: bool = False):
        self.client = _client()
        self.model = model
        self.canon_model = canon_model
        self.batch = batch
        self.usage = Usage()

    # ---- pass 1 ----------------------------------------------------------------------------
    def extract(self, chunks: list[Chunk], progress=None) -> list[Mention]:
        if self.batch and len(chunks) > 1:
            return self._extract_batch(chunks, progress)
        out: list[Mention] = []
        for i, chunk in enumerate(chunks):
            params = _extract_params(chunk, self.model)
            resp = self.client.messages.parse(output_format=ChunkResult, **params)
            self.usage.add(self.model, resp.usage)
            if resp.parsed_output:
                out.extend(resp.parsed_output.mentions)
            if progress:
                progress(i + 1, len(chunks))
        return out

    def _extract_batch(self, chunks: list[Chunk], progress=None) -> list[Mention]:
        from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
        from anthropic.types.messages.batch_create_params import Request

        fmt = {"type": "json_schema", "schema": _output_format_schema()}
        reqs = []
        for c in chunks:
            p = _extract_params(c, self.model)
            p.setdefault("output_config", {})["format"] = fmt
            reqs.append(Request(custom_id=f"chunk-{c.idx}", params=MessageCreateParamsNonStreaming(**p)))
        batch = self.client.messages.batches.create(requests=reqs)
        while True:
            b = self.client.messages.batches.retrieve(batch.id)
            if b.processing_status == "ended":
                break
            if progress:
                progress(b.request_counts.succeeded + b.request_counts.errored, len(chunks))
            time.sleep(30)
        out: list[Mention] = []
        for r in self.client.messages.batches.results(batch.id):
            if r.result.type != "succeeded":
                continue
            msg = r.result.message
            self.usage.add(self.model, msg.usage)
            text = next((blk.text for blk in msg.content if blk.type == "text"), "")
            try:
                out.extend(ChunkResult.model_validate_json(text).mentions)
            except Exception:
                pass
        return out

    # ---- pass 2 ----------------------------------------------------------------------------
    def canonicalize(self, book_title: str, book_author: str, mentions: list[Mention]) -> list[CanonicalWork]:
        if not mentions:
            return []
        # Send unique (title, creator, kind) triples, not every mention, to keep this small.
        seen: dict[tuple, int] = {}
        for m in mentions:
            key = (m.title.strip(), (m.creator or "").strip(), m.kind)
            seen[key] = seen.get(key, 0) + 1
        rows = [f"- {t}" + (f" — {c}" if c else "") + f" [{k}] ×{n}" for (t, c, k), n in sorted(seen.items(), key=lambda kv: -kv[1])]
        user = f"Book: {book_title} by {book_author}\n\nRaw mentions:\n" + "\n".join(rows)
        resp = self.client.messages.parse(
            model=self.canon_model,
            max_tokens=16000,
            system=CANON_SYSTEM,
            messages=[{"role": "user", "content": user}],
            output_config={"effort": "low"},
            output_format=CanonResult,
        )
        self.usage.add(self.canon_model, resp.usage)
        return resp.parsed_output.works if resp.parsed_output else []


# --------------------------------------------------------------------------------------------
# Offline stand-in, for tests and for a quick look at the pipeline without spending anything.
# --------------------------------------------------------------------------------------------

class FakeExtractor:
    """Pulls quoted or italic-looking titles with a regex. Recall is poor; the plumbing is real."""

    model = "fake"
    canon_model = "fake"
    batch = False

    def __init__(self, *a, **k):
        self.usage = Usage()

    def extract(self, chunks: list[Chunk], progress=None) -> list[Mention]:
        out = []
        for c in chunks:
            for para in c.text.split("\n\n"):
                m = re.match(r"\[¶(\d+)\] (.*)", para, re.S)
                if not m:
                    continue
                idx, text = int(m.group(1)), m.group(2)
                for q in QUOTED_TITLE.finditer(text):
                    title = q.group(1)
                    if len(title.split()) > 8:
                        continue
                    start = max(0, q.start() - 40)
                    out.append(Mention(title=title, creator=None, kind="book", year=None, paragraph=idx,
                                       quote=text[start:q.end() + 20].strip(), how="named"))
        return out

    def canonicalize(self, book_title, book_author, mentions):
        groups: dict[str, list[str]] = {}
        for m in mentions:
            key = re.sub(r"^(the|a|an)\s+", "", m.title.lower()).strip()
            groups.setdefault(key, []).append(m.title)
        return [CanonicalWork(title=max(v, key=len), creator=None, kind="book", year=None, raw_titles=sorted(set(v)))
                for v in groups.values() if not re.sub(r"^(the|a|an)\s+", "", v[0].lower()) == re.sub(r"^(the|a|an)\s+", "", book_title.lower())]


def get_extractor(model: str = EXTRACT_MODEL, canon_model: str = CANON_MODEL, batch: bool = False):
    if os.environ.get("FAKE_LLM"):
        return FakeExtractor()
    return ClaudeExtractor(model=model, canon_model=canon_model, batch=batch)
