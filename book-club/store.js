// Data layer. Two adapters with the same surface:
//   - FirestoreStore: shared, realtime, free tier (the real thing)
//   - LocalStore: this browser only, for demo mode and offline fallback
//
// Surface:
//   onSettings(cb) / saveSettings(obj)
//   onRounds(cb)   / addRound(obj) -> id / updateRound(id, patch) / deleteRound(id)
//   onBooks(cb)    / addBook(obj)  -> id / updateBook(id, patch)  / deleteBook(id)
//   onVotes(cb)    / setVote(id, obj)
// Callbacks receive arrays of {id, ...data} (settings receives one object or null).

import { firebaseConfig } from "./firebase-config.js";

export const DEFAULT_SETTINGS = { name: "Book Club", members: [], booksPerMember: 2 };

export function configLooksReal(cfg) {
  return cfg && cfg.projectId && !/PASTE_ME/.test(cfg.projectId) && !/PASTE_ME/.test(cfg.apiKey || "");
}

export async function createStore() {
  if (configLooksReal(firebaseConfig)) {
    try {
      const s = new FirestoreStore();
      await s.init(firebaseConfig);
      return s;
    } catch (err) {
      console.error("Firestore unavailable, falling back to local demo mode", err);
      const s = new LocalStore();
      s.fallbackError = err;
      return s;
    }
  }
  return new LocalStore();
}

/* ------------------------------------------------------------------ */
/* Firestore                                                           */
/* ------------------------------------------------------------------ */

export class FirestoreStore {
  kind = "firestore";

  async init(config) {
    const v = "10.14.1";
    const [{ initializeApp }, fs] = await Promise.all([
      import(`https://www.gstatic.com/firebasejs/${v}/firebase-app.js`),
      import(`https://www.gstatic.com/firebasejs/${v}/firebase-firestore.js`),
    ]);
    this.fs = fs;
    const app = initializeApp(config);
    this.db = fs.getFirestore(app);
  }

  _col(name) { return this.fs.collection(this.db, name); }
  _sub(name, cb) {
    return this.fs.onSnapshot(
      this._col(name),
      (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
      (err) => { console.error(name, err); cb(null, err); }
    );
  }

  onSettings(cb) {
    return this.fs.onSnapshot(this.fs.doc(this.db, "settings", "club"), (snap) => {
      cb(snap.exists() ? { ...DEFAULT_SETTINGS, ...snap.data() } : null);
    }, (err) => cb(null, err));
  }
  saveSettings(obj) {
    return this.fs.setDoc(this.fs.doc(this.db, "settings", "club"), { ...obj, updatedAt: Date.now() });
  }

  onRounds(cb) { return this._sub("rounds", cb); }
  async addRound(obj) { const ref = await this.fs.addDoc(this._col("rounds"), obj); return ref.id; }
  updateRound(id, patch) { return this.fs.updateDoc(this.fs.doc(this.db, "rounds", id), patch); }
  deleteRound(id) { return this.fs.deleteDoc(this.fs.doc(this.db, "rounds", id)); }

  onBooks(cb) { return this._sub("books", cb); }
  async addBook(obj) { const ref = await this.fs.addDoc(this._col("books"), obj); return ref.id; }
  updateBook(id, patch) { return this.fs.updateDoc(this.fs.doc(this.db, "books", id), patch); }
  deleteBook(id) { return this.fs.deleteDoc(this.fs.doc(this.db, "books", id)); }

  onVotes(cb) { return this._sub("votes", cb); }
  setVote(id, obj) { return this.fs.setDoc(this.fs.doc(this.db, "votes", id), obj); }
}

/* ------------------------------------------------------------------ */
/* Local (demo) store                                                  */
/* ------------------------------------------------------------------ */

const LS_KEY = "bookclub.local.v1";

export class LocalStore {
  kind = "local";

  constructor() {
    this.listeners = { settings: new Set(), rounds: new Set(), books: new Set(), votes: new Set() };
    this.data = this._load() || seedDemo();
    this._save();
  }

