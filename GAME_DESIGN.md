# Chaotic Party — Game Design (v1)

This document defines the rules, scoring, challenge system and player screens for v1.

## 1. Settings at a glance

| Setting | v1 value | Adjustable later? |
|---|---|---|
| Players per room | 3–10 | Yes |
| Rounds per game | 10 | Yes (v2) |
| Round timer (all categories) | 20 seconds | Yes (v2) |
| SAY answer window | 5 seconds | Yes (v2) |
| Mode | Individual (teams in v2) | Yes |
| Judging | Honour system | — |
| Audience | Family / kids-friendly | Yes (later) |
| Play area | Living room, office, kitchen | — |

## 2. Roles

- **Host**: the player who created the room. The host plays normally and also has three extra buttons:
  - **Start**: begins the game (needs at least 3 players).
  - **Next**: moves from the round results to the next challenge.
  - **Skip**: throws away the current challenge and deals a new one for the same round (with a fresh 3-second countdown). A skipped challenge doesn't count, and nobody scores from it.
- **Player**: everyone else.
- If the host disconnects for more than 15 seconds, host controls pass to the player who joined next earliest.

## 3. Game flow

1. **Create room**: host enters their name and gets a 4-letter room code.
2. **Lobby**: players join with the code and a name. Everyone sees the player list. Names must be unique within the room (1–12 characters).
3. **Start**: host taps Start (enabled at 3+ players; max 10). New players can't join once the game starts, but disconnected players can rejoin.
4. **Rounds 1–10**: each round:
   1. A 3-second "Get ready…" countdown showing the category.
   2. The challenge appears on every phone at the same moment with a 20-second timer.
   3. The round ends (see category rules below).
   4. A **round results** screen shows who scored and the updated leaderboard.
   5. Host taps **Next**.
5. **Final leaderboard**: winner(s) celebrated. Host can tap **Play again** (same players, new challenges not yet used in this room, scores reset).

## 4. Category rules and scoring

### FIND and TOUCH (solo)

- Every player races to complete the challenge and taps **FOUND IT** / **DONE**.
- Points by finishing order: **1st = 3, 2nd = 2, 3rd = 1, everyone else who finishes = 0**.
- The round ends when **every player has tapped**, or the **20-second timer** runs out.
- FIND: hold the object up when you tap. TOUCH: tap while touching it.

### ACTION (solo)

- Same as FIND/TOUCH: tap **COMPLETED**, scored **3 / 2 / 1 / 0** by finishing order.
- Ends when everyone has tapped or after 20 seconds.

### ACTION (group of 2 or 3)

- The challenge says how many people are needed, e.g. "👥 2 players".
- When a group finishes, **one member** taps **COMPLETED**, then picks their partner(s) from the player list (exactly 1 partner for a 2-person action, 2 partners for a 3-person action) and taps **Confirm**.
- **Only the first group scores**: each member gets **3 points**. The round then ends immediately.
- If two members of the same group tap at once, the first confirmed submission counts. The other player sees "Already claimed by Sam's group".
- Players who can't form a group (e.g. the 5th player in a 2-person action) score 0. That's part of the chaos.
- If nobody completes it in 20 seconds, the round ends with no points.
- Group actions are only dealt when the room has enough players (a 3-person action needs at least 3 players, which v1 always has).

### SAY (buzz in)

1. Everyone sees the question and a big **BUZZ IN** button. The 20-second round timer starts.
2. The first player to buzz (as received by the server) becomes the **answerer**. Everyone else's buzz button is disabled and shows "Sam is answering…".
3. The answerer sees a big **5-second countdown** and a single **COMPLETED** button. They say the answer out loud and tap COMPLETED.
   - If 5 seconds pass with no tap, the button disappears and it counts as **Missed**.
4. **COMPLETED** ends the round:
   - **+3** if it was the **first buzz** of the round.
   - **+2** if it came from a **re-buzz** (any buzz after a miss).
5. A **miss** (time ran out) reopens buzzing for everyone, **except the player who just missed** (no buzzing twice in a row). They can buzz again after someone else has had a turn.
6. If the 20-second timer runs out while nobody is answering, the round ends with no points. If it runs out **during** an answer window, that answerer still gets their full 5 seconds.

### Scoring summary

