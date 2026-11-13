// Deals a game's challenges: shuffled, no repeats, playable by this room,
// and never the same category three times in a row.

export function shuffle(list, random = Math.random) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * @returns {{ deck: object[], usedIds: Set<string> }} the dealt challenges and
 *          the room's updated "already played" set.
 */
export function deal(challenges, { playerCount, rounds, usedIds = new Set(), random = Math.random }) {
  const eligible = challenges.filter((c) => (c.groupSize || 1) <= playerCount);
  let used = new Set(usedIds);
  let pool = eligible.filter((c) => !used.has(c.id));
  if (pool.length < rounds) {
    // Pool exhausted by "Play again": start over with everything.
    used = new Set();
    pool = eligible;
  }

  const remaining = shuffle(pool, random);
  const deck = [];
  while (deck.length < rounds && remaining.length) {
    const n = deck.length;
    const blocked = n >= 2 && deck[n - 1].category === deck[n - 2].category ? deck[n - 1].category : null;
    let idx = remaining.findIndex((c) => c.category !== blocked);
    if (idx === -1) idx = 0; // nothing else left: allow it
    deck.push(remaining.splice(idx, 1)[0]);
  }
  deck.forEach((c) => used.add(c.id));
  return { deck, usedIds: used };
}
