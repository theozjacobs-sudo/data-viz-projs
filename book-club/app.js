import { createStore, DEFAULT_SETTINGS } from "./store.js";
import { searchBooks, manualBook } from "./lookup.js";

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const state = {
  store: null,
  settings: null,      // {name, members:[{id,name}], booksPerMember}
  rounds: [],          // sorted newest first
  books: [],
  votes: [],
  meId: null,
  view: "now",
  editingRound: null,  // round id when creating/editing
};

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v === false || v == null) continue;
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
};

const EXCITE = [null, "Pass", "Meh", "Meh", "Sure", "Sure", "Keen", "Keen", "Excited", "Excited", "Can't wait"];
const wordFor = (n) => EXCITE[Math.round(n)] || "";

/* ------------------------------------------------------------------ */
/* Derived data                                                        */
/* ------------------------------------------------------------------ */

const memberName = (id) => state.settings?.members.find((m) => m.id === id)?.name || "Someone";
const roundBooks = (roundId) => state.books.filter((b) => b.roundId === roundId);
const roundVotes = (roundId) => state.votes.filter((v) => v.roundId === roundId);
const currentRound = () => state.rounds.find((r) => r.status !== "decided") || state.rounds[0] || null;
/** Rounds hide who submitted what until results are revealed, unless the round opted out. */
const isAnonymous = (round) => round.anonymous !== false && round.status !== "decided";
const submitterLine = (book, round) => {
  if (book.submittedBy === state.meId) return el("div", { class: "by" }, "Submitted by ", el("b", {}, "you"));
  if (isAnonymous(round)) return el("div", { class: "by" }, "Submitted anonymously");
  return el("div", { class: "by" }, "Submitted by ", el("b", {}, memberName(book.submittedBy)));
};

/** Per-book tally. Submitter's own score is excluded from the mean and kept as a tiebreaker. */
function tally(book, round, votes) {
  const scores = [];
  for (const v of votes) {
    if (v.voterId === book.submittedBy) continue;
    const s = v.scores?.[book.id];
    if (typeof s === "number") scores.push(s);
  }
  const n = scores.length;
  const mean = n ? scores.reduce((a, b) => a + b, 0) / n : null;
  const sd = n > 1 ? Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / n) : 0;
  const yes = round.mode === "yesno" ? scores.filter((s) => s === 1).length : null;
  return { scores, n, mean, sd, yes, own: typeof book.ownScore === "number" ? book.ownScore : null };
}

function rankBooks(round) {
  const votes = roundVotes(round.id);
  const rows = roundBooks(round.id).map((b) => ({ book: b, t: tally(b, round, votes) }));
  rows.sort((a, b) => {
    const am = a.t.mean ?? -1, bm = b.t.mean ?? -1;
    if (bm !== am) return bm - am;
    const ao = a.t.own ?? -1, bo = b.t.own ?? -1;
    if (bo !== ao) return bo - ao;
    if (b.t.n !== a.t.n) return b.t.n - a.t.n;
    return (a.book.submittedAt || 0) - (b.book.submittedAt || 0);
  });
  return rows;
}

/** 0–100 "excitement" so different vote modes can share all-time stats. */
const normalize = (score, mode) => (mode === "yesno" ? score * 100 : ((score - 1) / 9) * 100);

const fmtScore = (mean, mode) => {
  if (mean == null) return "—";
  return mode === "yesno" ? `${Math.round(mean * 100)}%` : mean.toFixed(1);
};
const fmtUnit = (mode) => (mode === "yesno" ? "said yes" : "out of 10");
const meterPct = (mean, mode) => (mean == null ? 0 : mode === "yesno" ? mean * 100 : ((mean - 1) / 9) * 100);

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
  state.store = await createStore();
  const store = state.store;

  if (store.kind === "local") {
    const b = $("#banner");
    b.hidden = false;
    b.replaceChildren(
      store.fallbackError ? "Couldn't reach the shared database, so this is a local copy. " : "Demo mode: data stays on this device. ",
      el("a", { href: "https://github.com/theozjacobs-sudo/data-viz-projs/blob/claude/charming-bohr-2ubr3q/book-club/README.md", target: "_blank", rel: "noopener" }, "Set up sharing"),
      " · ",
      el("button", { type: "button", onclick: () => { store.reset(); toast("Demo reset"); } }, "Reset demo")
    );
  }

  try { state.meId = localStorage.getItem("bookclub.me") || null; } catch { /* ignore */ }

  store.onSettings((s, err) => {
    if (err) return footer("Can't read the club settings. Check the Firestore rules.");
    state.settings = s || { ...DEFAULT_SETTINGS };
    if (!s && store.kind === "firestore") store.saveSettings({ ...DEFAULT_SETTINGS }).catch(() => {});
    render();
  });
  store.onRounds((rows, err) => {
    if (err) return footer("Can't read rounds. Check the Firestore rules.");
    state.rounds = [...rows].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    render();
  });
  store.onBooks((rows, err) => { if (!err) { state.books = rows; render(); } });
  store.onVotes((rows, err) => { if (!err) { state.votes = rows; render(); } });

  footer(store.kind === "firestore" ? "Live · shared with everyone who has the link" : "Local demo");
  wireChrome();
}

