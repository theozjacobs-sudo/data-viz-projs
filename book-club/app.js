import { createStore, DEFAULT_SETTINGS } from "./store.js?v=7";
import { searchBooks, manualBook } from "./lookup.js?v=7";

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
/** A book someone has already read is "retired": off the ballot for everyone, and its submitter gets the slot back. */
const isRetired = (book) => book.retired === true;
const activeBooks = (roundId) => roundBooks(roundId).filter((b) => !isRetired(b));
const retiredBooks = (roundId) => roundBooks(roundId).filter(isRetired);
const readByLine = (book) => {
  const names = (book.readBy || []).map(memberName);
  return names.length ? `Already read by ${names.join(", ")}` : "Already read";
};
const currentRound = () => state.rounds.find((r) => r.status !== "decided") || state.rounds[0] || null;
/** Rounds hide who submitted what until results are revealed, unless the round opted out. */
const isAnonymous = (round) => round.anonymous !== false && round.status !== "decided";
const submitterLine = (book, round) => {
  if (book.submittedBy === state.meId) return el("div", { class: "by" }, "Submitted by ", el("b", {}, "you"));
  if (isAnonymous(round)) return el("div", { class: "by" }, "Submitted anonymously");
  return el("div", { class: "by" }, "Submitted by ", el("b", {}, memberName(book.submittedBy)));
};

const ordinal = (n) => `${n}${["th", "st", "nd", "rd"][(n % 100 > 10 && n % 100 < 14) ? 0 : Math.min(n % 10, 4) % 4]}`;

/**
 * Ranked-choice ballots for a round: each voter's ordered list of book ids, limited to books
 * still on the ballot and never including their own.
 */
function rankedBallots(round, votes) {
  const byId = new Map(activeBooks(round.id).map((b) => [b.id, b]));
  const out = [];
  for (const v of votes) {
    const seen = new Set();
    const order = (Array.isArray(v.ranking) ? v.ranking : []).filter((id) => {
      const b = byId.get(id);
      if (!b || b.submittedBy === v.voterId || seen.has(id)) return false;
      seen.add(id); return true;
    });
    if (order.length) out.push({ voterId: v.voterId, order });
  }
  return out;
}
/** A ballot position as 0–100 (top = 100, bottom = 0) so ranked rounds can share the all-time stats. */
const rankPoints = (pos, len) => (len > 1 ? ((len - 1 - pos) / (len - 1)) * 100 : 100);

function rankedTally(book, round, votes) {
  const scores = [], ranks = [];
  for (const b of rankedBallots(round, votes)) {
    const pos = b.order.indexOf(book.id);
    if (pos < 0) continue;
    ranks.push(pos + 1);
    scores.push(rankPoints(pos, b.order.length));
  }
  const n = scores.length;
  const mean = n ? scores.reduce((a, b) => a + b, 0) / n : null;
  const sd = n > 1 ? Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / n) : 0;
  return { scores, ranks, n, mean, sd, yes: null, read: 0, own: null, firsts: ranks.filter((r) => r === 1).length };
}

/**
 * Instant-runoff count. Each ballot counts for its highest-ranked book still standing; the book
 * with the fewest votes is eliminated and its ballots move to their next choice, until one is left.
 * Ties for last go to the book ranked lower across all ballots, then the later submission.
 * Returns the rows in finishing order, with the round-by-round count attached as rows.count.
 */
