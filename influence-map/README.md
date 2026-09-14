# Influence Map

Upload an ebook. The app reads the body text (not the footnotes, endnotes, bibliography or
index), finds every other book, film, painting, play, poem or piece of music the text mentions,
and links each one out. Once a few dozen books are in, it draws who cites whom and ranks the
works you have not read by how many of your books point at them.

## Run it

```bash
cd influence-map
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...
python -m influence_map serve            # http://127.0.0.1:8000
```

Or from the command line:

```bash
python -m influence_map estimate book.epub            # cost before spending anything
python -m influence_map ingest book.epub other.epub   # scan into library.db
python -m influence_map ingest --batch *.epub         # half price, results within the hour
python -m influence_map paragraphs book.epub          # see exactly what the model would receive
```

Pages: `/` library and upload, `/book/{id}` everything a book cites with quotes and outbound
links, `/graph` author-to-author influence graph, `/reading` what to read next. JSON at
`/api/books`, `/api/book/{id}`, `/api/graph`, `/api/reading`.

## How it keeps the cost down

1. **Strip notes first.** `epub:type="footnote"`, `<aside>`, note classes, endnote sections,
   bibliographies, indexes, tables of contents and Gutenberg boilerplate are removed, and inline
   markers like `<sup>12</sup>` are dropped. A title that only appears in a note never reaches the
   model, which is also what you asked for editorially.
2. **Send only paragraphs that could contain a title.** A paragraph is sent when it scores 3+ on
   cheap signals: italics or `<cite>`, a quoted Title-Case phrase, work vocabulary ("novel",
   "film", "painting", "wrote", "symphony"...), several proper nouns. On the three Gutenberg books
   used to test this, it sends 22 to 56 percent of paragraphs. `--threshold 0` sends everything.
3. **Cheap model for the bulk pass, strong model for judgement.** Paragraphs go to Claude Haiku
   4.5 in ~2,500-token chunks with a structured-output schema. The resulting raw list (a few
   hundred short lines at most) goes once to Claude Opus 5 at low effort to merge duplicates,
   fill in creators and years, and throw out the book citing itself.
4. **Batch API option** halves the model bill if you can wait up to an hour.

Measured on real EPUBs with the default settings:

| Book | Words | Paragraphs sent | Estimated cost (Haiku) | Batch |
|---|---|---|---|---|
| Woolf, *The Common Reader* | 73k | 222 / 396 | $0.19 | $0.12 |
| Chesterton, *Heretics* | 65k | 90 / 263 | $0.12 | $0.08 |
| Austen, *Pride and Prejudice* | 127k | 460 / 2124 | $0.16 | $0.10 |

Fifty books lands around $5 to $10. Switching the bulk pass to Opus 5 (`--model claude-opus-5`
or the dropdown on the upload form) is roughly 4x that and worth trying on a book where Haiku
misses allusions. The estimate includes a fixed ~$0.05 for the Opus merge pass.

## What the model returns

Per mention: standard title, creator, kind (book / film / artwork / music / play / poem / other),
year, the paragraph index, a short verbatim quote, and whether the work was merely *named*,
*quoted*, *discussed*, or *alluded* to. The reading list ranks by number of distinct citing books,
then by quoted/discussed mentions, then raw mentions. The graph draws an edge from each uploaded
author to every creator they cite (self-citations dropped), weighted by mention count.

Links are catalogue searches that need no API key: Open Library for books, plays and poems,
Letterboxd for film, Google Arts & Culture for artworks, MusicBrainz for music.

## Layout

```
influence_map/epub_text.py   EPUB -> paragraphs, note stripping
influence_map/prefilter.py   paragraph scoring and chunk packing
influence_map/llm.py         Claude calls (sync + Batch API), pricing, FAKE_LLM stand-in
influence_map/schema.py      Pydantic output schemas
influence_map/db.py          SQLite, work merging, graph and recommendation queries
influence_map/pipeline.py    ingest one file end to end
influence_map/app.py         FastAPI pages and JSON API
influence_map/cli.py         estimate / ingest / paragraphs / serve
static/                      stylesheet, D3 graph
tests/                       offline tests (FAKE_LLM=1)
```

`python -m pytest tests` runs without a key. Plain `.txt` files are accepted too, with weaker
note stripping.

## Known limits

- Note detection depends on the EPUB's markup. Publisher files with `epub:type` or `footnote`
  classes are handled; a badly converted file that inlines notes as ordinary paragraphs will leak
  them. Run `paragraphs` on a new file if the mention count looks odd.
- Work merging across books keys on normalised title plus creator surname. Two different works
  with the same title and no creator will merge.
- The graph only has an edge when the model supplied a creator. Untitled allusions with no known
  creator show on the book page but not in the graph.