function footer(text) { $("#footStatus").textContent = text; }

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

/* ------------------------------------------------------------------ */
/* Chrome: tabs, identity, dialogs                                     */
/* ------------------------------------------------------------------ */

function wireChrome() {
  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => { state.view = tab.dataset.view; render(); });
  }
  $("#meChip").addEventListener("click", openMeDialog);
  $("#btnAddMember").addEventListener("click", addMemberFromDialog);
  $("#newMemberName").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addMemberFromDialog(); } });

  // Search dialog
  const input = $("#searchInput");
  let timer, controller;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value;
    timer = setTimeout(async () => {
      controller?.abort();
      controller = new AbortController();
      const box = $("#searchResults");
      if (q.trim().length < 2) { box.replaceChildren(); return; }
      box.replaceChildren(el("div", { class: "muted small" }, "Searching Open Library…"));
      try {
        const results = await searchBooks(q, { signal: controller.signal });
        renderSearchResults(results);
      } catch (err) {
        if (err.name === "AbortError") return;
        box.replaceChildren(el("div", { class: "muted small" }, "Lookup failed. Try again, or add the book by hand below."));
      }
    }, 320);
  });
  $("#btnSearchClose").addEventListener("click", () => $("#dlgSearch").close());
  $("#btnManualAdd").addEventListener("click", () => {
    const t = $("#manualTitle").value.trim();
    if (!t) return toast("Give it a title");
    submitBook(manualBook(t, $("#manualAuthor").value));
    $("#manualTitle").value = ""; $("#manualAuthor").value = "";
  });

  // New round dialog
  $("#btnRoundCancel").addEventListener("click", () => $("#dlgRound").close());
  $("#formRound").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#roundName").value.trim();
    const mode = $("#formRound").mode.value;
    const per = Math.max(1, Math.min(5, parseInt($("#roundPer").value, 10) || 2));
    const anonymous = $("#roundAnon").checked;
    $("#dlgRound").close();
    await state.store.addRound({ name, mode, booksPerMember: per, anonymous, status: "submitting", createdAt: Date.now(), winnerIds: [] });
    state.view = "now"; render();
    toast("Round open for submissions");
  });

  // Club settings dialog
  $("#btnClubCancel").addEventListener("click", () => $("#dlgClub").close());
  $("#formClub").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#clubNameInput").value.trim() || "Book Club";
    $("#dlgClub").close();
    await state.store.saveSettings({ ...state.settings, name });
    toast("Saved");
  });

  for (const d of document.querySelectorAll("dialog")) {
    d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
  }
}

function openMeDialog() {
  renderMemberList();
  $("#newMemberName").value = "";
  $("#dlgMe").showModal();
}

function renderMemberList() {
  const box = $("#memberList");
  const members = state.settings?.members || [];
  box.replaceChildren(
    ...(members.length ? members.map((m) => el("button", {
      type: "button", class: `btn member-btn ${m.id === state.meId ? "is-me" : ""}`,
      onclick: () => { setMe(m.id); $("#dlgMe").close(); },
    }, el("span", {}, m.name), m.id === state.meId ? el("span", { class: "small muted" }, "that's you") : null))
      : [el("div", { class: "muted small" }, "No members yet. Add your name below.")])
  );
}

