// Chaotic Party rules engine.
//
// There is no game server: the whole room lives at /rooms/{code} in Firebase,
// and every change is made by running `apply()` inside a database transaction.
// Transactions are applied one at a time by Firebase, so "who buzzed first" is
// decided fairly by the database. Timers are enforced by `tick`, which any phone
// may run once a deadline has passed (it's idempotent).
//
// This file is pure JavaScript with no browser or Firebase code, so it can be
// unit-tested with Node.

import defaultConfig from './config.js?v=0.3.0';
import { deal } from './dealer.js?v=0.3.0';

export class GameError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

export const NO_CHANGE = Symbol('no-change');
export const DELETE_ROOM = Symbol('delete-room');

const SAY_GRACE_MS = 400; // allow for network delay on a last-moment "Got it"

const clone = (x) => JSON.parse(JSON.stringify(x));

/** Fill in defaults: Firebase drops empty objects/nulls and may return arrays as objects. */
export function normalize(raw) {
  if (!raw) return null;
  const r = clone(raw);
  r.players = r.players || {};
  // Ignore stray presence-only records (no name) left by a dropped connection.
  Object.keys(r.players).forEach((id) => { if (!r.players[id] || !r.players[id].name) delete r.players[id]; });
  r.deck = r.deck ? Object.values(r.deck) : [];
  r.usedIds = r.usedIds ? Object.values(r.usedIds) : [];
  r.prevRanks = r.prevRanks || {};
  r.roundIndex = r.roundIndex || 0;
  r.hostId = r.hostId || null;
  if (r.round) {
    const d = r.round;
    d.finishers = d.finishers || {};
    d.awards = d.awards || {};
    d.group = d.group ? { ...d.group, memberIds: Object.values(d.group.memberIds || {}) } : null;
    d.say = { answererId: null, answerEndsAt: null, lastMissedId: null, attempts: 0, lastMiss: null, winner: null, ...(d.say || {}) };
    d.timeUp = !!d.timeUp;
    d.ended = !!d.ended;
    d.endReason = d.endReason || null;
  } else {
    r.round = null;
  }
  return r;
}

// ---------- helpers ----------
function activeIds(r) {
  return Object.keys(r.players)
    .filter((id) => !r.players[id].left)
    .sort((a, b) => (r.players[a].joinedAt - r.players[b].joinedAt) || (a < b ? -1 : 1));
}
const connectedIds = (r) => activeIds(r).filter((id) => r.players[id].connected);

function requirePlayer(r, uid) {
  const p = r.players[uid];
  if (!p || p.left) throw new GameError('not_in_room', 'You are not in this room');
  return p;
}
function requireHost(r, uid) {
  requirePlayer(r, uid);
  if (uid !== r.hostId) throw new GameError('not_host', 'Only the host can do that');
}

function cleanName(raw, config) {
  const name = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw new GameError('name_required', 'Please enter a name');
  if ([...name].length > config.nameMaxLength) throw new GameError('name_too_long', `Names can be up to ${config.nameMaxLength} characters`);
  return name;
}

/** Competition ranking: ties share a position (1, 1, 3, ...). */
export function rankMap(r) {
  const ids = activeIds(r).sort((a, b) => r.players[b].score - r.players[a].score);
  const map = {};
  ids.forEach((id, i) => {
    map[id] = i > 0 && r.players[ids[i - 1]].score === r.players[id].score ? map[ids[i - 1]] : i + 1;
  });
  return map;
}

