// Game engine: one Room = one game. Pure logic + injected clock so it can be unit-tested.
import { randomBytes } from 'node:crypto';
import defaultConfig from './config.js';
import { deal } from './dealer.js';

export class GameError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

const realClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (t) => clearTimeout(t),
};

const id = (prefix, bytes = 4) => prefix + randomBytes(bytes).toString('hex');

export class Room {
  constructor(code, challenges, { config = defaultConfig, clock = realClock, onChange = () => {}, random = Math.random } = {}) {
    this.code = code;
    this.challenges = challenges;
    this.config = config;
    this.clock = clock;
    this.onChange = onChange;
    this.random = random;

    this.hostId = null;
    this.phase = 'lobby'; // lobby | ready | active | results | final
    this.players = new Map();
    this.joinOrder = [];
    this.deck = [];
    this.usedIds = new Set();
    this.roundIndex = 0;
    this.round = null;
    this.timers = {};
    this.createdAt = clock.now();
    this.lastActivityAt = this.createdAt;
  }

  // ---------- helpers ----------
  now() { return this.clock.now(); }
  changed() { this.lastActivityAt = this.now(); this.onChange(this); }
  setTimer(name, ms, fn) {
    this.clearTimer(name);
    this.timers[name] = this.clock.setTimer(() => { delete this.timers[name]; fn(); }, ms);
  }
  clearTimer(name) {
    if (this.timers[name]) { this.clock.clearTimer(this.timers[name]); delete this.timers[name]; }
  }
  clearAllTimers() { Object.keys(this.timers).forEach((n) => this.clearTimer(n)); }

  getPlayer(pid) {
    const p = this.players.get(pid);
    if (!p || p.left) throw new GameError('not_in_room', 'You are not in this room');
    return p;
  }
  requireHost(pid) {
    this.getPlayer(pid);
    if (pid !== this.hostId) throw new GameError('not_host', 'Only the host can do that');
  }
  activePlayers() { return [...this.players.values()].filter((p) => !p.left); }
  connectedPlayers() { return this.activePlayers().filter((p) => p.connected); }
  playerByToken(token) {
    for (const p of this.players.values()) if (p.token === token && !p.left) return p;
    return null;
  }