async function addMemberFromDialog() {
  const name = $("#newMemberName").value.trim();
  if (!name) return;
  const members = [...(state.settings?.members || [])];
  const existing = members.find((m) => m.name.toLowerCase() === name.toLowerCase());
  let id = existing?.id;
  if (!id) {
    id = "m_" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) + "-" + Math.random().toString(36).slice(2, 6);
    members.push({ id, name });
    await state.store.saveSettings({ ...(state.settings || DEFAULT_SETTINGS), members });
  }
  setMe(id);
  $("#dlgMe").close();
}

function setMe(id) {
  state.meId = id;
  try { localStorage.setItem("bookclub.me", id); } catch { /* ignore */ }
  render();
}

function requireMe() {
  if (state.meId && state.settings?.members.some((m) => m.id === state.meId)) return true;
  openMeDialog();
  return false;
}

/* ------------------------------------------------------------------ */
/* Render                                                              */
/* ------------------------------------------------------------------ */

function render() {
  if (!state.settings) return;
  $("#clubName").textContent = state.settings.name || "Book Club";
  document.title = `${state.settings.name || "Book Club"} · Ballot`;
  $("#meName").textContent = state.meId ? memberName(state.meId) : "pick your name";

  for (const tab of document.querySelectorAll(".tab")) tab.classList.toggle("is-active", tab.dataset.view === state.view);
  for (const v of ["now", "shelf", "stats"]) $(`#view-${v}`).hidden = v !== state.view;

  if (state.view === "now") renderNow();
  else if (state.view === "shelf") renderShelf();
  else renderStats();
}

/* ---------- This round ---------- */