function rankedCount(round) {
  const votes = roundVotes(round.id);
  const ballots = rankedBallots(round, votes);
  const rows = activeBooks(round.id).map((b) => ({ book: b, t: rankedTally(b, round, votes) }));
  const row = new Map(rows.map((r) => [r.book.id, r]));
  const total = (r) => r.t.scores.reduce((a, b) => a + b, 0);
  const standing = new Set(row.keys());
  const log = [], out = [];
  let decisive = null;
  while (standing.size > 1) {
    const counts = new Map([...standing].map((id) => [id, 0]));
    let live = 0;
    for (const b of ballots) {
      const top = b.order.find((id) => standing.has(id));
      if (top) { counts.set(top, counts.get(top) + 1); live++; }
    }
    const order = [...standing].sort((x, y) =>
      counts.get(x) - counts.get(y)
      || total(row.get(x)) - total(row.get(y))
      || row.get(x).t.n - row.get(y).t.n
      || (row.get(y).book.submittedAt || 0) - (row.get(x).book.submittedAt || 0));
    const loser = order[0], leader = order[order.length - 1];
    log.push({ counts, live, eliminated: loser, leader });
    if (decisive == null && live && counts.get(leader) * 2 > live) decisive = log.length;
    standing.delete(loser);
    out.push(loser);
    row.get(loser).t.outRound = log.length;
  }
  const finish = [...standing, ...out.reverse()];
  const sorted = finish.map((id, i) => { const r = row.get(id); r.t.place = i + 1; return r; });
  sorted.count = { log, ballots: ballots.length, decisive: decisive ?? log.length };
  return sorted;
}

/** Per-book tally. Submitter's own score is excluded from the mean and kept as a tiebreaker. */
function tally(book, round, votes) {
  if (round.mode === "ranked") return rankedTally(book, round, votes);
  const scores = [];
  let read = 0;
  for (const v of votes) {
    if (v.voterId === book.submittedBy) continue;
    if (v.read?.[book.id]) { read++; continue; }   // already read it: sits this one out
    const s = v.scores?.[book.id];
    if (typeof s === "number") scores.push(s);
  }
  const n = scores.length;
  const mean = n ? scores.reduce((a, b) => a + b, 0) / n : null;
  const sd = n > 1 ? Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / n) : 0;
  const yes = round.mode === "yesno" ? scores.filter((s) => s === 1).length : null;
  return { scores, n, mean, sd, yes, read, own: typeof book.ownScore === "number" ? book.ownScore : null };
}

function rankBooks(round) {
  if (round.mode === "ranked") return rankedCount(round);
  const votes = roundVotes(round.id);
  const rows = activeBooks(round.id).map((b) => ({ book: b, t: tally(b, round, votes) }));
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
const normalize = (score, mode) => (mode === "ranked" ? score : mode === "yesno" ? score * 100 : ((score - 1) / 9) * 100);
const MODE_LABEL = { ranked: "Ranked choice", yesno: "Yes / No vote", scale: "Excitement, 1–10" };

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
    // Never write defaults back: a first snapshot can arrive empty before the server answers.
    state.settings = s || { ...DEFAULT_SETTINGS };
    render();
    if (s) healMembership(s);
  });
  store.onRounds((rows, err) => {
    if (err) return footer("Can't read rounds. Check the Firestore rules.");
    state.rounds = rows.map((r) => (r.method === "ranked" ? { ...r, mode: "ranked" } : r)).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    render();
  });
  store.onBooks((rows, err) => { if (!err) { state.books = rows; render(); migrateLegacyReads(); } });
  store.onVotes((rows, err) => { if (!err) { state.votes = rows; render(); migrateLegacyReads(); } });

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
    // Ranked choice is saved as method:"ranked" on a "scale" round, so the database rules already in place accept it.
    const how = mode === "ranked" ? { mode: "scale", method: "ranked" } : { mode };
    await state.store.addRound({ name, ...how, booksPerMember: per, anonymous, status: "submitting", createdAt: Date.now(), winnerIds: [] });
    state.view = "now"; render();
    toast("Round open for submissions");
  });

  // Club settings dialog
  $("#btnClubCancel").addEventListener("click", () => $("#dlgClub").close());
  $("#formClub").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("#clubNameInput").value.trim() || "Book Club";
    $("#dlgClub").close();
    try { await state.store.saveSettings({ name }); toast("Saved"); }
    catch (err) { console.error(err); toast("Couldn't save. Add a member first, then rename."); }
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
    ...(members.length ? members.map((m) => {
      const hasBooks = state.books.some((b) => b.submittedBy === m.id);
      const row = el("button", {
        type: "button", class: `btn member-btn ${m.id === state.meId ? "is-me" : ""}`,
        onclick: () => { setMe(m.id); $("#dlgMe").close(); },
      }, el("span", {}, m.name), m.id === state.meId ? el("span", { class: "small muted" }, "that's you") : null);
      if (!hasBooks && m.id !== state.meId) {
        row.append(el("span", {
          class: "small muted member-remove", role: "button", tabindex: "0", title: "Remove this name",
          onclick: async (e) => {
            e.stopPropagation();
            if (!confirm(`Remove “${m.name}” from the club? (They have no books submitted.)`)) return;
            try { await state.store.removeMember(m); renderMemberList(); } catch (err) { console.error(err); toast("Couldn't remove"); }
          },
        }, "remove"));
      }
      return row;
    })
      : [el("div", { class: "muted small" }, "No members yet. Add your name below.")])
  );
}

