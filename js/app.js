// Chaotic Party — phone client.
// The room lives in Firebase; every action runs the rules engine inside a
// database transaction, and every phone re-renders when the room changes.
import { apply, needsTick, view, GameError, NO_CHANGE, DELETE_ROOM } from './engine.js?v=0.5.0';
import config from './config.js?v=0.5.0';

const $app = document.getElementById('app');
const $banner = document.getElementById('banner');
const $toast = document.getElementById('toast');

const CATS = {
  ACTION: { icon: '🤸', button: 'Completed' },
  SAY: { icon: '🗣️', button: 'Buzz in' },
  FIND: { icon: '🔍', button: 'Found it' },
  TOUCH: { icon: '✋', button: 'Done' },
};
export const VERSION = '0.5.0';
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const params = new URLSearchParams(location.search);
const MOCK = params.get('mock') === '1';

let backend = null;
let challenges = [];
let challengeMap = new Map();

const ui = {
  view: 'home', // home | create | join | game
  session: null, // { code }
  raw: null, // room data from the database
  state: null, // view model for this player
  unwatch: null,
  unpresence: null,
  error: '',
  busy: false,
  prefillCode: '',
  picking: false,
  picked: new Set(),
  roundKey: '',
  seenMissAt: 0,
  leaveArmed: false,
  ticking: false,
  lastTickAt: 0,
};

// ---------- utils ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const now = () => (backend ? backend.now() : Date.now());
const secsLeft = (t) => Math.max(0, Math.ceil((t - now()) / 1000));
const nameOf = (id) => ui.state?.players.find((p) => p.id === id)?.name ?? 'Someone';
const ord = (n) => n + (['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10] || 'th');
const vibrate = (p) => { try { navigator.vibrate && navigator.vibrate(p); } catch {} };
const shareUrl = (code) => `${location.origin}${location.pathname}?room=${code}${MOCK ? '&mock=1' : ''}`;

const sessionKey = () => `cp_session_${backend.uid}`;
function loadSession() {
  try { return JSON.parse((MOCK ? sessionStorage : localStorage).getItem(sessionKey())) || null; } catch { return null; }
}
function saveSession(s) {
  ui.session = s;
  const store = MOCK ? sessionStorage : localStorage;
  try { s ? store.setItem(sessionKey(), JSON.stringify(s)) : store.removeItem(sessionKey()); } catch {}
}
function savedName() { try { return localStorage.getItem('cp_name') || ''; } catch { return ''; } }
function rememberName(n) { try { localStorage.setItem('cp_name', n); } catch {} }

let toastTimer;
function toast(msg) {
  $toast.textContent = msg;
  $toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $toast.hidden = true; }, 2200);
}

// ---------- talking to the database ----------
const ctx = () => ({ uid: backend.uid, now: now(), config, challenges, challengeById: (id) => challengeMap.get(id) });

/** Run one action as a transaction. Throws GameError if the rules say no. */
async function run(code, action) {
  let error = null;
  const res = await backend.transact(code, (current) => {
    error = null;
    // Firebase may first call this with an empty local cache. Returning the
    // value unchanged lets it fetch the real data and call us again.
    if (current === null && action.type !== 'create') return null;
    try {
      const next = apply(current, action, ctx());
      if (next === NO_CHANGE) return undefined;
      if (next === DELETE_ROOM) return null;
      return JSON.parse(JSON.stringify(next));
    } catch (e) {
      if (!(e instanceof GameError)) console.error(e);
      error = e;
      return undefined;
    }
  });
  if (error) throw error;
  if (res.committed && res.value === null && action.type !== 'leave' && action.type !== 'tick') {
    throw new GameError('room_not_found', 'Room not found');
  }
  return res;
}

async function act(type, extra = {}) {
  if (!ui.session) return;
  try {
    await run(ui.session.code, { type, ...extra });
  } catch (e) {
    toast(e.message || 'Something went wrong');
  }
}