function renderNow() {
  const root = $("#view-now");
  const round = currentRound();
  const frag = document.createDocumentFragment();

  if (!round) {
    frag.append(el("div", { class: "card card-hero stack" },
      el("span", { class: "eyebrow" }, "No round yet"),
      el("h2", { class: "round-title" }, "Start the first round"),
      el("p", { class: "muted", style: "margin:0" }, `Everyone submits ${state.settings.booksPerMember} books, everyone else rates them, and the club picks from the top of the pile.`),
      el("div", { class: "round-actions" },
        el("button", { class: "btn btn-primary", onclick: openNewRound }, "Start a round"),
        el("button", { class: "btn btn-ghost", onclick: openClubDialog }, "Club settings"))));
    root.replaceChildren(frag);
    return;
  }

  const books = roundBooks(round.id);
  const votes = roundVotes(round.id);
  const members = state.settings.members;
  const mine = books.filter((b) => b.submittedBy === state.meId);
  const per = round.booksPerMember || state.settings.booksPerMember || 2;

  // Who has voted on everything they're supposed to
  const votersDone = members.filter((m) => {
    const need = books.filter((b) => b.submittedBy !== m.id);
    if (!need.length) return false;
    const v = votes.find((x) => x.voterId === m.id);
    return v && need.every((b) => typeof v.scores?.[b.id] === "number");
  });
  const submittersDone = new Set(books.map((b) => b.submittedBy)).size;

  // Hero
  const hero = el("div", { class: "card card-hero round-head" },
    el("div", { class: "row spread" },
      el("span", { class: `pill pill-${round.status}` }, { submitting: "Submitting", voting: "Voting open", decided: "Decided" }[round.status]),
      el("button", { class: "btn btn-ghost btn-sm", onclick: openClubDialog }, "Settings")),
    el("h2", { class: "round-title" }, round.name),
    el("div", { class: "round-meta" },
      el("span", {}, round.mode === "yesno" ? "Yes / No vote" : "Excitement, 1–10"),
      el("span", {}, `${per} book${per > 1 ? "s" : ""} each`),
      el("span", { class: "num" }, `${books.length} submitted`),
      isAnonymous(round) ? el("span", {}, "Anonymous until the reveal") : null),
  );

  if (round.status === "submitting") {
    hero.append(
      el("p", { class: "muted small", style: "margin:0" }, `${submittersDone} of ${members.length || "?"} people have submitted. Anyone can vote as books come in.`),
      el("div", { class: "round-actions" },
        el("button", { class: "btn btn-primary", onclick: () => setStatus(round, "voting") }, "Close submissions, open voting"),
        el("button", { class: "btn btn-ghost btn-sm", onclick: () => renameRound(round) }, "Rename")));
  } else if (round.status === "voting") {
    const pct = members.length ? Math.round((votersDone.length / members.length) * 100) : 0;
    hero.append(
      el("div", { class: "stack", style: "gap:6px" },
        el("div", { class: "row spread small muted" },
          el("span", {}, `${votersDone.length} of ${members.length} have voted on everything`),
          el("span", { class: "num" }, `${pct}%`)),
        el("div", { class: "progress" }, el("i", { style: `width:${pct}%` }))),
      el("div", { class: "round-actions" },
        el("button", { class: "btn btn-primary", onclick: () => decide(round) }, "Close voting & reveal results"),
        el("button", { class: "btn btn-ghost btn-sm", onclick: () => setStatus(round, "submitting") }, "Reopen submissions")));
  } else {
    hero.append(el("div", { class: "round-actions" },
      el("button", { class: "btn btn-primary", onclick: openNewRound }, "Start the next round"),
      el("button", { class: "btn btn-ghost btn-sm", onclick: () => setStatus(round, "voting") }, "Reopen voting")));
  }
  frag.append(hero);

  if (round.status === "decided") {
    frag.append(renderResults(round));
    root.replaceChildren(frag);
    return;
  }

  // My picks
  const canSubmit = round.status === "submitting";
  const picks = el("section", { class: "stack" },
    el("div", { class: "row spread" },
      el("h3", { class: "section-title" }, "Your picks"),
      el("span", { class: "small muted num" }, `${mine.length} of ${per}`)),
    mine.length ? el("div", { class: "shelf" }, mine.map((b) => bookCard(b, round, votes, { mine: true }))) : null,
    canSubmit && mine.length < per
      ? el("button", { class: "btn btn-primary", onclick: () => { if (requireMe()) openSearch(); } }, mine.length ? "Submit another book" : "Submit a book")
      : (!canSubmit && !mine.length ? el("p", { class: "muted small", style: "margin:0" }, "Submissions are closed for this round.") : null),
  );
  frag.append(picks);

  // Everyone else's books — vote here
  const others = books.filter((b) => b.submittedBy !== state.meId).sort((a, b) => (a.submittedAt || 0) - (b.submittedAt || 0));
  frag.append(el("section", { class: "stack" },
    el("div", { class: "row spread" },
      el("h3", { class: "section-title" }, "Rate the others"),
      el("span", { class: "small muted" }, round.mode === "yesno" ? "Would you read it?" : "How excited are you?")),
    others.length
      ? el("div", { class: "shelf" }, others.map((b) => bookCard(b, round, votes, { vote: true })))
      : el("div", { class: "empty" }, books.length ? "Nothing to rate yet — only your own books are in." : "No books submitted yet."),
  ));

  root.replaceChildren(frag);
}

function coverEl(book, large = false) {
  const c = el("div", { class: `cover ${large ? "cover-lg" : ""}`, style: `background:${spineColor(book.title)}` });
  if (book.coverUrl) {
    const img = el("img", { src: book.coverUrl, alt: "", loading: "lazy" });
    img.addEventListener("error", () => { img.remove(); c.textContent = book.title; });
    c.append(img);
  } else {
    c.textContent = book.title;
  }
  return c;
}