async function addMemberFromDialog() {
  const name = $("#newMemberName").value.trim();
  if (!name) return;
  if (["anonymous", "anon", "someone", "you", "me"].includes(name.toLowerCase())) {
    return toast("Use your real name. Submissions are already hidden until the reveal.");
  }
  const members = [...(state.settings?.members || [])];
  const existing = members.find((m) => m.name.toLowerCase() === name.toLowerCase());
  let id = null;
  if (existing) {
    if (confirm(`“${existing.name}” is already in the club. Is that you?`)) id = existing.id;
    else return toast("Add an initial or a nickname so we can tell you apart.");
  }
  if (!id) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20);
    // If books were submitted under this name's id but the member entry is gone, adopt that id
    // so those books are theirs again.
    const known = new Set(members.map((m) => m.id));
    const orphan = state.books.map((b) => b.submittedBy).find((sid) => sid && !known.has(sid) && sid.startsWith(`m_${slug}-`));
    id = orphan || `m_${slug}-${Math.random().toString(36).slice(2, 6)}`;
    try { await state.store.addMember({ id, name }); }
    catch (err) { console.error(err); return toast("Couldn't save your name. Try again."); }
  }
  setMe(id);
  $("#dlgMe").close();
}

function setMe(id) {
  state.meId = id;
  try {
    localStorage.setItem("bookclub.me", id);
    const name = state.settings?.members.find((m) => m.id === id)?.name;
    if (name) localStorage.setItem("bookclub.meName", name);
  } catch { /* ignore */ }
  render();
}

/** If this device's member entry has vanished from the club list, put it back. */
let healing = false;
async function healMembership(settings) {
  if (healing || !state.meId || !settings || settings.members.some((m) => m.id === state.meId)) return;
  let name = null;
  try { name = localStorage.getItem("bookclub.meName"); } catch { /* ignore */ }
  if (!name) {
    const slug = (state.meId.match(/^m_(.+)-[a-z0-9]{4}$/) || [])[1];
    if (slug) name = slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  }
  if (!name) return;
  healing = true;
  try { await state.store.addMember({ id: state.meId, name }); }
  catch (err) { console.error("could not restore membership", err); }
  finally { healing = false; }
}

/**
 * "Already read it" used to be a private flag on each person's vote. In a round that is still
 * open, promote those flags to the shared book so the book leaves everyone's ballot.
 * Decided rounds are left exactly as they were scored.
 */
