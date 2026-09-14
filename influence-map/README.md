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
2. **Cheap model for the bulk pass, strong model for judgement.** Body paragraphs go to Claude
   Haiku 4.5 in ~2,500-token chunks with a structured-output schema. The resulting raw list (a few
   hundred short lines at most) goes once to Claude Opus 5 at low effort to merge duplicates,
   fill in creators and years, and throw out the book citing itself.
3. **Batch API option** halves the model bill if you can wait up to an hour.
4. **Optional prefilter** (`--threshold 3`, or the box on the upload form). Skips paragraphs with
   no title signal. Off by default; see the accuracy section for why.

Measured on real EPUBs with the defaults (every body paragraph, Haiku):

| Book | Words | Estimated cost | Batch |
|---|---|---|---|
| Woolf, *The Common Reader* | 73k | $0.23 | $0.12 |
| Chesterton, *Heretics* | 65k | $0.21 | $0.11 |
| Austen, *Pride and Prejudice* | 127k | $0.36 | $0.21 |

Fifty books lands around $10 to $18, or half that on batch. Switching the bulk pass to Opus 5
(`--model claude-opus-5` or the dropdown on the upload form) is roughly 4x that and worth trying
on a book where Haiku misses allusions. The estimate includes a fixed ~$0.05 for the Opus merge pass.

## How accurate is the prefilter, and should you use it

The prefilter scores each paragraph on cheap signals: italics or `<cite>`, a quoted Title-Case
phrase, a set-off quotation or verse block, SMALL CAPS titles (old transcriptions), work vocabulary
("novel", "film", "painting", "wrote"), several proper nouns, and hits against a gazetteer of
notable creators and titles pulled from Wikidata (`data/gazetteer.json.gz`: about 10,000 surnames,
13,500 full names and 6,700 titles). The title list is weak on novels, poems, plays and musical works:
Wikidata's query service was degraded when this was built and returned empty results for those
classes. To fill them in later, retry just those classes and merge:

```bash
python scripts/build_gazetteer.py --merge data/gazetteer.json.gz \
    --only Q8261,Q5185279,Q25379,Q207628,Q1344 --out data/gazetteer.json.gz
```

The script sleeps a minute between queries because Wikidata throttles anonymous clients. Common-word surnames such as Wells, Swift, Gray or Pope only count
when introduced by an honorific or initials ("Mr. Wells", "H. G. Wells").

To test it, every paragraph the first version dropped on two Gutenberg books was graded by hand
(well, by a model reading each one) for whether it mentioned a work. The first version was bad:
it had dropped 69 paragraphs with a work in Woolf and 44 in Chesterton, mostly block-quoted verse,
unnamed allusions, and paragraphs that only name an author. After the fixes above:

| Threshold | Woolf: sent / cost / work-paragraphs still missed | Chesterton: sent / cost / missed |
|---|---|---|
| 0 (default) | 100% / $0.23 / 0 | 100% / $0.21 / 0 |
| 3 | 84% / $0.22 / 5 of 69 | 72% / $0.18 / 8 of 44 |
| 4 | 66% / $0.20 / 34 of 69 | 59% / $0.16 / 13 of 44 |

The dropped paragraphs are the short ones, so the filter saves little money on Haiku and costs
real recall. That is why the default is now to send everything. The remaining misses at threshold
3 are almost all unattributed scripture and quotations with no name attached (Chesterton quoting
the Beatitudes without saying so), which no dictionary catches. Use the prefilter when you run
the bulk pass on Opus 5, where 20 to 40 percent of tokens is real money.

`python -m influence_map audit book.epub` measures this on any book you own: it sends a sample of
dropped paragraphs through the model and reports how many contained a mention, for a few cents.

## What the model returns

Per mention: standard title, creator, kind (book / film / artwork / music / play / poem / other),
year, the paragraph index, a short verbatim quote, and whether the work was merely *named*,
*quoted*, *discussed*, or *alluded* to. Creators named without a specific work ("Mr. Shaw's
philosophy") come back separately as *people*; they show on the book page and feed the author
graph but are never recommended as reading. The reading list ranks by number of distinct citing books,
then by quoted/discussed mentions, then raw mentions. The graph draws an edge from each uploaded
author to every creator they cite (self-citations dropped), weighted by mention count.

Links are catalogue searches that need no API key: Open Library for books, plays and poems,
Letterboxd for film, Google Arts & Culture for artworks, MusicBrainz for music.

## Layout

```
influence_map/epub_text.py   EPUB -> paragraphs, note stripping
influence_map/prefilter.py   paragraph scoring and chunk packing
influence_map/gazetteer.py   Wikidata names/titles lookup used by the prefilter
scripts/build_gazetteer.py   rebuilds data/gazetteer.json.gz (needs network, slow)
influence_map/llm.py         Claude calls (sync + Batch API), pricing, FAKE_LLM stand-in
influence_map/schema.py      Pydantic output schemas
influence_map/db.py          SQLite, work merging, graph and recommendation queries
influence_map/pipeline.py    ingest one file end to end
influence_map/app.py         FastAPI pages and JSON API
influence_map/cli.py         estimate / ingest / paragraphs / audit / serve
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