function spineColor(title) {
  let h = 0;
  for (const ch of title) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 38% 38%)`;
}

function bookFacts(book) {
  const facts = [];
  if (book.year) facts.push(el("span", { class: "num" }, String(book.year)));
  if (book.pages) facts.push(el("span", { class: "num" }, `${book.pages} pp`));
  for (const s of (book.subjects || []).slice(0, 2)) facts.push(el("span", {}, s));
  return facts.length ? el("div", { class: "book-facts" }, facts) : null;
}

function bookCard(book, round, votes, opts = {}) {
  const card = el("article", { class: `book ${opts.mine ? "is-mine" : ""} ${opts.winner ? "is-winner" : ""}` });
  if (opts.rank) card.append(el("span", { class: "rank" }, String(opts.rank)));
  if (opts.winner) card.append(el("span", { class: "ribbon" }, "Our pick"));
  card.append(coverEl(book));
  const body = el("div", { class: "book-body" },
    el("h4", { class: "book-title" }, book.title),
    el("div", { class: "book-author" }, book.author),
    bookFacts(book),
    submitterLine(book, round),
  );

  if (opts.mine) {
    body.append(ownScoreControl(book, round));
    if (round.status === "submitting") {
      body.append(el("div", { class: "row" },
        el("button", { class: "btn btn-ghost btn-sm btn-danger", onclick: () => removeBook(book) }, "Remove")));
    }
  }
  if (opts.vote) body.append(voteControl(book, round, votes));
  if (opts.result) body.append(resultReadout(book, round, opts.result));
  card.append(body);
  return card;
}

/* Submitter's own excitement — a tiebreaker only, never in the mean. */
function ownScoreControl(book, round) {
  const has = typeof book.ownScore === "number";
  const box = el("div", { class: "vote" });
  if (round.mode === "yesno") {
    box.append(el("div", { class: "vote-head" }, el("span", {}, "Your own vote counts only as a tiebreaker")));
    box.append(yesNoButtons(has ? book.ownScore : null, (v) => state.store.updateBook(book.id, { ownScore: v })));
    return box;
  }
  const val = has ? book.ownScore : 7;
  const head = el("div", { class: "vote-head" },
    el("span", {}, "How excited are you about your own pick? (tiebreaker only)"),
    el("span", { class: "vote-val" }, has ? String(val) : "–"));
  const slider = el("input", { type: "range", class: "slider", min: 1, max: 10, step: 1, value: val, id: `own-${book.id}`, "aria-label": "Your own excitement" });
  slider.addEventListener("input", () => { head.lastChild.textContent = slider.value; });
  slider.addEventListener("change", () => state.store.updateBook(book.id, { ownScore: Number(slider.value) }));
  box.append(head, slider);
  return box;
}

function voteControl(book, round, votes) {
  const my = votes.find((v) => v.voterId === state.meId);
  const cur = my?.scores?.[book.id];
  const has = typeof cur === "number";
  const box = el("div", { class: "vote" });

  const save = async (value) => {
    if (!requireMe()) return;
    const id = `${round.id}_${state.meId}`;
    const existing = state.votes.find((v) => v.id === id);
    const scores = { ...(existing?.scores || {}), [book.id]: value };
    await state.store.setVote(id, { roundId: round.id, voterId: state.meId, scores, updatedAt: Date.now() });
  };

  if (round.mode === "yesno") {
    box.append(yesNoButtons(has ? cur : null, save));
    return box;
  }
  const val = has ? cur : 5;
  const head = el("div", { class: "vote-head" },
    el("span", {}, has ? el("span", { class: "vote-word" }, wordFor(val)) : "Slide to rate"),
    el("span", { class: "vote-val num" }, has ? `${val}` : "–"));
  const slider = el("input", { type: "range", class: "slider", min: 1, max: 10, step: 1, value: val, id: `vote-${book.id}`, "aria-label": `Excitement for ${book.title}` });
  slider.addEventListener("input", () => {
    head.firstChild.replaceChildren(el("span", { class: "vote-word" }, wordFor(slider.value)));
    head.lastChild.textContent = slider.value;
  });
  slider.addEventListener("change", () => save(Number(slider.value)));
  box.append(head, slider, el("div", { class: "slider-ticks" }, ["1", "", "", "", "5", "", "", "", "", "10"].map((t) => el("span", {}, t))));
  return box;
}

function yesNoButtons(current, onPick) {
  return el("div", { class: "yesno" },
    el("button", { type: "button", class: `btn ${current === 1 ? "is-on-yes" : ""}`, onclick: () => onPick(1) }, "Yes, read it"),
    el("button", { type: "button", class: `btn ${current === 0 ? "is-on-no" : ""}`, onclick: () => onPick(0) }, "No"));
}

function resultReadout(book, round, t) {
  const box = el("div", { class: "score" },
    el("div", {},
      el("div", { class: "score-num" }, fmtScore(t.mean, round.mode)),
      el("div", { class: "score-sub" }, t.n ? `${fmtUnit(round.mode)} · ${t.n} vote${t.n === 1 ? "" : "s"}` : "no votes")),
    el("div", { class: "meter" }, el("i", { style: `width:${meterPct(t.mean, round.mode)}%` })));
  const wrap = el("div", { class: "stack", style: "gap:4px" }, box);
  if (round.mode === "yesno" && t.n) {
    wrap.append(el("div", { class: "dots" }, t.scores.map((s) => el("span", { class: `dot ${s === 1 ? "is-yes" : "is-no"}` }, s === 1 ? "✓" : "✕"))));
  } else if (t.n) {
    wrap.append(el("div", { class: "small muted num" }, `Votes: ${[...t.scores].sort((a, b) => b - a).join(" · ")}${t.own != null ? ` · own ${t.own}` : ""}`));
  }
  return wrap;
}

/* ---------- Results (decided round) ---------- */

function renderResults(round) {
  const rows = rankBooks(round);
  const winners = new Set(round.winnerIds || []);
  const votes = roundVotes(round.id);
  const voters = new Set(votes.filter((v) => Object.keys(v.scores || {}).length).map((v) => v.voterId)).size;
  const rated = rows.filter((r) => r.t.n > 0);

  const sec = el("section", { class: "stack" });
  sec.append(el("div", { class: "row spread" },
    el("h3", { class: "section-title" }, "Results"),
    el("span", { class: "small muted" }, `${voters} voted · tap a book to toggle it as a pick`)));

  if (rated.length) {
    const top = rated[0], low = rated[rated.length - 1];
    const div = [...rated].filter((r) => r.t.n > 1).sort((a, b) => b.t.sd - a.t.sd)[0];
    sec.append(el("div", { class: "tiles" },
      tile("Most excited about", top.book.title, `${fmtScore(top.t.mean, round.mode)} ${fmtUnit(round.mode)}`),
      rated.length > 1 ? tile("Least excited about", low.book.title, `${fmtScore(low.t.mean, round.mode)} ${fmtUnit(round.mode)}`) : null,
      div && div.t.sd > 0 ? tile("Most divisive", div.book.title, round.mode === "yesno" ? "the room split on it" : `votes ranged ${Math.min(...div.t.scores)}–${Math.max(...div.t.scores)}`) : null,
    ));
  }

  sec.append(el("div", { class: "shelf" }, rows.map((r, i) => {
    const card = bookCard(r.book, round, votes, { rank: i + 1, winner: winners.has(r.book.id), result: r.t });
    card.style.cursor = "pointer";
    card.addEventListener("click", (e) => { if (e.target.closest("button, input")) return; toggleWinner(round, r.book.id); });
    return card;
  })));
  return sec;
}

function tile(label, value, sub, big = false) {
  return el("div", { class: `tile ${big ? "tile-big" : ""}` },
    el("div", { class: "tile-label" }, label),
    el("div", { class: "tile-value" }, value),
    sub ? el("div", { class: "tile-sub" }, sub) : null);
}

/* ---------- Shelf (history) ---------- */

function renderShelf() {
  const root = $("#view-shelf");
  const frag = document.createDocumentFragment();
  frag.append(el("div", { class: "row spread" },
    el("h2", { class: "section-title" }, "Every book we've put forward"),
    el("span", { class: "small muted num" }, `${state.books.length} books · ${state.rounds.length} rounds`)));

  if (!state.rounds.length) frag.append(el("div", { class: "empty" }, "Nothing on the shelf yet."));

  for (const round of state.rounds) {
    const rows = rankBooks(round);
    const winners = new Set(round.winnerIds || []);
    const when = round.decidedAt || round.createdAt;
    const block = el("section", { class: "round-block" },
      el("div", { class: "round-block-head" },
        el("div", { class: "row" },
          el("h3", { class: "section-title" }, round.name),
          el("span", { class: `pill pill-${round.status}` }, { submitting: "Submitting", voting: "Voting", decided: "Decided" }[round.status])),
        el("span", { class: "small muted" }, when ? new Date(when).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "")),
      rows.length
        ? el("div", { class: "shelf" }, rows.map((r, i) => bookCard(r.book, round, roundVotes(round.id), {
            rank: round.status === "decided" ? i + 1 : null, winner: winners.has(r.book.id),
            result: round.status === "decided" ? r.t : null,
          })))
        : el("div", { class: "empty" }, "No books in this round."),
    );
    if (round.status !== "decided" && round.id !== currentRound()?.id) {
      block.append(el("button", { class: "btn btn-ghost btn-sm btn-danger", onclick: () => deleteRound(round) }, "Delete this empty round"));
    }
    frag.append(block);
  }
  root.replaceChildren(frag);
}

/* ---------- Stats ---------- */

function renderStats() {
  const root = $("#view-stats");
  const frag = document.createDocumentFragment();
  const decided = state.rounds.filter((r) => r.status === "decided");
  const members = state.settings.members;

  // All-time per-book excitement (normalized 0–100), only decided rounds
  const allRows = [];
  for (const r of decided) for (const row of rankBooks(r)) if (row.t.n) {
    allRows.push({ ...row, round: r, ex: row.t.scores.reduce((a, s) => a + normalize(s, r.mode), 0) / row.t.n, win: (r.winnerIds || []).includes(row.book.id) });
  }
  allRows.sort((a, b) => b.ex - a.ex);

  const winners = decided.flatMap((r) => (r.winnerIds || []).map((id) => state.books.find((b) => b.id === id)).filter(Boolean));
  const pages = winners.reduce((a, b) => a + (b.pages || 0), 0);

  frag.append(el("h2", { class: "section-title" }, "Club stats"));
  frag.append(el("div", { class: "tiles" },
    tile("Rounds decided", String(decided.length), null, true),
    tile("Books put forward", String(state.books.length), null, true),
    tile("Books we picked", String(winners.length), pages ? `${pages.toLocaleString()} pages between them` : null, true),
    tile("Avg excitement", allRows.length ? `${Math.round(allRows.reduce((a, r) => a + r.ex, 0) / allRows.length)}` : "—", "0–100, all rated books", true),
  ));

  if (allRows.length) {
    const top = allRows.slice(0, 5);
    const low = [...allRows].reverse().slice(0, Math.min(5, Math.max(0, allRows.length - 5)));
    const divisive = allRows.filter((r) => r.t.n > 1).sort((a, b) => b.t.sd / (b.round.mode === "yesno" ? 1 : 9) - a.t.sd / (a.round.mode === "yesno" ? 1 : 9)).slice(0, 3);

    frag.append(section("Most excited about, ever", bars(top, false)));
    if (low.length) frag.append(section("Least excited about", bars(low, true)));
    if (divisive.length) frag.append(section("Most divisive", bars(divisive, false, (r) =>
      r.round.mode === "yesno" ? `${r.t.yes} yes / ${r.t.n - r.t.yes} no` : `${Math.min(...r.t.scores)}–${Math.max(...r.t.scores)}`)));
  }

  // Member table
  if (members.length) {
    const stats = members.map((m) => {
      const submitted = state.books.filter((b) => b.submittedBy === m.id);
      const wins = winners.filter((b) => b.submittedBy === m.id).length;
      const given = [], received = [];
      for (const r of decided) {
        const votes = roundVotes(r.id);
        const v = votes.find((x) => x.voterId === m.id);
        if (v) for (const [bid, s] of Object.entries(v.scores || {})) {
          const b = state.books.find((x) => x.id === bid);
          if (b && b.submittedBy !== m.id && typeof s === "number") given.push(normalize(s, r.mode));
        }
        for (const b of roundBooks(r.id)) if (b.submittedBy === m.id) {
          for (const s of tally(b, r, votes).scores) received.push(normalize(s, r.mode));
        }
      }
      const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
      return { m, submitted: submitted.length, wins, given: avg(given), received: avg(received), nGiven: given.length };
    }).sort((a, b) => (b.received ?? -1) - (a.received ?? -1));

    frag.append(section("Members", el("div", { class: "table-wrap" }, el("table", {},
      el("thead", {}, el("tr", {}, el("th", {}, "Name"), el("th", { class: "num" }, "Submitted"), el("th", { class: "num" }, "Picked"), el("th", { class: "num" }, "Taste ↑"), el("th", { class: "num" }, "Generosity"))),
      el("tbody", {}, stats.map((s) => el("tr", {},
        el("td", {}, s.m.name),
        el("td", { class: "num" }, String(s.submitted)),
        el("td", { class: "num" }, String(s.wins)),
        el("td", { class: "num" }, s.received == null ? "—" : String(s.received)),
        el("td", { class: "num" }, s.given == null ? "—" : String(s.given))))))),
      el("p", { class: "small muted", style: "margin:6px 0 0" }, "Taste: average excitement others gave this person's books. Generosity: average they gave everyone else's. Both on 0–100 so 1–10 and yes/no rounds can be compared.")));
  }

  root.replaceChildren(frag);
}

function section(title, ...children) {
  return el("section", { class: "stack" }, el("h3", { class: "section-title" }, title), ...children);
}

function bars(rows, low, subFn) {
  return el("div", { class: "bars" }, rows.map((r) => el("div", { class: `bar ${low ? "is-low" : ""}` },
    el("div", { class: "bar-label" }, r.book.title, " ", el("small", {}, `· ${r.book.author} · ${memberName(r.book.submittedBy)}${r.win ? " · picked" : ""}`)),
    el("div", { class: "small num muted" }, subFn ? subFn(r) : `${Math.round(r.ex)}`),
    el("div", { class: "bar-track" }, el("i", { style: `width:${Math.max(2, Math.round(r.ex))}%` })))));
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

function openNewRound() {
  const n = state.rounds.length + 1;
  const month = new Date().toLocaleDateString(undefined, { month: "long", year: "numeric" });
  $("#roundName").value = `Round ${n} · ${month}`;
  $("#roundPer").value = String(state.settings.booksPerMember || 2);
  $("#dlgRound").showModal();
}

function openClubDialog() {
  $("#clubNameInput").value = state.settings.name || "";
  $("#dlgClub").showModal();
}

function openSearch() {
  $("#searchInput").value = "";
  $("#searchResults").replaceChildren();
  $("#dlgSearch").showModal();
  setTimeout(() => $("#searchInput").focus(), 50);
}

function renderSearchResults(results) {
  const box = $("#searchResults");
  if (!results.length) return box.replaceChildren(el("div", { class: "muted small" }, "No matches. Try the author's name, or add it by hand below."));
  box.replaceChildren(...results.map((r) => el("button", { type: "button", class: "result", onclick: () => submitBook(r) },
    coverEl(r),
    el("div", {},
      el("div", { class: "result-title" }, r.title),
      el("div", { class: "result-sub" }, [r.author, r.year, r.pages ? `${r.pages} pp` : null].filter(Boolean).join(" · "))))));
}

async function submitBook(book) {
  if (!requireMe()) return;
  const round = currentRound();
  if (!round || round.status !== "submitting") return toast("Submissions are closed");
  const per = round.booksPerMember || 2;
  const mine = roundBooks(round.id).filter((b) => b.submittedBy === state.meId);
  if (mine.length >= per) return toast(`You've already submitted ${per}`);
  if (roundBooks(round.id).some((b) => b.title.toLowerCase() === book.title.toLowerCase())) return toast("That one's already in this round");
  $("#dlgSearch").close();
  await state.store.addBook({ ...book, roundId: round.id, submittedBy: state.meId, submittedAt: Date.now(), ownScore: null });
  toast(`Added “${book.title}”`);
}

