# Chaotic Party — Technical Spec (v1)

## 1. Goals

- Works in any modern mobile browser (iOS Safari, Android Chrome). No app install.
- Real-time sync for up to 10 players per room; fair "who pressed first" ordering.
- Free to host, no accounts, no database for v1.
- Easy to grow later (accounts, database, custom domain, teams) without a rewrite.

## 2. Architecture

```
 Phone (browser)  ──HTTP POST /api/action──▶  Node.js server  (single process)
 Phone (browser)  ◀──Server-Sent Events────   ├─ in-memory rooms
 ...up to 10 per room                         ├─ game engine (rules, timers, scoring)
                                              └─ challenges.json (loaded at start-up)
```

- **Server-authoritative:** the server owns all game state, timers and scoring. Phones only send intents ("buzz", "done") and render the state they receive.
- **Fairness:** "first" means first to **arrive at the server**. On the same Wi-Fi the difference between phones is a few milliseconds.
- **Transport:**
  - Client → server: `POST /api/action` with JSON.
  - Server → client: **Server-Sent Events** (`GET /api/events`), a long-lived HTTP stream.
  - Why SSE rather than WebSockets? It's built into every browser and needs **zero npm dependencies** on the server. It reconnects automatically and works on free hosts. If needed, it can be swapped for WebSockets later behind the same message format.
- **Timers:** the server sends absolute deadlines (`endsAt`, epoch ms) and its current time. Clients compute a clock offset and render the countdowns locally. The server decides when a timer has really expired.

## 3. Tech stack

| Part | Choice |
|---|---|
| Server | Node.js 20+, built-in `http` module, no frameworks |
| Client | Plain HTML + CSS + JavaScript (ES modules), no build step |
| Data | `challenges.json` (static), rooms in memory |
| Tests | Node built-in test runner (`node --test`) for the game engine |

Keeping it dependency-free makes v1 simple to run, deploy and change. A framework (e.g. React) can be introduced later if the UI grows.

## 4. Project structure

```
chaotic-party/
├── README.md
├── GAME_DESIGN.md
├── TECHNICAL_SPEC.md
├── challenges.json
├── package.json            # "start": "node server/index.js"
├── server/
│   ├── index.js            # HTTP server, static files, routes, SSE
│   ├── rooms.js            # create/join/leave, reconnects, host hand-over
│   ├── engine.js           # round state machine, timers, scoring (pure logic)
│   ├── dealer.js           # shuffle + filtering + no-repeat + variety rule
│   └── config.js           # tunable numbers (timers, points, limits)
├── public/
│   ├── index.html
│   ├── styles.css
│   └── app.js              # screens, SSE client, button handlers
└── test/
    └── engine.test.js
```

## 5. Data model

### Room

```js
{
  code: "KBZW",               // 4 letters, no I/O/0/1 lookalikes
  hostId: "p_8f2c",
  phase: "lobby" | "ready" | "active" | "results" | "final",
  players: Map<playerId, Player>,
  joinOrder: [playerId],      // used for host hand-over
  deck: [challengeId],        // the 10 dealt for this game
  usedIds: Set<challengeId>,  // played in this room (for Play again)
  roundIndex: 0..9,
  round: Round | null,
  createdAt, lastActivityAt
}
```

### Player

```js
{
  id: "p_8f2c",
  token: "secret-random-32",  // stored in localStorage, used to reconnect
  name: "Ana",
  score: 0,
  connected: true,
  joinedAt
}
```

### Round

```js
{
  challengeId: "say-07",
  category: "ACTION" | "SAY" | "FIND" | "TOUCH",
  groupSize: 1 | 2 | 3,
  startsAt, endsAt,            // epoch ms
  finishers: [{ playerId, at, points }],          // FIND/TOUCH/solo ACTION
  group: { memberIds: [], at } | null,            // group ACTION
  say: {
    answererId: null,
    answerEndsAt: null,
    lastMissedId: null,
    attempts: 0               // 0 = next correct answer is +3, otherwise +2
  },
  ended: false,
  endReason: "all_done" | "timeout" | "correct" | "group_done" | "skipped"
}
```

### Challenge (`challenges.json`)

```json
{
  "id": "action-02",
  "category": "ACTION",
  "text": "Make a heart shape with your hands together with another player.",
  "groupSize": 2,
  "image": null
}
```

