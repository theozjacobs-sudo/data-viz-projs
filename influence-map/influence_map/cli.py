"""CLI.

  python -m influence_map estimate BOOK.epub [--threshold 0] [--model claude-haiku-4-5] [--batch]
  python -m influence_map ingest BOOK.epub [BOOK2.epub ...] [--db library.db] [--batch] [--model ...]
  python -m influence_map paragraphs BOOK.epub     # dump what would be sent, to sanity-check the filter
  python -m influence_map audit BOOK.epub          # spend a few cents to measure what the filter misses
  python -m influence_map serve [--db library.db] [--port 8000]
  python -m influence_map export [--db library.db] [--out site]   # static read-only site for GitHub Pages
"""
from __future__ import annotations

import argparse
import os
import sys

from . import db as dbm
from .llm import CANON_MODEL, EXTRACT_MODEL
from .pipeline import audit, ingest, plan


def main(argv=None):
    ap = argparse.ArgumentParser(prog="influence_map")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p):
        p.add_argument("--threshold", type=int, default=0, help="prefilter score needed to send a paragraph; 0 (default) sends every body paragraph, 3 is the cost-saving setting")
        p.add_argument("--model", default=EXTRACT_MODEL)
        p.add_argument("--canon-model", default=CANON_MODEL)
        p.add_argument("--batch", action="store_true", help="use the Batch API (half price, up to an hour)")

    e = sub.add_parser("estimate"); e.add_argument("files", nargs="+"); common(e)
    i = sub.add_parser("ingest"); i.add_argument("files", nargs="+"); i.add_argument("--db", default="library.db"); common(i)
    d = sub.add_parser("paragraphs"); d.add_argument("file"); common(d)
    au = sub.add_parser("audit", help="sample dropped paragraphs through the model to measure prefilter recall")
    au.add_argument("file"); au.add_argument("--sample", type=int, default=60); common(au)
    s = sub.add_parser("serve"); s.add_argument("--db", default="library.db"); s.add_argument("--port", type=int, default=8000); s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--password", default=os.environ.get("APP_PASSWORD", ""), help="require this password (HTTP basic auth) on every page")
    x = sub.add_parser("export"); x.add_argument("--db", default="library.db"); x.add_argument("--out", default="site")
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
    elif a.cmd == "audit":
        audit(a.file, a.sample, a.threshold, a.model)
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

        uvicorn.run(make_app(a.db, password=a.password or None), host=a.host, port=a.port)
    elif a.cmd == "export":
        from .export import export

        files = export(a.db, a.out)
        print(f"wrote {len(files)} pages to {a.out}/")


if __name__ == "__main__":
    main()