function connect(code) {
  disconnect();
  ui.unwatch = backend.watch(code, (raw) => {
    ui.raw = raw;
    const s = raw ? view(raw, backend.uid, now(), { config, challengeById: (id) => challengeMap.get(id) }) : null;
    if (!s) return endSession(raw ? 'You left the game' : 'That game has ended');
    onState(s);
  });
  ui.unpresence = backend.presence(code);
}

function disconnect() {
  if (ui.unwatch) ui.unwatch();
  if (ui.unpresence) Promise.resolve(ui.unpresence).then((f) => f && f());
  ui.unwatch = ui.unpresence = null;
}

function endSession(msg) {
  disconnect();
  saveSession(null);
  ui.raw = null;
  ui.state = null;
  ui.view = 'home';
  if (msg) toast(msg);
  render();
}

function onState(s) {
  const prev = ui.state;
  ui.state = s;
  ui.view = 'game';
  const key = s.round ? `${s.roundIndex}:${s.round.challenge.id}:${s.round.startsAt}` : '';
  if (key !== ui.roundKey) {
    ui.roundKey = key;
    ui.picking = false;
    ui.picked = new Set();
  }
  // Moments worth a buzz.
  if (prev && prev.phase === 'ready' && s.phase === 'active') vibrate(80);
  const say = s.round?.say;
  if (say?.answererId === s.me.id && prev?.round?.say?.answererId !== s.me.id) vibrate([60, 40, 60]);
  if (say?.lastMiss && say.lastMiss.at !== ui.seenMissAt) {
    ui.seenMissAt = say.lastMiss.at;
    if (now() - say.lastMiss.at < 2000) showFlash(say.lastMiss.playerId === s.me.id ? 'Missed!' : `${nameOf(say.lastMiss.playerId)} missed!`);
  }
  render();
}

/** Every phone watches the clock: refresh "get ready" → "go", and enforce deadlines. */
function heartbeat() {
  if (!ui.raw || !ui.session) return;
  const s = view(ui.raw, backend.uid, now(), { config, challengeById: (id) => challengeMap.get(id) });
  if (s && ui.state && s.phase !== ui.state.phase) onState(s);
  if (!ui.ticking && Date.now() - ui.lastTickAt > 300 && needsTick(ui.raw, ctx())) {
    ui.ticking = true;
    ui.lastTickAt = Date.now();
    run(ui.session.code, { type: 'tick' }).catch(() => {}).finally(() => { ui.ticking = false; });
  }
}

function showFlash(text) {
  const el = document.createElement('div');
  el.className = 'flash';
  el.innerHTML = `<p class="display center">⏰<br>${esc(text)}</p>`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1100);
}

// ---------- views ----------
function render() {
  const s = ui.state;
  let html;
  if (ui.view === 'home') html = viewHome();
  else if (ui.view === 'create') html = viewForm('create');
  else if (ui.view === 'join') html = viewForm('join');
  else if (!s) html = `<p class="muted center">Connecting…</p>`;
  else if (s.phase === 'lobby') html = viewLobby(s);
  else if (s.phase === 'ready') html = viewReady(s);
  else if (s.phase === 'active') html = viewActive(s);
  else if (s.phase === 'results') html = viewResults(s);
  else html = viewFinal(s);

  // Keep typed text and focus across re-renders of the forms.
  const focused = document.activeElement?.id;
  const values = {};
  $app.querySelectorAll('input').forEach((i) => { values[i.id] = i.value; });
  // Planless Lab header + footer only on the home screen; the game fills the screen everywhere else.
  const onHome = ui.view === 'home';
  if (document.body.classList.contains('on-home') !== onHome) {
    document.body.classList.toggle('on-home', onHome);
    if (!onHome) window.scrollTo(0, 0);
  }
  $app.className = 'app' + (s?.round && (s.phase === 'ready' || s.phase === 'active') ? ` cat-${s.round.challenge.category}` : '');
  $app.innerHTML = html;
  $app.querySelectorAll('input').forEach((i) => { if (values[i.id] !== undefined) i.value = values[i.id]; });
  if (focused) document.getElementById(focused)?.focus();
  tick();
}