const migrated = new Set();
function migrateLegacyReads() {
  for (const round of state.rounds) {
    if (round.status === "decided") continue;
    const votes = roundVotes(round.id);
    for (const book of roundBooks(round.id)) {
      if (book.retired !== undefined || migrated.has(book.id)) continue;
      const readers = votes.filter((v) => v.read?.[book.id] && v.voterId !== book.submittedBy).map((v) => v.voterId);
      if (!readers.length) continue;
      migrated.add(book.id);
      state.store.updateBook(book.id, { retired: true, readBy: readers, retiredAt: Date.now() })
        .catch((err) => { console.error("could not retire", book.title, err); migrated.delete(book.id); });
    }
  }
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
      el("p", { class: "muted", style: "margin:0" }, `Everyone submits ${state.settings.booksPerMember} books, everyone else ranks them, and the club picks from the top of the pile.`),
      el("div", { class: "round-actions" },
        el("button", { class: "btn btn-primary", onclick: openNewRound }, "Start a round"),
        el("button", { class: "btn btn-ghost", onclick: openClubDialog }, "Club settings"))));
    root.replaceChildren(frag);
    return;
  }

  const books = activeBooks(round.id);
  const retired = retiredBooks(round.id);
  const votes = roundVotes(round.id);
  const members = state.settings.members;
  const mine = books.filter((b) => b.submittedBy === state.meId);
  const mineRetired = retired.filter((b) => b.submittedBy === state.meId);
  const per = round.booksPerMember || state.settings.booksPerMember || 2;

  // Who has voted on everything they're supposed to
  const votersDone = members.filter((m) => {
    const need = books.filter((b) => b.submittedBy !== m.id);
    if (!need.length) return false;
    const v = votes.find((x) => x.voterId === m.id);
    if (round.mode === "ranked") return !!v && need.every((b) => (v.ranking || []).includes(b.id));
    return v && need.every((b) => typeof v.scores?.[b.id] === "number" || v.read?.[b.id]);
  });
  const submittersDone = new Set(books.map((b) => b.submittedBy)).size;

  // Hero
  const hero = el("div", { class: "card card-hero round-head" },
    el("div", { class: "row spread" },
      el("span", { class: `pill pill-${round.status}` }, { submitting: "Submitting", voting: "Voting open", decided: "Decided" }[round.status]),
      el("button", { class: "btn btn-ghost btn-sm", onclick: openClubDialog }, "Settings")),
    el("h2", { class: "round-title" }, round.name),
    el("div", { class: "round-meta" },
      el("span", {}, MODE_LABEL[round.mode] || MODE_LABEL.scale),
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
          el("span", {}, `${votersDone.length} of ${members.length} have ${round.mode === "ranked" ? "ranked" : "voted on"} everything`),
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
  // A submitter whose book was retired may replace it even after submissions close.
  const owedReplacement = mineRetired.length > 0 && mine.length < per;
  const canSubmit = round.status === "submitting" || owedReplacement;
  const picks = el("section", { class: "stack" },
    el("div", { class: "row spread" },
      el("h3", { class: "section-title" }, "Your picks"),
      el("span", { class: "small muted num" }, `${mine.length} of ${per}`)),
    owedReplacement
      ? el("div", { class: "notice" },
          el("b", {}, mineRetired.length === 1 ? `Someone's already read “${mineRetired[0].title}”.` : "Some of your picks have already been read."),
          ` ${mineRetired.length === 1 ? "It's" : "They're"} off the ballot, so you get another suggestion.`)
      : null,
    mine.length || mineRetired.length
      ? el("div", { class: "shelf" },
          mine.map((b) => bookCard(b, round, votes, { mine: true })),
          mineRetired.map((b) => bookCard(b, round, votes, { mine: true, retired: true })))
      : null,
    canSubmit && mine.length < per
      ? el("button", { class: "btn btn-primary", onclick: () => { if (requireMe()) openSearch(); } },
          owedReplacement ? "Submit a replacement" : mine.length ? "Submit another book" : "Submit a book")
      : (!canSubmit && !mine.length ? el("p", { class: "muted small", style: "margin:0" }, "Submissions are closed for this round.") : null),
  );
  frag.append(picks);

  // Everyone else's books — vote here
  const others = books.filter((b) => b.submittedBy !== state.meId).sort((a, b) => (a.submittedAt || 0) - (b.submittedAt || 0));
  if (round.mode === "ranked") {
    const order = myRanking(round);
    const pos = (b) => order.indexOf(b.id);
    const ranked = others.filter((b) => pos(b) >= 0).sort((a, b) => pos(a) - pos(b));
    const unranked = others.filter((b) => pos(b) < 0);
    frag.append(el("section", { class: "stack" },
      el("div", { class: "row spread" },
        el("h3", { class: "section-title" }, "Rank the others"),
        el("span", { class: "small muted num" }, others.length ? `${ranked.length} of ${others.length} ranked` : "")),
      others.length
        ? el("p", { class: "muted small", style: "margin:0" }, "Tap books in the order you'd want to read them: first choice first. If your top choice is knocked out, your vote moves to your next one. Leave a book unranked and it never gets your vote.")
        : null,
      ranked.length ? el("div", { class: "shelf" }, ranked.map((b) => bookCard(b, round, votes, { vote: true, rank: pos(b) + 1 }))) : null,
      ranked.length && unranked.length ? el("div", { class: "small muted", style: "margin-top:4px" }, "Not ranked yet") : null,
      unranked.length ? el("div", { class: "shelf" }, unranked.map((b) => bookCard(b, round, votes, { vote: true }))) : null,
      others.length ? null : el("div", { class: "empty" }, books.length ? "Nothing to rank yet — only your own books are in." : "No books submitted yet."),
    ));
  } else {
  frag.append(el("section", { class: "stack" },
    el("div", { class: "row spread" },
      el("h3", { class: "section-title" }, "Rate the others"),
      el("span", { class: "small muted" }, round.mode === "yesno" ? "Would you read it?" : "How excited are you?")),
    others.length
      ? el("div", { class: "shelf" }, others.map((b) => bookCard(b, round, votes, { vote: true })))
      : el("div", { class: "empty" }, books.length ? "Nothing to rate yet — only your own books are in." : "No books submitted yet."),
  ));
  }

  // Off the ballot: books someone had already read
  const othersRetired = retired.filter((b) => b.submittedBy !== state.meId);
  if (othersRetired.length) {
    frag.append(el("section", { class: "stack" },
      el("div", { class: "row spread" },
        el("h3", { class: "section-title" }, "Off the ballot"),
        el("span", { class: "small muted" }, "Someone's read these. Nobody votes on them.")),
      el("div", { class: "shelf" }, othersRetired.map((b) => bookCard(b, round, votes, { retired: true })))));
  }

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
  const card = el("article", { class: `book ${opts.mine ? "is-mine" : ""} ${opts.winner ? "is-winner" : ""} ${opts.retired ? "is-retired" : ""}` });
  if (opts.rank) card.append(el("span", { class: "rank" }, String(opts.rank)));
  if (opts.winner) card.append(el("span", { class: "ribbon" }, "Our pick"));
  card.append(coverEl(book));
  const body = el("div", { class: "book-body" },
    el("h4", { class: "book-title" }, book.title),
    el("div", { class: "book-author" }, book.author),
    bookFacts(book),
    submitterLine(book, round),
  );

  if (opts.retired) {
    const iMarked = (book.readBy || []).includes(state.meId);
    body.append(el("div", { class: "retired-line" },
      el("span", { class: "tag-read" }, "Off the ballot"),
      el("span", { class: "small muted" }, readByLine(book)),
      iMarked && round.status !== "decided"
        ? el("button", { type: "button", class: "btn btn-ghost btn-sm", onclick: () => unretireBook(book, round) }, "Undo")
        : null));
    card.append(body);
    return card;
  }
  if (opts.mine) {
    body.append(round.mode === "ranked"
      ? el("div", { class: "vote" }, el("div", { class: "vote-head" }, el("span", {}, "Your own pick stays off your ballot. Everyone else ranks it.")))
      : ownScoreControl(book, round));
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

/** My ranking for this round: book ids, first choice first, limited to books I can still vote on. */
function myRanking(round) {
  const mine = state.votes.find((v) => v.id === `${round.id}_${state.meId}`);
  const ok = new Set(activeBooks(round.id).filter((b) => b.submittedBy !== state.meId).map((b) => b.id));
  return [...new Set(Array.isArray(mine?.ranking) ? mine.ranking : [])].filter((id) => ok.has(id));
}

async function saveRanking(round, order) {
  if (!requireMe()) return;
  const id = `${round.id}_${state.meId}`;
  const existing = state.votes.find((v) => v.id === id);
  try {
    await state.store.setVote(id, {
      roundId: round.id, voterId: state.meId,
      scores: { ...(existing?.scores || {}) }, read: { ...(existing?.read || {}) },
      ranking: order, updatedAt: Date.now(),
    });
  } catch (err) { console.error(err); toast("Couldn't save. Try again."); }
}

function rankControl(book, round) {
  const order = myRanking(round);
  const i = order.indexOf(book.id);
  const move = (to) => { const next = order.filter((id) => id !== book.id); next.splice(to, 0, book.id); saveRanking(round, next); };
  const readBtn = el("button", {
    type: "button", class: "btn btn-sm btn-ghost", title: "Takes this book off the ballot for everyone",
    onclick: () => retireBook(book),
  }, "Already read it");
  const box = el("div", { class: "vote" });
  if (i < 0) {
    box.append(el("div", { class: "rank-row" },
      el("button", { type: "button", class: "btn btn-sm rank-add", onclick: () => saveRanking(round, [...order, book.id]) }, `Make it my ${ordinal(order.length + 1)} choice`),
      readBtn));
    return box;
  }
  box.append(
    el("div", { class: "vote-head" }, el("span", {}, el("span", { class: "vote-word" }, `Your ${ordinal(i + 1)} choice`))),
    el("div", { class: "rank-row" },
      el("button", { type: "button", class: "btn btn-sm", disabled: i === 0, "aria-label": `Move ${book.title} up`, onclick: () => move(i - 1) }, "▲ Up"),
      el("button", { type: "button", class: "btn btn-sm", disabled: i === order.length - 1, "aria-label": `Move ${book.title} down`, onclick: () => move(i + 1) }, "▼ Down"),
      el("button", { type: "button", class: "btn btn-sm btn-ghost", onclick: () => saveRanking(round, order.filter((id) => id !== book.id)) }, "Unrank"),
      readBtn));
  return box;
}

function voteControl(book, round, votes) {
  if (round.mode === "ranked") return rankControl(book, round);
  const my = votes.find((v) => v.voterId === state.meId);
  const cur = my?.scores?.[book.id];
  const has = typeof cur === "number";
  const box = el("div", { class: "vote" });

  const save = async (value) => {
    if (!requireMe()) return;
    const id = `${round.id}_${state.meId}`;
    const existing = state.votes.find((v) => v.id === id);
    await state.store.setVote(id, {
      roundId: round.id, voterId: state.meId,
      scores: { ...(existing?.scores || {}), [book.id]: value },
      read: { ...(existing?.read || {}) },
      ...(existing?.ranking ? { ranking: existing.ranking } : {}),
      updatedAt: Date.now(),
    });
  };
  const readBtn = el("button", {
    type: "button", class: "btn btn-sm btn-ghost", title: "Takes this book off the ballot for everyone",
    onclick: () => retireBook(book),
  }, "Already read it");

  if (round.mode === "yesno") {
    box.append(yesNoButtons(has ? cur : null, save), el("div", { class: "row", style: "justify-content:flex-end" }, readBtn));
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
  box.append(head, slider,
    el("div", { class: "slider-ticks" }, ["1", "", "", "", "5", "", "", "", "", "10"].map((t) => el("span", {}, t))),
    el("div", { class: "row", style: "justify-content:flex-end" }, readBtn));
  return box;
}

function yesNoButtons(current, onPick) {
  return el("div", { class: "yesno" },
    el("button", { type: "button", class: `btn ${current === 1 ? "is-on-yes" : ""}`, onclick: () => onPick(1) }, "Yes, read it"),
    el("button", { type: "button", class: `btn ${current === 0 ? "is-on-no" : ""}`, onclick: () => onPick(0) }, "No"));
}

function resultReadout(book, round, t) {
  if (round.mode === "ranked") {
    return el("div", { class: "stack", style: "gap:4px" },
      el("div", { class: "score" },
        el("div", {},
          el("div", { class: "score-num" }, String(t.firsts)),
          el("div", { class: "score-sub" }, t.n ? `first-choice vote${t.firsts === 1 ? "" : "s"} · on ${t.n} ballot${t.n === 1 ? "" : "s"}` : "nobody ranked it")),
        el("div", { class: "meter" }, el("i", { style: `width:${t.mean == null ? 0 : t.mean}%` }))),
      t.n ? el("div", { class: "small muted num" }, `Ranked: ${[...t.ranks].sort((a, b) => a - b).map(ordinal).join(" · ")}`) : null);
  }
  const box = el("div", { class: "score" },
    el("div", {},
      el("div", { class: "score-num" }, fmtScore(t.mean, round.mode)),
      el("div", { class: "score-sub" }, [t.n ? `${fmtUnit(round.mode)} · ${t.n} vote${t.n === 1 ? "" : "s"}` : "no votes", t.read ? `${t.read} already read it` : null].filter(Boolean).join(" · "))),
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
  const voters = round.mode === "ranked" ? rows.count.ballots : new Set(votes.filter((v) => Object.keys(v.scores || {}).length).map((v) => v.voterId)).size;
  const rated = rows.filter((r) => r.t.n > 0);

  const sec = el("section", { class: "stack" });
  sec.append(el("div", { class: "row spread" },
    el("h3", { class: "section-title" }, "Results"),
    el("span", { class: "small muted" }, `${voters} voted · tap a book to toggle it as a pick`)));

  if (round.mode === "ranked" && rated.length) {
    const { log, decisive } = rows.count;
    const title = (id) => rows.find((r) => r.book.id === id)?.book.title || "?";
    const won = log[decisive - 1];
    const div = [...rated].filter((r) => r.t.n > 1).sort((a, b) => b.t.sd - a.t.sd)[0];
    sec.append(el("div", { class: "tiles" },
      tile("Winner", rows[0].book.title, !won ? "the only book standing"
        : won.counts.get(rows[0].book.id) * 2 > won.live ? `${won.counts.get(rows[0].book.id)} of ${won.live} votes in round ${decisive}`
        : `tied ${won.counts.get(rows[0].book.id)}–${won.counts.get(won.eliminated)} in the final round; ranked higher overall`),
      rows.length > 1 && rows[1].t.n ? tile("Runner-up", rows[1].book.title, `${rows[1].t.firsts} first-choice vote${rows[1].t.firsts === 1 ? "" : "s"}`) : null,
      div && div.t.sd > 0 ? tile("Most divisive", div.book.title, `ranked anywhere from ${ordinal(Math.min(...div.t.ranks))} to ${ordinal(Math.max(...div.t.ranks))}`) : null,
    ));
    if (log.length) {
      sec.append(el("details", { class: "count" },
        el("summary", {}, "How the count went"),
        el("ol", { class: "count-list" }, log.slice(0, decisive).map((step, i) => {
          const line = [...step.counts].sort((a, b) => b[1] - a[1]).map(([id, n]) => `${title(id)} ${n}`).join(" · ");
          const end = i === decisive - 1 && step.counts.get(step.leader) * 2 > step.live
            ? `${title(step.leader)} has a majority.`
            : i === log.length - 1 ? `A tie. ${title(step.leader)} takes it for ranking higher across all ballots.`
            : `${title(step.eliminated)} is out; its votes move to their next choice.`;
          return el("li", {}, el("span", { class: "num" }, line), el("div", { class: "small muted" }, end));
        })),
        el("p", { class: "small muted", style: "margin:6px 0 0" }, "Each ballot counts for its highest-ranked book still standing. The order below the winner is the order books would have been knocked out.")));
    }
  } else if (rated.length) {
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
      rows.length || retiredBooks(round.id).length
        ? el("div", { class: "shelf" }, rows.map((r, i) => bookCard(r.book, round, roundVotes(round.id), {
            rank: round.status === "decided" ? i + 1 : null, winner: winners.has(r.book.id),
            result: round.status === "decided" ? r.t : null,
          })), retiredBooks(round.id).map((b) => bookCard(b, round, [], { retired: true })))
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

const SPREAD = { yesno: 1, scale: 9, ranked: 100 };

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
    const divisive = allRows.filter((r) => r.t.n > 1).sort((a, b) => b.t.sd / SPREAD[b.round.mode] - a.t.sd / SPREAD[a.round.mode]).slice(0, 3);

    frag.append(section("Most excited about, ever", bars(top, false)));
    if (low.length) frag.append(section("Least excited about", bars(low, true)));
    if (divisive.length) frag.append(section("Most divisive", bars(divisive, false, (r) =>
      r.round.mode === "yesno" ? `${r.t.yes} yes / ${r.t.n - r.t.yes} no`
        : r.round.mode === "ranked" ? `ranked ${ordinal(Math.min(...r.t.ranks))}–${ordinal(Math.max(...r.t.ranks))}`
        : `${Math.min(...r.t.scores)}–${Math.max(...r.t.scores)}`)));
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
        // A ranking can't be generous or stingy, so ranked rounds are left out of Generosity.
        if (r.mode !== "ranked" && v) for (const [bid, s] of Object.entries(v.scores || {})) {
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
      el("p", { class: "small muted", style: "margin:6px 0 0" }, "Taste: average excitement others gave this person's books. Generosity: average they gave everyone else's. Both on 0–100 so 1–10, yes/no and ranked-choice rounds can be compared (in a ranked round, a first choice is 100 and a last choice is 0; ranked rounds don't count toward Generosity).")));
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
  if (!round || round.status === "decided") return toast("Submissions are closed");
  const per = round.booksPerMember || 2;
  const mine = activeBooks(round.id).filter((b) => b.submittedBy === state.meId);
  const owed = retiredBooks(round.id).some((b) => b.submittedBy === state.meId);
  if (round.status !== "submitting" && !owed) return toast("Submissions are closed");
  if (mine.length >= per) return toast(`You've already submitted ${per}`);
  if (roundBooks(round.id).some((b) => b.title.toLowerCase() === book.title.toLowerCase())) return toast("That one's already in this round");
  $("#dlgSearch").close();
  await state.store.addBook({ ...book, roundId: round.id, submittedBy: state.meId, submittedAt: Date.now(), ownScore: null });
  toast(`Added “${book.title}”`);
}

/** Someone has read it: off the ballot for everyone, and the submitter gets the slot back. */
async function retireBook(book) {
  if (!requireMe()) return;
  if (!confirm(`Already read “${book.title}”?\n\nThis takes it off the ballot for everyone, and whoever suggested it gets to suggest another.`)) return;
  try {
    await state.store.updateBook(book.id, { retired: true, readBy: [...new Set([...(book.readBy || []), state.meId])], retiredAt: Date.now() });
    toast("Off the ballot");
  } catch (err) { console.error(err); toast("Couldn't save. Try again."); }
}

async function unretireBook(book, round) {
  const per = round.booksPerMember || 2;
  const theirs = activeBooks(round.id).filter((b) => b.submittedBy === book.submittedBy).length;
  if (theirs >= per) return toast("Too late to undo: a replacement is already in.");
  if (!confirm(`Put “${book.title}” back on the ballot?`)) return;
  try { await state.store.updateBook(book.id, { retired: false, readBy: [], retiredAt: null }); toast("Back on the ballot"); }
  catch (err) { console.error(err); toast("Couldn't save. Try again."); }
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