  // ---------- lobby ----------
  addPlayer(rawName) {
    const name = String(rawName ?? '').trim().replace(/\s+/g, ' ');
    if (!name) throw new GameError('name_required', 'Please enter a name');
    if ([...name].length > this.config.nameMaxLength) throw new GameError('name_too_long', `Names can be up to ${this.config.nameMaxLength} characters`);
    if (this.phase !== 'lobby') throw new GameError('game_started', 'Game already started');
    if (this.activePlayers().length >= this.config.maxPlayers) throw new GameError('room_full', `Room is full (${this.config.maxPlayers} players)`);
    if (this.activePlayers().some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new GameError('name_taken', 'Name already taken');

    const player = { id: id('p_'), token: id('', 16), name, score: 0, connected: false, left: false, joinedAt: this.now() };
    this.players.set(player.id, player);
    this.joinOrder.push(player.id);
    if (!this.hostId) this.hostId = player.id;
    this.changed();
    return player;
  }

  setConnected(pid, connected) {
    const p = this.players.get(pid);
    if (!p || p.left || p.connected === connected) return;
    p.connected = connected;
    if (pid === this.hostId) {
      if (connected) this.clearTimer('handover');
      else this.setTimer('handover', this.config.hostHandoverMs, () => this.handOverHost());
    }
    if (!connected) this.checkAllDone();
    this.changed();
  }

  leave(pid) {
    const p = this.getPlayer(pid);
    if (this.phase === 'lobby') {
      this.players.delete(pid);
      this.joinOrder = this.joinOrder.filter((x) => x !== pid);
    } else {
      p.left = true;
      p.connected = false;
    }
    if (pid === this.hostId) this.handOverHost();
    this.checkAllDone();
    this.changed();
  }

  handOverHost() {
    const next = this.joinOrder
      .map((x) => this.players.get(x))
      .find((p) => p && !p.left && p.connected && p.id !== this.hostId);
    if (next) this.hostId = next.id;
    else if (!this.players.get(this.hostId) || this.players.get(this.hostId).left) {
      const anyone = this.joinOrder.map((x) => this.players.get(x)).find((p) => p && !p.left);
      this.hostId = anyone ? anyone.id : null;
    }
    this.changed();
  }

  // ---------- host controls ----------
  start(pid) {
    this.requireHost(pid);
    if (this.phase !== 'lobby') throw new GameError('bad_phase', 'Game already started');
    if (this.activePlayers().length < this.config.minPlayers) throw new GameError('not_enough_players', `Need ${this.config.minPlayers}+ players`);
    this.beginGame();
  }

  playAgain(pid) {
    this.requireHost(pid);
    if (this.phase !== 'final') throw new GameError('bad_phase', 'Game is not over yet');
    this.activePlayers().forEach((p) => { p.score = 0; });
    this.beginGame();
  }

  beginGame() {
    const { deck, usedIds } = deal(this.challenges, {
      playerCount: this.activePlayers().length,
      rounds: this.config.roundsPerGame,
      usedIds: this.usedIds,
      random: this.random,
    });
    this.deck = deck;
    this.usedIds = usedIds;
    this.roundIndex = 0;
    this.startRound();
  }

  next(pid) {
    this.requireHost(pid);
    if (this.phase !== 'results') throw new GameError('bad_phase', 'Round is still going');
    if (this.roundIndex + 1 >= this.deck.length) {
      this.phase = 'final';
      this.round = null;
      this.changed();
      return;
    }
    this.roundIndex += 1;
    this.startRound();
  }

  skip(pid) {
    this.requireHost(pid);
    if (this.phase !== 'ready' && this.phase !== 'active') throw new GameError('bad_phase', 'No round to skip');
    this.endRound('skipped');
  }

  // ---------- rounds ----------
  startRound() {
    const challenge = this.deck[this.roundIndex];
    const startsAt = this.now() + this.config.getReadyMs;
    this.round = {
      challenge,
      category: challenge.category,
      groupSize: challenge.groupSize || 1,
      startsAt,
      endsAt: startsAt + this.config.roundMs,
      timeUp: false,
      finishers: [], // { playerId, at, points }
      group: null, // { memberIds, at }
      say: { answererId: null, answerEndsAt: null, lastMissedId: null, attempts: 0, lastMiss: null, winner: null },
      awards: [], // { playerId, points, label }
      ended: false,
      endReason: null,
    };
    this.phase = 'ready';
    this.setTimer('ready', this.config.getReadyMs, () => {
      this.phase = 'active';
      this.changed();
    });
    this.setTimer('round', this.config.getReadyMs + this.config.roundMs, () => this.onRoundTimeout());
    this.changed();
  }

  requireActive(category) {
    if (this.phase !== 'active' || !this.round || this.round.ended) throw new GameError('bad_phase', 'No challenge is running');
    if (category && this.round.category !== category) throw new GameError('bad_category', 'Wrong button for this challenge');
  }

  done(pid) {
    this.getPlayer(pid);
    this.requireActive();
    const r = this.round;
    if (r.category === 'SAY') throw new GameError('bad_category', 'Buzz in for SAY challenges');
    if (r.groupSize > 1) throw new GameError('group_required', 'Pick your partners for this one');
    if (r.timeUp) throw new GameError('time_up', 'Time is up');
    if (r.finishers.some((f) => f.playerId === pid)) throw new GameError('already_done', 'You already finished');
    const points = this.config.points.placing[r.finishers.length] || 0;
    r.finishers.push({ playerId: pid, at: this.now(), points });
    this.checkAllDone();
    this.changed();
  }

  groupDone(pid, partnerIds) {
    this.getPlayer(pid);
    this.requireActive('ACTION');
    const r = this.round;
    if (r.groupSize < 2) throw new GameError('not_group', 'This is a solo challenge');
    if (r.timeUp) throw new GameError('time_up', 'Time is up');
    if (r.group) {
      const who = this.players.get(r.group.memberIds[0]);
      throw new GameError('already_claimed', `Already claimed by ${who ? who.name : 'another'}'s group`);
    }
    const ids = Array.isArray(partnerIds) ? [...new Set(partnerIds)] : [];
    if (ids.includes(pid) || ids.length !== r.groupSize - 1) throw new GameError('bad_partners', `Pick ${r.groupSize - 1} partner${r.groupSize > 2 ? 's' : ''}`);
    ids.forEach((x) => this.getPlayer(x));
    r.group = { memberIds: [pid, ...ids], at: this.now() };
    this.endRound('group_done');
  }

  buzz(pid) {
    this.getPlayer(pid);
    this.requireActive('SAY');
    const s = this.round.say;
    if (this.round.timeUp) throw new GameError('time_up', 'Time is up');
    if (s.answererId) throw new GameError('someone_answering', 'Someone is already answering');
    if (s.lastMissedId === pid) throw new GameError('wait_turn', 'Wait for someone else to have a go');
    s.answererId = pid;
    s.answerEndsAt = this.now() + this.config.sayAnswerMs;
    this.setTimer('answer', this.config.sayAnswerMs, () => this.resolveAnswer(pid, false, true));
    this.changed();
  }

  sayResult(pid, correct) {
    this.getPlayer(pid);
    this.requireActive('SAY');
    if (this.round.say.answererId !== pid) throw new GameError('not_answering', 'You are not answering');
    this.resolveAnswer(pid, !!correct, false);
  }

  resolveAnswer(pid, correct, timedOut) {
    const r = this.round;
    if (!r || r.ended || r.say.answererId !== pid) return;
    this.clearTimer('answer');
    const s = r.say;
    s.answererId = null;
    s.answerEndsAt = null;
    if (correct) {
      const points = s.attempts === 0 ? this.config.points.sayFirst : this.config.points.sayRebuzz;
      s.winner = { playerId: pid, points };
      this.endRound('correct');
      return;
    }
    s.attempts += 1;
    s.lastMissedId = pid;
    s.lastMiss = { playerId: pid, timedOut, at: this.now() };
    if (r.timeUp) this.endRound('timeout');
    else this.changed();
  }

  onRoundTimeout() {
    const r = this.round;
    if (!r || r.ended) return;
    r.timeUp = true;
    // Let a SAY answerer finish their 5 seconds.
    if (r.category === 'SAY' && r.say.answererId) { this.changed(); return; }
    this.endRound('timeout');
  }

  checkAllDone() {
    const r = this.round;
    if (this.phase !== 'active' || !r || r.ended || r.category === 'SAY' || r.groupSize > 1) return;
    const connected = this.connectedPlayers();
    if (connected.length && connected.every((p) => r.finishers.some((f) => f.playerId === p.id))) this.endRound('all_done');
  }

  endRound(reason) {
    const r = this.round;
    if (!r || r.ended) return;
    this.clearTimer('ready');
    this.clearTimer('round');
    this.clearTimer('answer');
    r.ended = true;
    r.endReason = reason;

    const awards = [];
    if (reason !== 'skipped') {
      if (r.category === 'SAY') {
        if (r.say.winner) awards.push({ playerId: r.say.winner.playerId, points: r.say.winner.points, label: r.say.attempts === 0 ? 'First buzz' : 'Re-buzz' });
      } else if (r.groupSize > 1) {
        if (r.group) r.group.memberIds.forEach((x) => awards.push({ playerId: x, points: this.config.points.group, label: 'Team' }));
      } else {
        r.finishers.forEach((f, i) => awards.push({ playerId: f.playerId, points: f.points, label: ordinal(i + 1) }));
      }
    }
    // Remember positions before scoring so the results screen can show ▲▼.
    this.prevRanks = rankMap(this.activePlayers());
    awards.forEach((a) => { const p = this.players.get(a.playerId); if (p) p.score += a.points; });
    r.awards = awards;
    this.phase = 'results';
    this.changed();
  }

  // ---------- view ----------
  snapshot(pid) {
    const ranks = rankMap(this.activePlayers());
    const players = this.activePlayers()
      .map((p) => ({
        id: p.id,
        name: p.name,
        score: p.score,
        connected: p.connected,
        isHost: p.id === this.hostId,
        order: this.joinOrder.indexOf(p.id),
        rank: ranks.get(p.id),
        prevRank: this.prevRanks ? this.prevRanks.get(p.id) ?? ranks.get(p.id) : ranks.get(p.id),
      }))
      .sort((a, b) => b.score - a.score || this.joinOrder.indexOf(a.id) - this.joinOrder.indexOf(b.id));

    let round = null;
    if (this.round && (this.phase === 'ready' || this.phase === 'active' || this.phase === 'results')) {
      const r = this.round;
      round = {
        challenge: { id: r.challenge.id, category: r.category, text: r.challenge.text, groupSize: r.groupSize, image: r.challenge.image || null },
        startsAt: r.startsAt,
        endsAt: r.endsAt,
        timeUp: r.timeUp,
        finishers: r.finishers.map((f) => ({ playerId: f.playerId, points: f.points })),
        group: r.group,
        say: { ...r.say },
        awards: r.awards,
        ended: r.ended,
        endReason: r.endReason,
      };
    }
    return {
      serverNow: this.now(),
      code: this.code,
      me: { id: pid, isHost: pid === this.hostId },
      phase: this.phase,
      roundIndex: this.roundIndex,
      totalRounds: this.deck.length || this.config.roundsPerGame,
      minPlayers: this.config.minPlayers,
      maxPlayers: this.config.maxPlayers,
      players,
      round,
    };
  }

  destroy() { this.clearAllTimers(); }
}

function ordinal(n) {
  return n + (['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10] || 'th');
}

// Competition ranking: ties share a position (1, 1, 3, ...).
export function rankMap(players) {
  const sorted = players.slice().sort((a, b) => b.score - a.score);
  const map = new Map();
  sorted.forEach((p, i) => {
    map.set(p.id, i > 0 && sorted[i - 1].score === p.score ? map.get(sorted[i - 1].id) : i + 1);
  });
  return map;
}