function header(eyebrow) {
  return `<header class="top"><p class="wordmark sm">Chaotic Party</p><p class="eyebrow">${esc(eyebrow)}</p></header>`;
}

function viewHome() {
  return `
    <header class="top"><p class="eyebrow">Party game · 3–10 players</p></header>
    <div class="stack center" style="align-items:center;gap:22px;margin-top:3vh">
      <div class="hero-grid" aria-hidden="true">
        <i class="c">🤸</i><i></i><i class="s">🗣️</i>
        <i></i><i class="f">🔍</i><i></i>
        <i class="t">✋</i><i></i><i class="c">⚡</i>
      </div>
      <h1 class="wordmark xl">Chaotic<br>Party</h1>
      <p style="font-size:18px;max-width:30ch;margin:0;color:var(--ink-2)">Race your friends to find, touch, say and do silly real-world challenges, all from your phone.</p>
    </div>
    <div class="spacer"></div>
    <div class="stack">
      <button class="btn block" data-action="go-create">＋ Create room</button>
      <button class="btn pop block" data-action="go-join">→ Join room</button>
    </div>
    <p class="safety"><b>House rules:</b> walk, don't run. Nothing hot or sharp. Bathrooms and bedrooms are off limits. Put things back after each round.</p>
    <p class="muted small center" style="margin:0">v${VERSION}</p>`;
}

function viewForm(kind) {
  const join = kind === 'join';
  const fromLink = join && /^[A-Z]{4}$/.test(ui.prefillCode);
  const codeField = !join ? '' : fromLink
    ? `<div class="code-card"><span class="muted small">You're joining room</span><span class="display">${esc(ui.prefillCode)}</span>
        <input id="code" type="hidden" value="${esc(ui.prefillCode)}"></div>`
    : `<div class="field"><label for="code">Room code</label>
        <input id="code" class="input code" maxlength="4" placeholder="ABCD" value="" autocapitalize="characters" inputmode="text" required></div>`;
  return `
    ${header(join ? 'Join a room' : 'Create a room')}
    <hr class="rule">
    <form class="stack" data-form="${kind}" autocomplete="off">
      ${codeField}
      <div class="field"><label for="name">Your name</label>
        <input id="name" class="input" maxlength="12" placeholder="Your name" value="${esc(savedName())}" required ${fromLink ? 'autofocus' : ''}></div>
      <p class="error">${esc(ui.error)}</p>
      <button class="btn ${join ? 'pop' : ''} block" type="submit" ${ui.busy ? 'disabled' : ''}>${join ? 'Join game' : 'Create room'}</button>
    </form>
    ${fromLink ? '<button class="linkbtn" data-action="other-room">Join a different room</button>' : ''}
    <button class="linkbtn" data-action="go-home">← Back</button>`;
}

function viewLobby(s) {
  const me = s.me;
  const n = s.players.length;
  const enough = n >= s.minPlayers;
  return `
    ${header('Lobby')}
    <div class="code-card">
      <span class="muted small">Tell your friends the code</span>
      <span class="display">${esc(s.code)}</span>
      <button class="btn small dark" data-action="share" style="align-self:center;margin-top:8px">🔗 Share invite link</button>
      <button class="linkbtn small" data-action="copy-link" style="word-break:break-all">${esc(shareUrl(s.code).replace(/^https?:\/\//, ''))}</button>
    </div>
    <div class="stack" style="gap:8px">
      <div class="row" style="justify-content:space-between;align-items:baseline"><h2 class="heading">Players</h2><span class="muted small">${n} / ${s.maxPlayers}</span></div>
      <ul class="player-list">
        ${s.players.map((p) => `<li><span><i class="dot ${p.connected ? '' : 'off'}"></i>${esc(p.name)}${p.isHost ? '<span class="host-tag">HOST</span>' : ''}${p.id === me.id ? ' <span class="muted small">(you)</span>' : ''}</span></li>`).join('')}
      </ul>
    </div>
    <div class="spacer"></div>
    ${me.isHost
      ? `<button class="btn block ${enough ? '' : 'waiting'}" data-action="start" ${enough ? '' : 'disabled'}>${enough ? '▶ Start game' : `Need ${s.minPlayers}+ players`}</button>`
      : `<button class="btn block waiting" disabled>Waiting for host…</button>`}
    ${leaveButton()}`;
}

