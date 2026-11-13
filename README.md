# Chaotic Party

> **Race your friends to find, touch, say and do silly real-world challenges — all from your phone.**

Chaotic Party is a mobile-first web game for 3–10 players in the same home. Everyone joins a room on their own phone, gets the same random challenge at the same moment, and races to complete it. Fast rounds, simple buttons, lots of laughing.

## How a game works

1. One player creates a room and gets a 4-letter room code. That player is the **host** (they play too).
2. Everyone else opens the game link, enters the code and their name.
3. The host taps **Start**. The game deals **10 random challenges** — no repeats.
4. Each round is one of four categories:

| Category | What you do | Button |
|---|---|---|
| **ACTION** | Do a pose or movement (some need 2–3 people) | COMPLETED |
| **SAY** | Buzz in and answer out loud | BUZZ IN |
| **FIND** | Find an object and hold it up | FOUND IT |
| **TOUCH** | Go and touch something | DONE |

5. Points are added up after each round. After round 10, the final leaderboard crowns the winner.

The game runs on the **honour system** — whoever presses the button first wins. No referees, no arguments (well, fewer).

Full rules are in [`GAME_DESIGN.md`](GAME_DESIGN.md). The architecture is in [`TECHNICAL_SPEC.md`](TECHNICAL_SPEC.md). All challenges live in [`challenges.json`](challenges.json).

Game settings (timers, points, player limits) are in [`js/config.js`](js/config.js).

## Play area (v1)

Designed for a flat: **living room, office and kitchen**. Bathrooms and bedrooms are off limits, and no challenge sends players there.

**Look and feel:** Webringo Games style library (black canvas, Bungee + Figtree, yellow/pink/red). Fonts load from Google Fonts.

**Safety:** walk fast, don't run. Never touch anything hot or sharp. Put things back after each round.

## Running it

The game is a static website (GitHub Pages) plus a Firebase Realtime Database for live sync. There is no server to run and nothing sleeps.

### One-time setup

1. **Firebase** (project `chaotic-party`, already created):
   - Realtime Database created (europe-west1).
   - Security → Authentication → Sign-in method → **Anonymous** enabled.
   - Security → Authentication → Settings → **Authorized domains** → add `YOURUSERNAME.github.io`.
   - Realtime Database → **Rules** tab → paste the contents of [`database.rules.json`](database.rules.json) → **Publish**.
2. **GitHub Pages**:
   - Upload every file in this folder to the repo (keep the folder structure: `js/`, `img/`, `test/`).
   - Repo → **Settings → Pages** → Source: **Deploy from a branch** → Branch: **main**, folder **/ (root)** → **Save**.
   - After a minute the game is live at `https://YOURUSERNAME.github.io/REPO-NAME/`.

### Playing

Open the link on every phone. Create a room, tap **Share invite link**, start when 3+ players are in.

### Testing locally

```bash
npm test                          # rules tests (Node 20+)
python3 -m http.server 8000       # then open http://localhost:8000/?mock=1
```

`?mock=1` uses an offline stand-in for Firebase, so several tabs in one browser can play together without touching the real database.

## Roadmap

**v1 — Beta (now)**
- Create / join room with a code, 3–10 players
- All four categories, 100 challenges, 10 rounds per game, no repeats
- SAY buzzer with 5-second answer window and re-buzzing
- Group ACTION challenges (2–3 players)
- Host controls: Start, Next, Skip
- Live scores and final leaderboard
- GitHub Pages + Firebase: free, always on, no logins

**v2 — Next**
- Adjustable number of rounds and timer length
- QR code to join
- Automatic clean-up of old rooms (a scheduled Firebase function)
- Team mode
- Choose which categories to include
- Sound effects and vibration

**Later**
- Player-created challenges and custom challenge packs
- Optional accounts, game history, custom domain
- Age modes (kids / family / adults)
- Optional shared "TV screen" view
- Photo proof for FIND challenges
