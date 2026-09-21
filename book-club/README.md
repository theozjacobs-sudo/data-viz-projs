# Book Club Ballot

A small web app for picking book club books without settling for the lowest common denominator.

- Everyone submits two books (typed in, looked up on Open Library, real cover pulled).
- Everyone rates everyone else's books: excitement on a 1–10 slider, or a plain yes/no, chosen per round.
- Submissions are anonymous until the results are revealed (per-round setting, on by default), so people vote on the book, not the friend.
- Already read a book someone submitted? Tap "Already read it" and you sit that one out; it doesn't drag the average.
- Submitters rate their own book too, but that only breaks ties.
- Reveal the results: ranked list, most and least exciting, most divisive. Tap books to mark the ones you'll actually read.
- The Shelf keeps every round and every book ever put forward. Stats tracks the club over time, including who has the best taste and who is the softest grader.

No accounts. Anyone with the link can use it, on a phone or a laptop. Free to host.

## How it's hosted

- **Pages**: static files, served by GitHub Pages from this repo.
- **Data**: Firebase Firestore (free Spark plan), so everyone sees the same live data.
- **Book lookup**: Open Library search and covers API. No key needed.

Until Firebase is configured the app runs in **demo mode**: it works, but data stays in your own browser and there's a yellow banner saying so.

## One-time setup (about 10 minutes)

### 1. Turn on GitHub Pages

1. In this repo on GitHub: **Settings → Pages**.
2. Under **Build and deployment**, set Source to **Deploy from a branch**, pick the branch this folder lives on, folder **/ (root)**, and save.
3. After a minute the app is at `https://theozjacobs-sudo.github.io/data-viz-projs/book-club/`.

### 2. Create the shared database

1. Go to <https://console.firebase.google.com>, **Add project**, name it anything (e.g. `book-club`). You can turn off Google Analytics.
2. In the project: **Build → Firestore Database → Create database**. Pick a region near you. Choose **Start in production mode**.
3. Open the **Rules** tab, replace everything with the contents of [`firestore.rules`](firestore.rules) in this folder, and **Publish**.
4. Back on the project overview, click the **`</>`** (web) icon to add a web app. Name it anything, skip hosting, and copy the `firebaseConfig` object it shows.

### 3. Paste the config

Edit [`firebase-config.js`](firebase-config.js) and replace the placeholder values with the ones from step 2.4. Commit and push. That's it.

The config is safe to commit: it only identifies the project. Access is governed by the rules, which let anyone with the link read and write the club's data. That's intended (friends, no logins), so treat the link as semi-private.

## Using it

- **Voting as**: tap the name chip at the top, pick yourself or add your name. It's remembered on that device.
- **Start a round**: choose 1–10 or yes/no and how many books each person submits.
- **Submit**: search, tap the right edition. If Open Library doesn't have it, add it by hand.
- **Close submissions, open voting**: anyone in the club can move the round along. People can change votes until results are revealed.
- **Close voting & reveal**: ranks the books. The top book is marked as the pick; tap other books to add or remove picks (useful when you're choosing two).
- **Shelf** and **Stats** are always on.

Ranking: average of the other members' scores. Ties go to whichever submitter was more excited about their own book, then to the book with more votes.

## Files

| File | What |
| --- | --- |
| `index.html`, `styles.css` | Page and design |
| `app.js` | All the app logic (no framework, no build step) |
| `store.js` | Firestore adapter plus a local demo adapter with the same interface |
| `lookup.js` | Open Library search |
| `firebase-config.js` | Your Firebase project config (placeholders until you set it up) |
| `firestore.rules` | Security rules to paste into Firebase |

To run locally: `python3 -m http.server 8000` in this folder, then open <http://localhost:8000>. (It has to be served over HTTP because the JavaScript uses modules.)
