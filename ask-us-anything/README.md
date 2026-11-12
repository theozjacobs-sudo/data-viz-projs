# Ask Us Anything short list

A single-page list of listener questions for the Freakonomics Radio "Ask Us Anything" episode.
Live at `https://theozjacobs-sudo.github.io/data-viz-projs/ask-us-anything/`.

- `index.html` is the whole site: questions, listener emails, the agreement map, picks and notes.
- Picks and notes are saved to the "Site picks" and "Site notes" tabs of the Ask Us Anything Tracker
  Google Sheet through the Apps Script web app in `apps-script/Code.gs` (bound to that sheet,
  deployed as a web app that runs as the sheet owner and is open to anyone with its URL).
- The web app URL is the `API` constant near the bottom of `index.html`. If it is empty, picks and
  notes stay in each person's own browser.
- No sign-in. Each person picks their name once per device.

The page is unlisted (`noindex`) but not private: anyone with the link can read it and add picks or notes.
