# Chaotic Party — Technical Spec (v1)

## 1. Goals

- Works in any modern mobile browser (iOS Safari, Android Chrome). No app install, no logins.
- Real-time sync for up to 10 players per room, with fair "who pressed first".
- Free, always-on hosting: **GitHub Pages** (the website) + **Firebase Realtime Database** (live data).
- Easy to grow later (accounts, history, custom domain, teams).

## 2. Architecture

```
 Phone (browser, static site from GitHub Pages)
   │  reads & writes /rooms/{CODE} through Firebase transactions
   ▼
 Firebase Realtime Database  ──pushes every change──▶  all phones in the room
```

- **No game server.** Each room is one JSON document at `/rooms/{CODE}`.
- **Every change is a transaction.** A phone runs the rules engine (`js/engine.js`) inside a Firebase transaction. Firebase applies transactions one at a time and re-runs any that raced, so when two players buzz at once, exactly one wins. The first to reach the database is first.
- **Timers without a server.** Deadlines are stored as timestamps (`startsAt`, `endsAt`, `answerEndsAt`) on the database's clock (`.info/serverTimeOffset`). Every phone checks the clock about 6 times a second. When a deadline passes, any phone runs a `tick` transaction to end the round or close the answer window. `tick` is idempotent, so it doesn't matter which phone does it or whether several try.
- **"Get ready → go"** is derived from `startsAt`, so all phones flip at the same moment without a write.
- **Presence.** Each phone marks itself `connected: true` and registers an `onDisconnect` that sets `connected: false` and `disconnectedAt`. Rounds don't wait for disconnected players. If the host is gone for 15 s, `tick` hands host controls to the next player.
- **Identity.** Firebase **anonymous auth** gives each phone a stable `uid`, which is the player's key. Refreshing the page rejoins the same seat.

## 3. Files

```
index.html            page shell (fonts, styles, loads js/app.js)
styles.css            Webringo Games style library
img/mascot.png
challenges.json       100 challenges
js/config.js          tunable numbers (timers, points, limits)
js/dealer.js          shuffle + no-repeat + variety rule
js/engine.js          rules: apply(room, action) / tick / view  (pure JS, unit-tested)
js/app.js             screens, buttons, transactions, heartbeat
js/backend-firebase.js  Firebase SDK (loaded from Google's CDN, v12)
js/backend-mock.js    offline stand-in for testing (?mock=1)
js/firebase-config.js project config (public by design)
database.rules.json   Realtime Database security rules
test/engine.test.js   node --test
```

## 4. Data model (`/rooms/{CODE}`)

```js
{
  code: "KBZW", createdAt, lastActivityAt,
  hostId: "<uid>",
  phase: "lobby" | "round" | "results" | "final",
  roundIndex: 0..9,
  deck: ["say-07", ...],          // this game's 10 challenge ids
  usedIds: [...],                 // played in this room (for Play again)
  prevRanks: { uid: rank },       // for ▲▼ on results
  players: {
    "<uid>": { name, score, joinedAt, connected, disconnectedAt, left }
  },
  round: {
    challengeId, category, groupSize,
    startsAt, endsAt, timeUp,
    finishers: { uid: { at, place, points } },        // FIND / TOUCH / solo ACTION
    group: { memberIds: [uid...], at, points } | null, // group ACTION
    say: { answererId, answerEndsAt, lastMissedId, attempts, lastMiss, winner },
    awards: { uid: { points, label } },
    ended, endReason: "all_done" | "timeout" | "correct" | "group_done" | "skipped"
  }
}
```

## 5. Actions

`create`, `join`, `leave`, `start`, `next`, `skip`, `playAgain` (host only where noted in GAME_DESIGN), `done`, `groupDone {partnerIds}`, `buzz`, `sayResult {correct}`, `tick`.
Each is validated by `engine.apply()`. If a rule says no (e.g. buzzing while someone is answering), the transaction is aborted and the player sees a short message.

## 6. Security rules

`database.rules.json`: only signed-in (anonymous) users can read or write, and only under `/rooms/{4-letter code}`. Game logic runs on phones, so a determined player could cheat. That's acceptable for an honour-system party game. Moving rule enforcement into Cloud Functions later would close this gap (it needs Firebase's pay-as-you-go plan).

## 7. Limits and costs

Firebase's free (Spark) plan covers this comfortably: a room is a few KB, and a game is a few hundred small writes. Old rooms stay in the database. Clean-up is on the roadmap; until then you can delete `/rooms` in the console at any time.

## 8. Testing

- `npm test`: 21 rule tests (scoring, SAY re-buzz/timeout, group claims, skip, timers, host hand-over, dealer).
- `?mock=1`: full multiplayer in several tabs of one browser, no Firebase needed.
