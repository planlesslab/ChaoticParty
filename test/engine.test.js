import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { apply, needsTick, view, NO_CHANGE, DELETE_ROOM } from '../js/engine.js';
import { deal } from '../js/dealer.js';
import config from '../js/config.js';

const { challenges } = JSON.parse(readFileSync(new URL('../challenges.json', import.meta.url)));
const byId = new Map(challenges.map((c) => [c.id, c]));

// Simulates the database: every action goes through apply() like a transaction,
// and JSON round-trips like Firebase would.
function game(pool = challenges, roundsPerGame = 10) {
  const g = {
    t: 1_000_000,
    room: null,
    cfg: { ...config, roundsPerGame },
    ctx(uid) { return { uid, now: g.t, config: g.cfg, challenges: pool, challengeById: (id) => byId.get(id) }; },
    act(uid, type, extra = {}) {
      const res = apply(g.room, { type, ...extra }, g.ctx(uid));
      if (res === NO_CHANGE) return false;
      g.room = res === DELETE_ROOM ? null : JSON.parse(JSON.stringify(res));
      return true;
    },
    advance(ms) {
      const end = g.t + ms;
      // phones tick every 250 ms
      while (g.t < end) { g.t = Math.min(end, g.t + 250); g.act('ticker', 'tick'); }
    },
    score() { return Object.fromEntries(Object.entries(g.room.players).map(([k, p]) => [k, p.score])); },
    get round() { return g.room.round; },
  };
  return g;
}

function setup(category, groupSize = 1, players = 3) {
  const pool = challenges.filter((c) => c.category === category && (c.groupSize || 1) === groupSize);
  const g = game(pool, 2);
  g.act('u0', 'create', { code: 'TEST', name: 'P0' });
  for (let i = 1; i < players; i++) g.act('u' + i, 'join', { name: 'P' + i });
  g.act('u0', 'start');
  g.advance(config.getReadyMs);
  return g;
}

test('dealer: 10 unique, playable, no 3-in-a-row category', () => {
  for (let i = 0; i < 200; i++) {
    const { deck } = deal(challenges, { playerCount: 3, rounds: 10 });
    assert.equal(new Set(deck.map((c) => c.id)).size, 10);
    for (let j = 2; j < deck.length; j++) assert.ok(!(deck[j].category === deck[j - 1].category && deck[j].category === deck[j - 2].category));
  }
});

test('dealer: play again avoids used challenges until exhausted', () => {
  let used = [];
  const seen = new Set();
  for (let n = 0; n < 10; n++) {
    const r = deal(challenges, { playerCount: 3, rounds: 10, usedIds: used });
    r.deck.forEach((c) => { assert.ok(!seen.has(c.id)); seen.add(c.id); });
    used = r.usedIds;
  }
  assert.equal(seen.size, 100);
});

test('lobby: create, names, rejoin, start needs 3', () => {
  const g = game();
  g.act('a', 'create', { code: 'ABCD', name: 'Ana' });
  assert.throws(() => g.act('x', 'create', { code: 'ABCD', name: 'X' }), /taken/);
  assert.throws(() => g.act('b', 'join', { name: 'ana' }), /taken/);
  assert.throws(() => g.act('b', 'join', { name: 'ThisNameIsWayTooLong' }), /12/);
  g.act('b', 'join', { name: 'Ben' });
  g.act('b', 'join', { name: 'Ben' }); // rejoin is fine
  assert.throws(() => g.act('a', 'start'), /3\+/);
  g.act('c', 'join', { name: 'Cal' });
  assert.throws(() => g.act('c', 'start'), /host/);
  g.act('a', 'start');
  assert.throws(() => g.act('d', 'join', { name: 'Dee' }), /started/);
  assert.throws(() => g.act('b', 'done'), /Get ready/);
});

test('FIND: 3/2/1/0 by order, ends when all done', () => {
  const g = setup('FIND', 1, 4);
  ['u0', 'u1', 'u2', 'u3'].forEach((u) => g.act(u, 'done'));
  assert.equal(g.room.phase, 'results');
  assert.deepEqual(g.score(), { u0: 3, u1: 2, u2: 1, u3: 0 });
});

test('TOUCH: timeout ends round, finishers keep points', () => {
  const g = setup('TOUCH');
  g.act('u1', 'done');
  g.advance(config.roundMs);
  assert.equal(g.round.endReason, 'timeout');
  assert.deepEqual(g.score(), { u0: 0, u1: 3, u2: 0 });
});

test('cannot finish after the deadline even before a tick', () => {
  const g = setup('FIND');
  g.t += config.roundMs;
  assert.throws(() => g.act('u0', 'done'), /Time/);
});

test('skip: swaps in a new challenge for the same round, nobody scores', () => {
  const g = game(challenges, 10);
  g.act('u0', 'create', { code: 'TEST', name: 'P0' });
  g.act('u1', 'join', { name: 'P1' });
  g.act('u2', 'join', { name: 'P2' });
  g.act('u0', 'start');
  g.advance(config.getReadyMs);
  const before = g.round.challengeId;
  if (g.round.category !== 'SAY' && g.round.groupSize === 1) g.act('u1', 'done');
  assert.throws(() => g.act('u1', 'skip'), /host/);
  g.act('u0', 'skip');
  assert.equal(g.room.phase, 'round');
  assert.equal(g.room.roundIndex, 0);
  assert.notEqual(g.round.challengeId, before);
  assert.equal(g.room.deck[0], g.round.challengeId);
  assert.equal(new Set(g.room.deck).size, 10);
  assert.ok(g.room.usedIds.includes(g.round.challengeId));
  assert.ok(g.round.startsAt > g.t, 'new get-ready countdown');
  assert.deepEqual(g.score(), { u0: 0, u1: 0, u2: 0 });
});

