"""CLI.

  python -m influence_map estimate BOOK.epub [--threshold 3] [--model claude-haiku-4-5] [--batch]
  python -m influence_map ingest BOOK.epub [BOOK2.epub ...] [--db library.db] [--batch] [--model ...]
  python -m influence_map paragraphs BOOK.epub     # dump what would be sent, to sanity-check the filter
  python -m influence_map serve [--db library.db] [--port 8000]
"""
from __future__ import annotations

import argparse
import sys

from . import db as dbm
from .llm import CANON_MODEL, EXTRACT_MODEL
from .pipeline import ingest, plan


def main(argv=None):
    ap = argparse.ArgumentParser(prog="influence_map")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p):
        p.add_argument("--threshold", type=int, default=3, help="prefilter score needed to send a paragraph (0 = send all)")
        p.add_argument("--model", default=EXTRACT_MODEL)
        p.add_argument("--canon-model", default=CANON_MODEL)
        p.add_argument("--batch", action="store_true", help="use the Batch API (half price, up to an hour)")

    e = sub.add_parser("estimate"); e.add_argument("files", nargs="+"); common(e)
    i = sub.add_parser("ingest"); i.add_argument("files", nargs="+"); i.add_argument("--db", default="library.db"); common(i)
    d = sub.add_parser("paragraphs"); d.add_argument("file"); common(d)
    s = sub.add_parser("serve"); s.add_argument("--db", default="library.db"); s.add_argument("--port", type=int, default=8000); s.add_argument("--host", default="127.0.0.1")
    a = ap.parse_args(argv)

    if a.cmd == "estimate":
        total = 0
        for f in a.files:
            p = plan(f, a.threshold, a.model, a.batch)
            est = p.estimate
            print(f"{p.book.title} — {p.book.author}: {p.book.word_count:,} words; {p.sent}/{len(p.book.paragraphs)} paragraphs "
                  f"-> {est['chunks']} chunks, ~{est['input_tokens']:,} in / ~{est['output_tokens']:,} out, ≈ ${est['usd']:.3f}")
            total += est["usd"]
        if len(a.files) > 1:
            print(f"total ≈ ${total:.2f}")
    elif a.cmd == "paragraphs":
        p = plan(a.file, a.threshold, a.model, a.batch)
        for c in p.chunks:
            print(c.text); print("\n" + "=" * 80 + "\n")
    elif a.cmd == "ingest":
        con = dbm.connect(a.db)
        for f in a.files:
            def prog(done, total):
                print(f"\r  {done}/{total} chunks", end="", file=sys.stderr, flush=True)
            ingest(con, f, a.threshold, a.model, a.canon_model, a.batch, progress=prog)
            print(file=sys.stderr)
    elif a.cmd == "serve":
        import uvicorn

        from .app import make_app

        uvicorn.run(make_app(a.db), host=a.host, port=a.port)


if __name__ == "__main__":
    main()