async function removeBook(book) {
  if (!confirm(`Remove “${book.title}” from this round?`)) return;
  await state.store.deleteBook(book.id);
}

async function setStatus(round, status) {
  const msg = {
    voting: "Close submissions and open voting? People can still change their votes until you reveal results.",
    submitting: "Reopen submissions?",
  }[status];
  if (msg && !confirm(msg)) return;
  await state.store.updateRound(round.id, { status });
}

async function decide(round) {
  if (!confirm("Close voting and reveal the results to everyone?")) return;
  const rows = rankBooks(round);
  const winnerIds = rows.length && rows[0].t.n ? [rows[0].book.id] : [];
  await state.store.updateRound(round.id, { status: "decided", decidedAt: Date.now(), winnerIds });
  toast(winnerIds.length ? "Results are in" : "Closed — no votes were cast");
}

async function toggleWinner(round, bookId) {
  const set = new Set(round.winnerIds || []);
  set.has(bookId) ? set.delete(bookId) : set.add(bookId);
  await state.store.updateRound(round.id, { winnerIds: [...set] });
}

async function renameRound(round) {
  const name = prompt("Round name", round.name);
  if (name && name.trim()) await state.store.updateRound(round.id, { name: name.trim() });
}

async function deleteRound(round) {
  if (roundBooks(round.id).length) return toast("Remove its books first");
  if (!confirm(`Delete “${round.name}”?`)) return;
  await state.store.deleteRound(round.id);
}

boot();
