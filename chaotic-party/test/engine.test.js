import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Room } from '../server/engine.js';
import { deal } from '../server/dealer.js';
import config from '../server/config.js';

const { challenges } = JSON.parse(readFileSync(new URL('../challenges.json', import.meta.url)));

function fakeClock() {
  let t = 1_000_000;
  let timers = [];
  let seq = 0;
  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers.push({ id, at: t + ms, fn }); return id; },
    clearTimer: (id) => { timers = timers.filter((x) => x.id !== id); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = next.at;
        next.fn();
      }
      t = end;
    },
  };
}

function setup(category, groupSize = 1, players = 3) {
  const clock = fakeClock();
  const pool = challenges.filter((c) => c.category === category && (c.groupSize || 1) === groupSize);
  const room = new Room('TEST', pool, { config: { ...config, roundsPerGame: 2 }, clock });
  room.deal = null;
  const ps = [];
  for (let i = 0; i < players; i++) { const p = room.addPlayer('P' + i); room.setConnected(p.id, true); ps.push(p); }
  // Force a single-category deck by giving the dealer only that pool.
  room.start(ps[0].id);
  clock.advance(config.getReadyMs);
  assert.equal(room.phase, 'active');
  return { room, clock, ps };
}

test('dealer: 10 unique, playable, no 3-in-a-row category', () => {
  for (let i = 0; i < 200; i++) {
    const { deck } = deal(challenges, { playerCount: 3, rounds: 10 });
    assert.equal(deck.length, 10);
    assert.equal(new Set(deck.map((c) => c.id)).size, 10);
    for (let j = 2; j < deck.length; j++) {
      assert.ok(!(deck[j].category === deck[j - 1].category && deck[j].category === deck[j - 2].category));
    }
  }
});

test('dealer: play again avoids used challenges until exhausted', () => {
  let used = new Set();
  const seen = new Set();
  for (let g = 0; g < 10; g++) {
    const r = deal(challenges, { playerCount: 3, rounds: 10, usedIds: used });
    r.deck.forEach((c) => { assert.ok(!seen.has(c.id)); seen.add(c.id); });
    used = r.usedIds;
  }
  assert.equal(seen.size, 100);
});

test('lobby: names, limits, start needs 3', () => {
  const room = new Room('TEST', challenges, { clock: fakeClock() });
  const a = room.addPlayer('Ana');
  assert.throws(() => room.addPlayer('ana'), /taken/);
  assert.throws(() => room.addPlayer('ThisNameIsWayTooLong'), /12/);
  room.addPlayer('Ben');
  assert.throws(() => room.start(a.id), /3\+/);
  const c = room.addPlayer('Cal');
  assert.throws(() => room.start(c.id), /host/);
  room.start(a.id);
  assert.throws(() => room.addPlayer('Dee'), /started/);
});

test('FIND: 3/2/1/0 by order, ends when all done', () => {
  const { room, ps } = setup('FIND', 1, 4);
  ps.forEach((p) => room.done(p.id));
  assert.equal(room.phase, 'results');
  assert.deepEqual(ps.map((p) => p.score), [3, 2, 1, 0]);
  assert.throws(() => room.done(ps[0].id));
});

test('TOUCH: timeout ends round, finishers keep points', () => {
  const { room, clock, ps } = setup('TOUCH');
  room.done(ps[1].id);
  clock.advance(config.roundMs);
  assert.equal(room.round.endReason, 'timeout');
  assert.deepEqual(ps.map((p) => p.score), [0, 3, 0]);
});

test('skip: nobody scores', () => {
  const { room, ps } = setup('FIND');
  room.done(ps[1].id);
  assert.throws(() => room.skip(ps[1].id), /host/);
  room.skip(ps[0].id);
  assert.equal(room.round.endReason, 'skipped');
  assert.deepEqual(ps.map((p) => p.score), [0, 0, 0]);
});

test('group ACTION: first group gets 3 each, others blocked', () => {
  const { room, ps } = setup('ACTION', 2, 5);
  assert.throws(() => room.done(ps[0].id), /partners/);
  assert.throws(() => room.groupDone(ps[0].id, []), /Pick 1 partner/);
  room.groupDone(ps[2].id, [ps[3].id]);
  assert.deepEqual(ps.map((p) => p.score), [0, 0, 3, 3, 0]);
  assert.equal(room.round.endReason, 'group_done');
});

test('SAY: first buzz correct = +3', () => {
  const { room, ps } = setup('SAY');
  room.buzz(ps[1].id);
  assert.throws(() => room.buzz(ps[2].id), /already answering/);
  room.sayResult(ps[1].id, true);
  assert.deepEqual(ps.map((p) => p.score), [0, 3, 0]);
});

test('SAY: miss, no double buzz, re-buzz correct = +2', () => {
  const { room, ps } = setup('SAY');
  room.buzz(ps[0].id);
  room.sayResult(ps[0].id, false);
  assert.throws(() => room.buzz(ps[0].id), /someone else/);
  room.buzz(ps[1].id);
  room.sayResult(ps[1].id, false);
  room.buzz(ps[0].id); // allowed again after someone else had a go
  room.sayResult(ps[0].id, true);
  assert.deepEqual(ps.map((p) => p.score), [2, 0, 0]);
});

test('SAY: 5s answer timeout counts as missed and reopens buzzing', () => {
  const { room, clock, ps } = setup('SAY');
  room.buzz(ps[0].id);
  clock.advance(config.sayAnswerMs);
  assert.equal(room.round.say.answererId, null);
  assert.equal(room.round.say.lastMiss.timedOut, true);
  assert.equal(room.phase, 'active');
  room.buzz(ps[2].id);
  room.sayResult(ps[2].id, true);
  assert.equal(ps[2].score, 2);
});

test('SAY: round timer waits for the current answerer', () => {
  const { room, clock, ps } = setup('SAY');
  clock.advance(config.roundMs - 1000);
  room.buzz(ps[0].id);
  clock.advance(1000);
  assert.equal(room.phase, 'active');
  assert.throws(() => room.buzz(ps[1].id));
  room.sayResult(ps[0].id, true);
  assert.equal(ps[0].score, 3);
});

test('SAY: nobody buzzes -> timeout, no points', () => {
  const { room, clock, ps } = setup('SAY');
  clock.advance(config.roundMs);
  assert.equal(room.round.endReason, 'timeout');
  assert.deepEqual(ps.map((p) => p.score), [0, 0, 0]);
});

test('next -> final after last round; play again resets scores', () => {
  const { room, ps } = setup('FIND');
  ps.forEach((p) => room.done(p.id));
  room.next(ps[0].id);
  assert.equal(room.phase, 'ready');
  room.skip(ps[0].id);
  room.next(ps[0].id);
  assert.equal(room.phase, 'final');
  room.playAgain(ps[0].id);
  assert.deepEqual(ps.map((p) => p.score), [0, 0, 0]);
});

test('host hand-over after disconnect', () => {
  const { room, clock, ps } = setup('FIND');
  room.setConnected(ps[0].id, false);
  clock.advance(config.hostHandoverMs);
  assert.equal(room.hostId, ps[1].id);
});

test('disconnected players are not waited for', () => {
  const { room, ps } = setup('FIND');
  room.setConnected(ps[2].id, false);
  room.done(ps[0].id);
  room.done(ps[1].id);
  assert.equal(room.round.endReason, 'all_done');
});