function leaveButton() {
  return `<button class="linkbtn" data-action="leave">${ui.leaveArmed ? 'Tap again to leave' : 'Leave game'}</button>`;
}

function hud(s) {
  const me = s.players.find((p) => p.id === s.me.id);
  return `<div class="hud"><span>${s.roundIndex + 1} / ${s.totalRounds}</span><span class="timer" data-until="${s.round.endsAt}" data-low="5">${secsLeft(s.round.endsAt)}</span><span class="right">★ ${me ? me.score : 0}</span></div>
    <div class="progress"><i data-bar-from="${s.round.startsAt}" data-bar-to="${s.round.endsAt}"></i></div>`;
}

function viewReady(s) {
  const c = s.round.challenge;
  return `
    <div class="hud"><span>${s.roundIndex + 1} / ${s.totalRounds}</span><span></span><span class="right">${s.me.isHost ? '<button class="linkbtn" data-action="skip">Skip</button>' : ''}</span></div>
    <div class="ready">
      <p class="eyebrow">Get ready</p>
      <div class="icon-tile">${CATS[c.category].icon}</div>
      <div class="catname">${esc(c.category)}</div>
      <div class="count" data-until="${s.round.startsAt}">${secsLeft(s.round.startsAt)}</div>
    </div>`;
}

function viewActive(s) {
  const r = s.round;
  const c = r.challenge;
  let controls = '';
  let status = '';
  let below = '';

  if (c.category === 'SAY') ({ controls, status } = sayControls(s));
  else if (c.groupSize > 1) ({ controls, status, below } = groupControls(s));
  else ({ controls, status, below } = soloControls(s));

  return `
    ${hud(s)}
    <span class="badge">${CATS[c.category].icon} ${esc(c.category)}</span>
    <p class="challenge-text">${esc(c.text)}</p>
    ${c.groupSize > 1 ? `<p class="group-note">👥 ${c.groupSize} players · first team wins 3 points each</p>` : ''}
    ${c.link ? `<a class="btn small ink howto" href="${esc(c.link)}" target="_blank" rel="noopener">▶ Watch how</a>` : ''}
    ${c.image ? `<img src="${esc(c.image)}" alt="" style="max-width:100%;border:2px solid var(--ink)">` : ''}
    <div class="spacer"></div>
    ${controls}
    <p class="status ${status.cls || ''}">${status.text || ''}</p>
    ${below}
    ${s.me.isHost ? '<button class="linkbtn" data-action="skip">Skip this challenge</button>' : ''}`;
}

function playerTiles(s, finishers) {
  return `<div class="tiles">${s.players.slice().sort((a, b) => a.order - b.order).map((p) => {
    const f = finishers.find((x) => x.playerId === p.id);
    const cls = f ? 'done' : p.connected ? '' : 'off';
    return `<div class="tile ${cls}">${esc(p.name)}${f ? `<span class="pts">+${f.points}</span>` : p.connected ? '' : '<span class="small">away</span>'}</div>`;
  }).join('')}</div>`;
}

function soloControls(s) {
  const r = s.round;
  const cat = CATS[r.challenge.category];
  const idx = r.finishers.findIndex((f) => f.playerId === s.me.id);
  const going = s.players.filter((p) => p.connected && !r.finishers.some((f) => f.playerId === p.id)).length;
  const below = playerTiles(s, r.finishers) + `<p class="strip">${going} still going</p>`;
  if (idx >= 0) {
    const pts = r.finishers[idx].points;
    return {
      controls: `<button class="btn mega waiting" disabled>${ord(idx + 1)}!${pts ? ` +${pts}` : ''}</button>`,
      status: pts ? { cls: 'good', text: `Completed: ${ord(idx + 1)}! +${pts}` } : { cls: 'bad', text: 'Too slow — no points this time' },
      below,
    };
  }
  return { controls: `<button class="btn mega cat go" data-action="done">${esc(cat.button)}</button>`, status: { text: 'Challenge active' }, below };
}