- `groupSize`: ACTION only, 1–3 (defaults to 1).
- `image`: optional path to a picture or diagram in `public/img/` (none in v1).

## 6. API

### HTTP

| Method & path | Body | Returns |
|---|---|---|
| `POST /api/rooms` | `{ name }` | `{ code, playerId, token }` |
| `POST /api/rooms/:code/join` | `{ name }` | `{ playerId, token }` or error |
| `GET /api/events?code=&token=` | — | SSE stream |
| `POST /api/action` | `{ code, token, type, ...data }` | `{ ok: true }` or `{ ok: false, error }` |

### Action types (client → server)

| type | Who | Data |
|---|---|---|
| `start` | host | — |
| `next` | host | — |
| `skip` | host | — |
| `playAgain` | host | — |
| `done` | any | — (FIND / TOUCH / solo ACTION) |
| `groupDone` | any | `{ partnerIds: [...] }` |
| `buzz` | any | — |
| `sayResult` | answerer | `{ correct: true \| false }` |
| `leave` | any | — |

### Events (server → client)

One event type, `state`, carrying the full room snapshot from that player's point of view (≈1–2 KB):

```js
{
  serverNow, me: { id, isHost },
  phase, code, roundIndex, totalRounds,
  players: [{ id, name, score, connected, isHost }],
  round: { challenge, startsAt, endsAt, finishers, group, say, ended, endReason, pointsThisRound }
}
```

Sending the whole snapshot (instead of small diffs) keeps clients simple and makes reconnects automatic. At 10 players this is tiny.

## 7. Engine rules (server)

- All actions are validated against the current phase and the player's state. Invalid actions are ignored with an error (e.g. buzzing while someone is answering).
- Actions are processed **one at a time in arrival order** (Node's single thread guarantees this). That's what makes "first" fair.
- **FIND/TOUCH/solo ACTION:** append to `finishers` once per player. Points come from `config.points.placing = [3, 2, 1]`. End when `finishers.length === connected players` or at `endsAt`.
- **Group ACTION:** validate that `partnerIds.length === groupSize - 1`, the partners exist, and there are no duplicates. The first valid claim wins and the round ends.
- **SAY:** see GAME_DESIGN §4. Answer timeout is a server timer (5 s). The round timer may expire during an answer, and the engine waits for that answer to resolve.
- **Disconnected players** are not counted in "everyone has finished".
- **Skip:** ends the round with `endReason: "skipped"` and awards no points.

## 8. Rooms, connections and clean-up

- Room codes: 4 random letters from `ABCDEFGHJKLMNPQRSTUVWXYZ`, checked for clashes.
- The player `token` is saved in `localStorage` so a refresh or a dropped connection rejoins the same seat.
- SSE heartbeat comment every 15 s keeps proxies from closing the stream.
- A player counts as disconnected when their stream closes. Host hand-over happens after 15 s disconnected.
- Rooms with no connected players for 30 minutes, or older than 6 hours, are deleted.
- Limits: 10 players per room; names 1–12 characters, trimmed, HTML-escaped on render; simple per-IP rate limit on room creation.

## 9. Config (`server/config.js`)

```js
export default {
  minPlayers: 3,
  maxPlayers: 10,
  roundsPerGame: 10,
  getReadyMs: 3000,
  roundMs: 20000,
  sayAnswerMs: 5000,
  points: { placing: [3, 2, 1], group: 3, sayFirst: 3, sayRebuzz: 2 },
  hostHandoverMs: 15000,
};
```

Every number from GAME_DESIGN lives here, so making things adjustable in v2 means exposing these in the lobby.

## 10. Hosting

- **Local:** `npm start` → `http://<computer-ip>:3000` for phones on the same Wi-Fi.
- **Beta:** any free Node.js host (e.g. Render, Railway, Fly.io). The service must run as **one instance**, because rooms live in memory. Free tiers often sleep when idle, so the first visit may take a little while to wake up.
- **Later:** to grow past one instance, move room state to Redis (or similar) with pub/sub. Accounts and game history would add a database (e.g. Postgres). A custom domain is a DNS change. None of this changes the client protocol.

## 11. Testing

- Unit tests for `engine.js` and `dealer.js`: scoring order, SAY re-buzz rules, group claims, timeouts, skip, no-repeat dealing, variety rule.
- Manual multi-player test: several browser tabs or phones on the same Wi-Fi.
