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

## Play area (v1)

Designed for a flat: **living room, office and kitchen**. Bathrooms and bedrooms are off limits, and no challenge sends players there.

**Look and feel:** Webringo Games style library (black canvas, Bungee + Figtree, yellow/pink/red). Fonts load from Google Fonts.

**Safety:** walk fast, don't run. Never touch anything hot or sharp. Put things back after each round.

## Running it

Requirements: **Node.js 20 or later**. No other dependencies to install.

```bash
npm start      # run the game
npm test       # run the rules tests
```

Then open `http://localhost:3000` on your computer. For phones on the same Wi-Fi, use your computer's local IP address, e.g. `http://192.168.1.20:3000`.

For a beta link friends can open anywhere, deploy the folder to any free Node.js host (e.g. Render or Railway). No database or accounts are needed. See `TECHNICAL_SPEC.md` → *Hosting*.

## Roadmap

**v1 — Beta (now)**
- Create / join room with a code, 3–10 players
- All four categories, 100 challenges, 10 rounds per game, no repeats
- SAY buzzer with 5-second answer window and re-buzzing
- Group ACTION challenges (2–3 players)
- Host controls: Start, Next, Skip
- Live scores and final leaderboard
- Free hosting, no logins

**v2 — Next**
- Adjustable number of rounds and timer length
- QR code to join
- Team mode
- Choose which categories to include
- Sound effects and vibration

**Later**
- Player-created challenges and custom challenge packs
- Optional accounts, game history, custom domain
- Age modes (kids / family / adults)
- Optional shared "TV screen" view
- Photo proof for FIND challenges