function groupControls(s) {
  const r = s.round;
  const need = r.challenge.groupSize - 1;
  if (!ui.picking) {
    return {
      controls: `<button class="btn mega cat go" data-action="group-start">Completed</button>`,
      status: { text: `Find ${need} partner${need > 1 ? 's' : ''} and do it together!` },
      below: '',
    };
  }
  const left = need - ui.picked.size;
  const others = s.players.filter((p) => p.id !== s.me.id).sort((a, b) => a.order - b.order);
  return {
    controls: `<div class="stack"><h2 class="heading">Pick your partner${need > 1 ? 's' : ''}</h2>
      <div class="tiles">${others.map((p) => `<button class="tile pick ${ui.picked.has(p.id) ? 'picked' : ''} ${p.connected ? '' : 'off'}" data-action="pick" data-id="${p.id}">${esc(p.name)}${ui.picked.has(p.id) ? '<span class="pts">✓</span>' : ''}</button>`).join('')}</div>
      <div class="row"><button class="btn dark" data-action="group-cancel">Cancel</button><button class="btn ${left === 0 ? '' : 'waiting'}" data-action="group-confirm" ${left === 0 ? '' : 'disabled'}>Confirm</button></div></div>`,
    status: { text: left > 0 ? `Pick ${left} more` : 'Ready — tap Confirm!' },
    below: '',
  };
}

function sayControls(s) {
  const say = s.round.say;
  const me = s.me.id;
  if (say.answererId === me) {
    return {
      controls: `<p class="display md center">Say it out loud!</p>
        <div class="answer-count" data-until="${say.answerEndsAt}">${secsLeft(say.answerEndsAt)}</div>
        <button class="btn mega cat go" data-action="say-yes" data-hide-at="${say.answerEndsAt}">Completed</button>`,
      status: { cls: 'good', text: 'Tap Completed as soon as you\'ve said it' },
    };
  }
  if (say.answererId) {
    return {
      controls: `<button class="btn mega waiting" disabled>${esc(nameOf(say.answererId))} is answering…</button>`,
      status: { text: `<span data-until="${say.answerEndsAt}">${secsLeft(say.answerEndsAt)}</span>s left to answer` },
    };
  }
  if (say.lastMissedId === me) {
    return {
      controls: `<button class="btn mega waiting" disabled>Wait…</button>`,
      status: { cls: 'bad', text: 'Wait for someone else to have a go' },
    };
  }
  return {
    controls: `<button class="btn mega cat go" data-action="buzz">Buzz in</button>`,
    status: { text: say.attempts ? `Re-buzz! Correct now scores +2` : 'First correct answer scores +3' },
  };
}

function roundHeadline(s) {
  const r = s.round;
  const a = r.awards;
    if (r.endReason === 'correct') return `${nameOf(a[0].playerId)} got it! +${a[0].points}`;
  if (r.endReason === 'group_done') return `Team ${a.map((x) => nameOf(x.playerId)).join(' & ')} +3 each`;
  if (!a.some((x) => x.points > 0)) return 'Nobody scored!';
  return r.endReason === 'all_done' ? 'Everyone finished!' : "Time's up!";
}

function board(s, { gains = true } = {}) {
  const gain = new Map();
  if (gains && s.round) s.round.awards.forEach((a) => gain.set(a.playerId, (gain.get(a.playerId) || 0) + a.points));
  return `<ol class="board">${s.players.map((p) => {
    const g = gain.get(p.id);
    const mv = gains && p.prevRank && p.prevRank !== p.rank
      ? `<span class="move ${p.prevRank > p.rank ? 'up' : 'down'}">${p.prevRank > p.rank ? '▲' : '▼'}</span>` : '';
    return `<li class="${p.id === s.me.id ? 'me' : ''}"><span class="pos">${p.rank}</span><span>${esc(p.name)}${p.isHost ? '<span class="host-tag">HOST</span>' : ''}${mv}</span><span class="gain">${g ? `+${g}` : ''}</span><span class="score">${p.score}</span></li>`;
  }).join('')}</ol>`;
}