test('group ACTION: first group gets 3 each, others blocked', () => {
  const g = setup('ACTION', 2, 5);
  assert.throws(() => g.act('u0', 'done'), /partners/);
  assert.throws(() => g.act('u0', 'groupDone', { partnerIds: [] }), /Pick 1 partner/);
  g.act('u2', 'groupDone', { partnerIds: ['u3'] });
  assert.deepEqual(g.score(), { u0: 0, u1: 0, u2: 3, u3: 3, u4: 0 });
  assert.equal(g.round.endReason, 'group_done');
});

test('SAY: first buzz correct = +3', () => {
  const g = setup('SAY');
  g.act('u1', 'buzz');
  assert.throws(() => g.act('u2', 'buzz'), /already answering/);
  g.act('u1', 'sayResult', { correct: true });
  assert.deepEqual(g.score(), { u0: 0, u1: 3, u2: 0 });
});

test('SAY: miss, no double buzz, re-buzz correct = +2', () => {
  const g = setup('SAY');
  g.act('u0', 'buzz');
  g.act('u0', 'sayResult', { correct: false });
  assert.throws(() => g.act('u0', 'buzz'), /someone else/);
  g.act('u1', 'buzz');
  g.act('u1', 'sayResult', { correct: false });
  g.act('u0', 'buzz');
  g.act('u0', 'sayResult', { correct: true });
  assert.deepEqual(g.score(), { u0: 2, u1: 0, u2: 0 });
});

test('SAY: 5s answer timeout counts as missed and reopens buzzing', () => {
  const g = setup('SAY');
  g.act('u0', 'buzz');
  g.advance(config.sayAnswerMs);
  assert.equal(g.round.say.answererId, null);
  assert.equal(g.round.say.lastMiss.timedOut, true);
  g.act('u2', 'buzz');
  g.act('u2', 'sayResult', { correct: true });
  assert.equal(g.score().u2, 2);
});

test('SAY: "Got it" too late is refused', () => {
  const g = setup('SAY');
  g.act('u0', 'buzz');
  g.t += config.sayAnswerMs + 1000; // no tick ran yet
  assert.throws(() => g.act('u0', 'sayResult', { correct: true }), /late/);
});

test('SAY: round timer waits for the current answerer', () => {
  const g = setup('SAY');
  g.advance(config.roundMs - 1000);
  g.act('u0', 'buzz');
  g.advance(1000);
  assert.equal(g.room.phase, 'round');
  assert.throws(() => g.act('u1', 'buzz'), /answering|Time/);
  g.act('u0', 'sayResult', { correct: true });
  assert.equal(g.score().u0, 3);
});

test('SAY: answer timeout after time is up ends the round', () => {
  const g = setup('SAY');
  g.advance(config.roundMs - 1000);
  g.act('u0', 'buzz');
  g.advance(config.sayAnswerMs);
  assert.equal(g.round.endReason, 'timeout');
});

test('SAY: nobody buzzes -> timeout, no points', () => {
  const g = setup('SAY');
  g.advance(config.roundMs);
  assert.equal(g.round.endReason, 'timeout');
  assert.deepEqual(g.score(), { u0: 0, u1: 0, u2: 0 });
});

test('next -> final after last round; play again resets scores', () => {
  const g = setup('FIND');
  ['u0', 'u1', 'u2'].forEach((u) => g.act(u, 'done'));
  g.act('u0', 'next');
  g.advance(config.getReadyMs + config.roundMs);
  g.act('u0', 'next');
  assert.equal(g.room.phase, 'final');
  g.act('u0', 'playAgain');
  assert.deepEqual(g.score(), { u0: 0, u1: 0, u2: 0 });
});

test('host hand-over 15s after host disconnects', () => {
  const g = setup('FIND');
  g.room.players.u0.connected = false;
  g.room.players.u0.disconnectedAt = g.t;
  g.advance(config.hostHandoverMs - 500);
  assert.equal(g.room.hostId, 'u0');
  g.advance(500);
  assert.equal(g.room.hostId, 'u1');
});

test('disconnected players are not waited for', () => {
  const g = setup('FIND');
  g.room.players.u2.connected = false;
  g.act('u0', 'done');
  g.act('u1', 'done');
  assert.equal(g.round.endReason, 'all_done');
});

test('leave: lobby removes player; last one out deletes room', () => {
  const g = game();
  g.act('a', 'create', { code: 'ABCD', name: 'Ana' });
  g.act('b', 'join', { name: 'Ben' });
  g.act('a', 'leave');
  assert.equal(g.room.hostId, 'b');
  g.act('b', 'leave');
  assert.equal(g.room, null);
});

test('tick is a no-op when nothing is due; needsTick agrees', () => {
  const g = setup('FIND');
  assert.equal(needsTick(g.room, g.ctx('x')), false);
  assert.equal(g.act('x', 'tick'), false);
  g.t = g.round.endsAt;
  assert.equal(needsTick(g.room, g.ctx('x')), true);
});

test('view: ready/active phases, ranks and awards', () => {
  const g = setup('FIND');
  let v = view(g.room, 'u1', g.t, { challengeById: (id) => byId.get(id) });
  assert.equal(v.phase, 'active');
  g.act('u1', 'done');
  g.act('u0', 'done');
  g.act('u2', 'done');
  v = view(g.room, 'u1', g.t, { challengeById: (id) => byId.get(id) });
  assert.equal(v.phase, 'results');
  assert.equal(v.players[0].id, 'u1');
  assert.equal(v.players[0].rank, 1);
  assert.deepEqual(v.round.awards.map((a) => a.points), [3, 2, 1]);
  assert.equal(view(g.room, 'stranger', g.t, { challengeById: (id) => byId.get(id) }), null);
});