function ordinal(n) {
  return n + (['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10] || 'th');
}

// ---------- room lifecycle ----------
function createRoom(code, name, ctx) {
  const { uid, now, config } = ctx;
  return {
    code,
    createdAt: now,
    lastActivityAt: now,
    hostId: uid,
    phase: 'lobby',
    roundIndex: 0,
    deck: [],
    usedIds: [],
    prevRanks: {},
    players: { [uid]: { name: cleanName(name, config), score: 0, joinedAt: now, connected: true, left: false } },
    round: null,
  };
}

function join(r, name, ctx) {
  const { uid, now, config } = ctx;
  const existing = r.players[uid];
  if (existing && !existing.left) {
    // Rejoining from the same phone: keep seat and score.
    existing.connected = true;
    return;
  }
  const clean = cleanName(name, config);
  if (r.phase !== 'lobby') throw new GameError('game_started', 'Game already started');
  if (activeIds(r).length >= config.maxPlayers) throw new GameError('room_full', `Room is full (${config.maxPlayers} players)`);
  if (activeIds(r).some((id) => r.players[id].name.toLowerCase() === clean.toLowerCase())) throw new GameError('name_taken', 'Name already taken');
  r.players[uid] = { name: clean, score: 0, joinedAt: now, connected: true, left: false };
  if (!r.hostId || !r.players[r.hostId] || r.players[r.hostId].left) r.hostId = uid;
}

function leave(r, ctx) {
  const { uid } = ctx;
  requirePlayer(r, uid);
  if (r.phase === 'lobby') delete r.players[uid];
  else Object.assign(r.players[uid], { left: true, connected: false });
  if (activeIds(r).length === 0) return DELETE_ROOM;
  if (uid === r.hostId) handOverHost(r, true);
  checkAllDone(r, ctx);
  return r;
}

function handOverHost(r, force) {
  const current = r.players[r.hostId];
  const ids = activeIds(r);
  const next = ids.find((id) => id !== r.hostId && r.players[id].connected);
  if (next) r.hostId = next;
  else if (force || !current || current.left) r.hostId = ids[0] || null;
}

function beginGame(r, ctx) {
  const { deck, usedIds } = deal(ctx.challenges, {
    playerCount: activeIds(r).length,
    rounds: ctx.config.roundsPerGame,
    usedIds: r.usedIds,
    random: ctx.random,
  });
  r.deck = deck.map((c) => c.id);
  r.usedIds = usedIds;
  r.roundIndex = 0;
  r.prevRanks = {};
  startRound(r, ctx);
}

function startRound(r, ctx) {
  const { now, config } = ctx;
  const ch = ctx.challengeById(r.deck[r.roundIndex]);
  const startsAt = now + config.getReadyMs;
  r.phase = 'round';
  r.round = {
    challengeId: ch.id,
    category: ch.category,
    groupSize: ch.groupSize || 1,
    startsAt,
    endsAt: startsAt + config.roundMs,
    timeUp: false,
    finishers: {},
    group: null,
    say: { answererId: null, answerEndsAt: null, lastMissedId: null, attempts: 0, lastMiss: null, winner: null },
    awards: {},
    ended: false,
    endReason: null,
  };
}

function replaceChallenge(r, ctx) {
  const inDeck = new Set(r.deck);
  const used = new Set(r.usedIds);
  const players = activeIds(r).length;
  const eligible = ctx.challenges.filter((c) => !inDeck.has(c.id) && (c.groupSize || 1) <= players);
  const fresh = eligible.filter((c) => !used.has(c.id));
  const pool = fresh.length ? fresh : eligible;
  if (!pool.length) return false;
  const pick = pool[Math.floor(ctx.random() * pool.length)];
  r.deck[r.roundIndex] = pick.id;
  if (!used.has(pick.id)) r.usedIds.push(pick.id);
  return true;
}

function requireLive(r, now, category) {
  const d = r.round;
  if (r.phase !== 'round' || !d || d.ended) throw new GameError('bad_phase', 'No challenge is running');
  if (now < d.startsAt) throw new GameError('not_started', 'Get ready…');
  if (category && d.category !== category) throw new GameError('bad_category', 'Wrong button for this challenge');
  return d;
}
const timeIsUp = (d, now) => d.timeUp || now >= d.endsAt;

function endRound(r, reason) {
  const d = r.round;
  if (!d || d.ended) return;
  d.ended = true;
  d.endReason = reason;
  const awards = {};
  if (reason !== 'skipped') {
    if (d.category === 'SAY') {
      if (d.say.winner) awards[d.say.winner.playerId] = { points: d.say.winner.points, label: d.say.attempts === 0 ? 'First buzz' : 'Re-buzz' };
    } else if (d.groupSize > 1) {
      if (d.group) d.group.memberIds.forEach((id) => { awards[id] = { points: d.group.points, label: 'Team' }; });
    } else {
      Object.entries(d.finishers).forEach(([id, f]) => { awards[id] = { points: f.points, label: ordinal(f.place) }; });
    }
  }
  r.prevRanks = rankMap(r);
  Object.entries(awards).forEach(([id, a]) => { if (r.players[id]) r.players[id].score += a.points; });
  d.awards = awards;
  r.phase = 'results';
}

function checkAllDone(r) {
  const d = r.round;
  if (r.phase !== 'round' || !d || d.ended || d.category === 'SAY' || d.groupSize > 1) return;
  const ids = connectedIds(r);
  if (ids.length && ids.every((id) => d.finishers[id])) endRound(r, 'all_done');
}

function resolveAnswer(r, uid, correct, timedOut, ctx) {
  const d = r.round;
  const s = d.say;
  if (s.answererId !== uid) return;
  s.answererId = null;
  s.answerEndsAt = null;
  if (correct) {
    s.winner = { playerId: uid, points: s.attempts === 0 ? ctx.config.points.sayFirst : ctx.config.points.sayRebuzz };
    endRound(r, 'correct');
    return;
  }
  s.attempts += 1;
  s.lastMissedId = uid;
  s.lastMiss = { playerId: uid, timedOut, at: ctx.now };
  if (timeIsUp(d, ctx.now)) { d.timeUp = true; endRound(r, 'timeout'); }
}

/** Enforce deadlines and host hand-over. Returns true if anything changed. */
function tick(r, ctx) {
  const { now, config } = ctx;
  let changed = false;
  const d = r.round;
  if (r.phase === 'round' && d && !d.ended) {
    if (d.say.answererId && now >= d.say.answerEndsAt) {
      resolveAnswer(r, d.say.answererId, false, true, ctx);
      changed = true;
    }
    if (!d.ended && now >= d.endsAt) {
      if (!d.timeUp) { d.timeUp = true; changed = true; }
      if (!d.say.answererId) { endRound(r, 'timeout'); changed = true; }
    }
    if (!d.ended) {
      checkAllDone(r);
      if (d.ended) changed = true;
    }
  }
  const host = r.players[r.hostId];
  if (!host || host.left || (!host.connected && now - (host.disconnectedAt || 0) >= config.hostHandoverMs)) {
    const before = r.hostId;
    handOverHost(r, false);
    if (r.hostId !== before) changed = true;
  }
  return changed;
}

/** Is there a deadline or hand-over this phone should enforce right now? */
export function needsTick(raw, ctx) {
  if (!raw) return false;
  const r = normalize(raw);
  return tick(r, ctx);
}

// ---------- the reducer ----------
/**
 * Apply one player action to the room.
 * @returns new room object, NO_CHANGE, or DELETE_ROOM. Throws GameError if not allowed.
 */
export function apply(raw, action, ctx) {
  ctx = { config: defaultConfig, random: Math.random, ...ctx };
  const { uid, now, config } = ctx;
  if (action.type === 'create') {
    if (raw) throw new GameError('code_taken', 'Room code taken');
    return createRoom(action.code, action.name, ctx);
  }
  if (!raw) throw new GameError('room_not_found', 'Room not found');
  const r = normalize(raw);

  switch (action.type) {
    case 'join':
      join(r, action.name, ctx);
      break;

    case 'leave':
      if (leave(r, ctx) === DELETE_ROOM) return DELETE_ROOM;
      break;

    case 'tick':
      if (!tick(r, ctx)) return NO_CHANGE;
      return r;

    case 'start':
      requireHost(r, uid);
      if (r.phase !== 'lobby') throw new GameError('bad_phase', 'Game already started');
      if (activeIds(r).length < config.minPlayers) throw new GameError('not_enough_players', `Need ${config.minPlayers}+ players`);
      beginGame(r, ctx);
      break;

    case 'playAgain':
      requireHost(r, uid);
      if (r.phase !== 'final') throw new GameError('bad_phase', 'Game is not over yet');
      activeIds(r).forEach((id) => { r.players[id].score = 0; });
      beginGame(r, ctx);
      break;

    case 'next':
      requireHost(r, uid);
      if (r.phase !== 'results') throw new GameError('bad_phase', 'Round is still going');
      if (r.roundIndex + 1 >= r.deck.length) {
        r.phase = 'final';
        r.round = null;
      } else {
        r.roundIndex += 1;
        startRound(r, ctx);
      }
      break;

    case 'skip':
      requireHost(r, uid);
      if (r.phase !== 'round' || !r.round || r.round.ended) throw new GameError('bad_phase', 'No round to skip');
      // A skipped challenge doesn't count: swap in a fresh one for the same round.
      if (replaceChallenge(r, ctx)) startRound(r, ctx);
      else endRound(r, 'skipped');
      break;

    case 'done': {
      requirePlayer(r, uid);
      const d = requireLive(r, now);
      if (d.category === 'SAY') throw new GameError('bad_category', 'Buzz in for SAY challenges');
      if (d.groupSize > 1) throw new GameError('group_required', 'Pick your partners for this one');
      if (timeIsUp(d, now)) throw new GameError('time_up', 'Time is up');
      if (d.finishers[uid]) throw new GameError('already_done', 'You already finished');
      const place = Object.keys(d.finishers).length;
      d.finishers[uid] = { at: now, place: place + 1, points: config.points.placing[place] || 0 };
      checkAllDone(r);
      break;
    }

    case 'groupDone': {
      requirePlayer(r, uid);
      const d = requireLive(r, now, 'ACTION');
      if (d.groupSize < 2) throw new GameError('not_group', 'This is a solo challenge');
      if (timeIsUp(d, now)) throw new GameError('time_up', 'Time is up');
      if (d.group) {
        const who = r.players[d.group.memberIds[0]];
        throw new GameError('already_claimed', `Already claimed by ${who ? who.name : 'another'}'s group`);
      }
      const ids = Array.isArray(action.partnerIds) ? [...new Set(action.partnerIds)] : [];
      if (ids.includes(uid) || ids.length !== d.groupSize - 1) throw new GameError('bad_partners', `Pick ${d.groupSize - 1} partner${d.groupSize > 2 ? 's' : ''}`);
      ids.forEach((id) => requirePlayer(r, id));
      d.group = { memberIds: [uid, ...ids], at: now, points: config.points.group };
      endRound(r, 'group_done');
      break;
    }

    case 'buzz': {
      requirePlayer(r, uid);
      const d = requireLive(r, now, 'SAY');
      const s = d.say;
      if (s.answererId) throw new GameError('someone_answering', 'Someone is already answering');
      if (timeIsUp(d, now)) throw new GameError('time_up', 'Time is up');
      if (s.lastMissedId === uid) throw new GameError('wait_turn', 'Wait for someone else to have a go');
      s.answererId = uid;
      s.answerEndsAt = now + config.sayAnswerMs;
      break;
    }

    case 'sayResult': {
      requirePlayer(r, uid);
      const d = requireLive(r, now, 'SAY');
      if (d.say.answererId !== uid) throw new GameError('not_answering', 'You are not answering');
      if (action.correct && now > d.say.answerEndsAt + SAY_GRACE_MS) throw new GameError('too_late', 'Too late!');
      resolveAnswer(r, uid, !!action.correct, false, ctx);
      break;
    }

    default:
      throw new GameError('bad_action', 'Unknown action');
  }
  r.lastActivityAt = now;
  return r;
}

// ---------- view model for the UI ----------
export function view(raw, uid, now, { config = defaultConfig, challengeById } = {}) {
  const r = normalize(raw);
  if (!r || !r.players[uid] || r.players[uid].left) return null;
  const ranks = rankMap(r);
  const order = activeIds(r);
  const players = order
    .map((id) => {
      const p = r.players[id];
      return {
        id,
        name: p.name,
        score: p.score,
        connected: !!p.connected,
        isHost: id === r.hostId,
        order: order.indexOf(id),
        rank: ranks[id],
        prevRank: r.prevRanks[id] ?? ranks[id],
      };
    })
    .sort((a, b) => b.score - a.score || a.order - b.order);

  let phase = r.phase;
  let round = null;
  if (r.round && (r.phase === 'round' || r.phase === 'results')) {
    const d = r.round;
    if (r.phase === 'round') phase = now < d.startsAt ? 'ready' : 'active';
    const ch = challengeById(d.challengeId) || { id: d.challengeId, text: '', category: d.category };
    round = {
      challenge: { id: ch.id, category: d.category, text: ch.text, groupSize: d.groupSize, image: ch.image || null, link: ch.link || null },
      startsAt: d.startsAt,
      endsAt: d.endsAt,
      timeUp: d.timeUp,
      finishers: Object.entries(d.finishers).sort((a, b) => a[1].place - b[1].place).map(([playerId, f]) => ({ playerId, points: f.points })),
      group: d.group,
      say: d.say,
      awards: Object.entries(d.awards).map(([playerId, a]) => ({ playerId, ...a })).sort((a, b) => b.points - a.points),
      ended: d.ended,
      endReason: d.endReason,
    };
  }
  return {
    code: r.code,
    me: { id: uid, isHost: uid === r.hostId },
    phase,
    roundIndex: r.roundIndex,
    totalRounds: r.deck.length || config.roundsPerGame,
    minPlayers: config.minPlayers,
    maxPlayers: config.maxPlayers,
    players,
    round,
  };
}