function viewResults(s) {
  const last = s.roundIndex + 1 >= s.totalRounds;
  const c = s.round.challenge;
  return `
    <p class="eyebrow">Round ${s.roundIndex + 1} / ${s.totalRounds} · ${CATS[c.category].icon} ${esc(c.category)}</p>
    <h1 class="display lg">${esc(roundHeadline(s))}</h1>
    <p class="muted" style="margin:0">${esc(c.text)}</p>
    <hr class="rule">
    <h2 class="heading">Scores</h2>
    ${board(s)}
    <div class="spacer"></div>
    ${s.me.isHost
      ? `<button class="btn block" data-action="next">${last ? '🏆 Final results' : 'Next round →'}</button>`
      : `<button class="btn block waiting" disabled>Waiting for host…</button>`}`;
}

function viewFinal(s) {
  const top = s.players.filter((p) => p.rank === 1);
  const title = top.length > 1 ? 'Joint winners!' : `${top[0]?.name ?? 'Nobody'} wins!`;
  const [p1, p2, p3] = s.players;
  const step = (p, cls, n) => p ? `<div class="step ${cls}"><span>${esc(p.name)}</span><span class="pts">${p.score} pts</span><div class="block">${p.rank}</div></div>` : `<div class="step ${cls}"></div>`;
  return `
    ${header('Game over')}
    <h1 class="display lg center">${esc(title)}</h1>
    <div class="podium">${step(p2, 'p2')}${step(p1, 'p1')}${step(p3, 'p3')}</div>
    <hr class="rule">
    ${board(s, { gains: false })}
    <div class="spacer"></div>
    ${s.me.isHost
      ? `<button class="btn block" data-action="play-again">↻ Play again</button>`
      : `<button class="btn block waiting" disabled>Waiting for host…</button>`}
    ${leaveButton()}`;
}

// ---------- timers (no full re-render) ----------
function tick() {
  $app.querySelectorAll('[data-until]').forEach((el) => {
    const left = secsLeft(Number(el.dataset.until));
    el.textContent = left;
    if (el.dataset.low) el.classList.toggle('low', left <= Number(el.dataset.low));
  });
  $app.querySelectorAll('[data-bar-from]').forEach((el) => {
    const from = Number(el.dataset.barFrom);
    const to = Number(el.dataset.barTo);
    el.style.width = `${Math.max(0, Math.min(1, (to - now()) / (to - from))) * 100}%`;
  });
  $app.querySelectorAll('[data-hide-at]').forEach((el) => {
    if (now() >= Number(el.dataset.hideAt)) el.style.visibility = 'hidden';
  });
}
setInterval(() => { tick(); heartbeat(); }, 150);