| Situation | Points |
|---|---:|
| FIND / TOUCH / solo ACTION: 1st | 3 |
| FIND / TOUCH / solo ACTION: 2nd | 2 |
| FIND / TOUCH / solo ACTION: 3rd | 1 |
| FIND / TOUCH / solo ACTION: 4th or later | 0 |
| Group ACTION: first group to finish | 3 each |
| Group ACTION: any later group | 0 |
| SAY: correct on the first buzz | 3 |
| SAY: correct on a re-buzz | 2 |
| SAY: missed / timed out | 0 |
| Challenge skipped by host | Replaced with a new challenge; 0 for everyone |

### Ranking and ties

- The leaderboard is sorted by total points.
- Tied players share the same position (e.g. two players on "1st"). The final screen shows joint winners.

## 5. Challenge system

- All challenges live in `challenges.json`: **25 per category, 100 in total**.
- **Dealing a game:** shuffle the whole pool (Fisher–Yates), drop any challenge the room can't do (not enough players for a group action), and take the first 10.
- **No repeats:** a challenge never appears twice in one game. With **Play again**, the room avoids challenges it has already played until the pool runs out, then reshuffles everything.
- **Variety:** the dealer avoids putting the same category 3 times in a row. It swaps in the next eligible challenge of a different category.
- Every challenge is family-friendly and only uses the living room, office or kitchen.
- If an object in a challenge doesn't exist in your home, the host taps **Skip** and a new challenge is dealt for the same round.
- A challenge can have an optional `link` (e.g. a video showing a pose). It appears as a **▶ Watch how** button.

## 6. Player screens

Visual style: **Neon Glass**. Deep indigo-to-violet night background with slowly drifting light, frosted ribbed-glass panels with glowing edges, glass buttons lit in neon colours. Unbounded display type with a gradient CHAOTIC PARTY wordmark, Figtree body text.

Design principles: one big button per screen, readable from arm's length, works one-handed, high contrast. Each category has its own colour from the palette.

| Category | Colour | Icon | Button |
|---|---|---|---|
| ACTION | Neon pink `#ff5cc8` | 🤸 | COMPLETED |
| SAY | Neon yellow `#ffd34d` | 🗣️ | BUZZ IN |
| FIND | Electric blue `#4f8bff` | 🔍 | FOUND IT |
| TOUCH | Mint `#3ff2b8` | ✋ | DONE |

### 6.1 Home

- Game title and one-line description.
- **Create room** and **Join room** buttons.

### 6.2 Create / Join

- Name field (1–12 characters).
- Join also has a 4-letter room code field (auto-uppercase).
- Errors: "Room not found", "Room is full (10 players)", "Game already started", "Name already taken".

### 6.3 Lobby

- Big room code at the top ("Tell your friends: **KBZW**"), a **Share invite link** button and the link itself (tap to copy).
- Invite links open straight onto "You're joining room KBZW", so friends only type their name.
- Player list with a 👑 next to the host.
- Host: **Start** button (disabled with "Need 3+ players" until there are 3).
- Others: "Waiting for host to start…".

### 6.4 Get ready (3 seconds)

- Round "3 / 10", category name, icon and colour, countdown 3-2-1.

### 6.5 Challenge active

Top bar: round progress (3 / 10), timer, my score.
Middle: category badge, challenge text in large type, group size for group actions ("👥 2 players").
Bottom: the big action button. Host also sees a small **Skip** link.

Status shown under the button:

| Status | Shown when |
|---|---|
| Challenge active | Round running, you haven't finished |
| Completed: 2nd! +2 | You tapped (FIND/TOUCH/ACTION) |
| Too slow — no points this time | You finished after 3rd place |
| Pick your partner(s) | Group action, after tapping COMPLETED |

Live strip: "Ana ✔ · Ben ✔ · 6 still going".

### 6.6 SAY states

| Your state | Screen |
|---|---|
| Can buzz | Big purple **BUZZ IN** |
| Someone else answering | Button disabled: "Ben is answering… 4s" |
| You're answering | "Say it out loud!" + big 5-4-3-2-1 countdown + **COMPLETED** |
| You just missed | Button disabled: "Wait for someone else to have a go" |
| Answer window expired | "⏰ Missed!" (1 second), then buzzing reopens |

### 6.7 Round results

- Correct/finished players with points earned this round (+3, +2, +1).
- Mini leaderboard with position changes (▲▼).
- Host: **Next** button (or **See final results** after round 10). Others: "Waiting for host…".

### 6.8 Final leaderboard

- Podium for the top 3, then the full list.
- Host: **Play again**. Everyone: **Leave**.

### 6.9 Connection

- If the connection drops: "Reconnecting…" banner. The game state is restored automatically on reconnect.
- Refreshing the page puts you back in the same room with the same score.
