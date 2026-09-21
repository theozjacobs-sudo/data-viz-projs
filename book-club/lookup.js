// Book lookup via Open Library (free, no key, CORS-friendly).
// Returns normalized results: {title, author, year, pages, coverId, coverUrl, olKey, subjects}

const FIELDS = "key,title,author_name,first_publish_year,cover_i,number_of_pages_median,subject,edition_count";

export async function searchBooks(query, { signal } = {}) {
  const q = query.trim();
  if (q.length < 2) return [];
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=8&fields=${FIELDS}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Open Library ${res.status}`);
  const json = await res.json();
  const docs = (json.docs || []).filter((d) => d.title);
  // Prefer well-known editions: Open Library already sorts by relevance, but
  // nudge results with covers and many editions to the top.
  docs.sort((a, b) => score(b) - score(a));
  return docs.slice(0, 6).map(normalize);
}

function score(d) {
  return (d.cover_i ? 2 : 0) + Math.min(3, Math.log10((d.edition_count || 1) + 1));
}

function normalize(d) {
  const coverId = d.cover_i || null;
  const subjects = (d.subject || [])
    .filter((s) => /^[A-Za-z ,'\-]+$/.test(s) && s.length < 32)
    .slice(0, 3);
  return {
    title: d.title,
    author: (d.author_name || []).filter((v, i, a) => a.indexOf(v) === i).slice(0, 2).join(", ") || "Unknown author",
    year: d.first_publish_year || null,
    pages: d.number_of_pages_median || null,
    coverId,
    coverUrl: coverId ? `https://covers.openlibrary.org/b/id/${coverId}-M.jpg` : "",
    olKey: d.key || "",
    subjects,
  };
}

export function manualBook(title, author) {
  return {
    title: title.trim(),
    author: author.trim() || "Unknown author",
    year: null, pages: null, coverId: null, coverUrl: "", olKey: "", subjects: [],
  };
}