// ---------- events ----------
$app.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const a = el.dataset.action;
  if (a !== 'leave') ui.leaveArmed = false;
  switch (a) {
    case 'go-create': ui.view = 'create'; ui.error = ''; return render();
    case 'go-join': ui.view = 'join'; ui.error = ''; ui.prefillCode = ''; return render();
    case 'go-home': ui.view = 'home'; ui.prefillCode = ''; return render();
    case 'share': {
      const url = shareUrl(ui.state.code);
      const text = `Join my Chaotic Party game! Room ${ui.state.code}: ${url}`;
      try {
        if (navigator.share) await navigator.share({ title: 'Chaotic Party', text });
        else { await navigator.clipboard.writeText(url); toast('Invite link copied'); }
      } catch (err) {
        if (err && err.name === 'AbortError') return;
        try { await navigator.clipboard.writeText(url); toast('Invite link copied'); } catch { toast(url); }
      }
      return;
    }
    case 'copy-link': {
      const url = shareUrl(ui.state.code);
      try { await navigator.clipboard.writeText(url); toast('Invite link copied'); } catch { toast(url); }
      return;
    }
    case 'other-room': ui.prefillCode = ''; ui.error = ''; return render();
    case 'start': return act('start');
    case 'next': return act('next');
    case 'skip': return act('skip');
    case 'play-again': return act('playAgain');
    case 'done': vibrate(30); return act('done');
    case 'buzz': vibrate(30); return act('buzz');
    case 'say-yes': return act('sayResult', { correct: true });
    case 'say-no': return act('sayResult', { correct: false });
    case 'group-start': ui.picking = true; return render();
    case 'group-cancel': ui.picking = false; ui.picked = new Set(); return render();
    case 'pick': {
      const id = el.dataset.id;
      const need = ui.state.round.challenge.groupSize - 1;
      if (ui.picked.has(id)) ui.picked.delete(id);
      else if (ui.picked.size < need) ui.picked.add(id);
      else if (need === 1) ui.picked = new Set([id]);
      return render();
    }
    case 'group-confirm': return act('groupDone', { partnerIds: [...ui.picked] });
    case 'leave':
      if (!ui.leaveArmed) { ui.leaveArmed = true; render(); setTimeout(() => { ui.leaveArmed = false; render(); }, 3000); return; }
      ui.leaveArmed = false;
      {
        const code = ui.session.code;
        disconnect();
        await run(code, { type: 'leave' }).catch(() => {});
      }
      return endSession();
  }
});

$app.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const kind = form.dataset.form;
  const name = form.querySelector('#name').value.trim();
  let code = form.querySelector('#code')?.value.trim().toUpperCase();
  if (!name) { ui.error = 'Please enter a name'; return render(); }
  if (kind === 'join' && !/^[A-Z]{4}$/.test(code || '')) { ui.error = 'Room codes are 4 letters'; return render(); }
  if (!backend) { ui.error = 'Still connecting… try again in a moment'; return render(); }
  ui.busy = true; ui.error = ''; render();
  try {
    if (kind === 'create') {
      for (let tries = 0; ; tries++) {
        code = Array.from({ length: 4 }, () => CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)]).join('');
        try { await run(code, { type: 'create', code, name }); break; }
        catch (err) { if (err.code !== 'code_taken' || tries > 10) throw err; }
      }
    } else {
      await run(code, { type: 'join', name });
    }
    rememberName(name);
    saveSession({ code });
    ui.view = 'game';
    ui.state = null;
    history.replaceState(null, '', location.pathname + (MOCK ? '?mock=1' : ''));
    connect(code);
  } catch (err) {
    ui.error = err.message || 'Could not connect. Check your internet and try again';
  } finally {
    ui.busy = false;
    render();
  }
});

$app.addEventListener('input', (e) => {
  if (e.target.id === 'code') e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
});

// ---------- boot ----------
(async function boot() {
  const code = (params.get('room') || '').toUpperCase();
  if (/^[A-Z]{4}$/.test(code)) ui.prefillCode = code;
  ui.view = ui.prefillCode ? 'join' : 'home';
  render();
  try {
    const [mod, list] = await Promise.all([
      MOCK ? import('./backend-mock.js?v=0.5.0') : import('./backend-firebase.js?v=0.5.0'),
      fetch(`challenges.json?v=${Date.now()}`, { cache: 'no-store' }).then((r) => r.json()),
    ]);
    challenges = list.challenges;
    challengeMap = new Map(challenges.map((c) => [c.id, c]));
    backend = await mod.createBackend();
  } catch (e) {
    console.error(e);
    toast('Could not reach the game server. Check your internet and reload.');
    return;
  }
  let seenOnline = false;
  backend.onConnection((online) => {
    if (online) seenOnline = true;
    $banner.hidden = online || !seenOnline;
  });
  const saved = loadSession();
  if (saved && (!ui.prefillCode || ui.prefillCode === saved.code)) {
    ui.session = saved;
    ui.view = 'game';
    render();
    connect(saved.code);
  }
})();