  _load() {
    try { const raw = localStorage.getItem(LS_KEY); return raw ? JSON.parse(raw) : null; }
    catch { return null; }
  }
  _save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(this.data)); } catch { /* private mode etc. */ }
  }
  _emit(kind) {
    const payload = kind === "settings"
      ? (this.data.settings ? { ...DEFAULT_SETTINGS, ...this.data.settings } : null)
      : Object.entries(this.data[kind]).map(([id, d]) => ({ id, ...d }));
    for (const cb of this.listeners[kind]) cb(payload);
  }
  _on(kind, cb) {
    this.listeners[kind].add(cb);
    queueMicrotask(() => { if (this.listeners[kind].has(cb)) this._emit(kind); });
    return () => this.listeners[kind].delete(cb);
  }
  _id() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }

  reset() { this.data = seedDemo(); this._save(); for (const k of Object.keys(this.listeners)) this._emit(k); }

  onSettings(cb) { return this._on("settings", cb); }
  async saveSettings(obj) { this.data.settings = { ...obj, updatedAt: Date.now() }; this._save(); this._emit("settings"); }

  onRounds(cb) { return this._on("rounds", cb); }
  async addRound(obj) { const id = this._id(); this.data.rounds[id] = { ...obj }; this._save(); this._emit("rounds"); return id; }
  async updateRound(id, patch) { Object.assign(this.data.rounds[id], patch); this._save(); this._emit("rounds"); }
  async deleteRound(id) { delete this.data.rounds[id]; this._save(); this._emit("rounds"); }

  onBooks(cb) { return this._on("books", cb); }
  async addBook(obj) { const id = this._id(); this.data.books[id] = { ...obj }; this._save(); this._emit("books"); return id; }
  async updateBook(id, patch) { Object.assign(this.data.books[id], patch); this._save(); this._emit("books"); }
  async deleteBook(id) { delete this.data.books[id]; this._save(); this._emit("books"); }

  onVotes(cb) { return this._on("votes", cb); }
  async setVote(id, obj) { this.data.votes[id] = { ...obj }; this._save(); this._emit("votes"); }
}

/* Example data so demo mode opens on something real-looking. Live mode never seeds. */
function seedDemo() {
  const members = [
    { id: "m_ava", name: "Ava" },
    { id: "m_ben", name: "Ben" },
    { id: "m_cleo", name: "Cleo" },
    { id: "m_dev", name: "Dev" },
  ];
  const t = Date.now();
  const rounds = {
    r1: { name: "Round 1 · Example", status: "decided", mode: "scale", booksPerMember: 2, createdAt: t - 40 * 864e5, decidedAt: t - 33 * 864e5, winnerIds: ["b3"] },
    r2: { name: "Round 2 · Example", status: "voting", mode: "scale", booksPerMember: 2, createdAt: t - 2 * 864e5, winnerIds: [] },
  };
  const bk = (roundId, title, author, year, pages, coverId, by, subjects, ownScore) => ({
    roundId, title, author, year, pages, coverId, coverUrl: coverId ? `https://covers.openlibrary.org/b/id/${coverId}-M.jpg` : "",
    olKey: "", subjects, submittedBy: by, submittedAt: t - 3 * 864e5, ownScore: ownScore ?? null,
  });
  const books = {
    b1: bk("r1", "Piranesi", "Susanna Clarke", 2020, 272, 10226290, "m_ava", ["Fantasy"], 9),
    b2: bk("r1", "The Overstory", "Richard Powers", 2018, 531, 8758252, "m_ben", ["Fiction", "Trees"], 8),
    b3: bk("r1", "Tomorrow, and Tomorrow, and Tomorrow", "Gabrielle Zevin", 2022, 460, 12859975, "m_cleo", ["Fiction", "Video games"], 10),
    b4: bk("r1", "Say Nothing", "Patrick Radden Keefe", 2018, 536, 9242450, "m_dev", ["Nonfiction", "Northern Ireland"], 7),
    b5: bk("r2", "Trust", "Hernan Diaz", 2022, 416, 12742248, "m_ava", ["Fiction"], 8),
    b6: bk("r2", "Demon Copperhead", "Barbara Kingsolver", 2022, 560, 13141227, "m_ben", ["Fiction", "Appalachia"], null),
    b7: bk("r2", "The Wager", "David Grann", 2023, 432, 13245246, "m_cleo", ["Nonfiction", "Shipwreck"], 9),
    b8: bk("r2", "Klara and the Sun", "Kazuo Ishiguro", 2021, 334, 10648686, "m_dev", ["Fiction"], null),
  };
  const votes = {
    r1_m_ava: { roundId: "r1", voterId: "m_ava", scores: { b2: 6, b3: 9, b4: 8 }, updatedAt: t },
    r1_m_ben: { roundId: "r1", voterId: "m_ben", scores: { b1: 7, b3: 8, b4: 5 }, updatedAt: t },
    r1_m_cleo: { roundId: "r1", voterId: "m_cleo", scores: { b1: 8, b2: 4, b4: 6 }, updatedAt: t },
    r1_m_dev: { roundId: "r1", voterId: "m_dev", scores: { b1: 6, b2: 7, b3: 9 }, updatedAt: t },
    r2_m_ava: { roundId: "r2", voterId: "m_ava", scores: { b6: 5, b7: 9, b8: 7 }, updatedAt: t },
    r2_m_ben: { roundId: "r2", voterId: "m_ben", scores: { b5: 8, b7: 8, b8: 6 }, updatedAt: t },
  };
  return { settings: { name: "Example Book Club", members, booksPerMember: 2 }, rounds, books, votes };
}
