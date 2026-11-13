// HTTP server: static files, room API, Server-Sent Events. No dependencies.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from './config.js';
import { Room, GameError } from './engine.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const { challenges } = JSON.parse(readFileSync(path.join(root, 'challenges.json'), 'utf8'));

const rooms = new Map(); // code -> Room
const streams = new Map(); // `${code}:${playerId}` -> Set<res>

const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function newCode() {
  for (let tries = 0; tries < 1000; tries++) {
    let code = '';
    for (let i = 0; i < 4; i++) code += CODE_LETTERS[randomInt(CODE_LETTERS.length)];
    if (!rooms.has(code)) return code;
  }
  throw new GameError('busy', 'Server busy, try again');
}

function broadcast(room) {
  for (const p of room.players.values()) {
    const set = streams.get(`${room.code}:${p.id}`);
    if (!set) continue;
    const data = `event: state\ndata: ${JSON.stringify(room.snapshot(p.id))}\n\n`;
    for (const res of set) res.write(data);
  }
}

function createRoom() {
  const code = newCode();
  const room = new Room(code, challenges, { config, onChange: broadcast });
  rooms.set(code, room);
  return room;
}

// ---------- helpers ----------
function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function sendError(res, err) {
  if (err instanceof GameError) return send(res, 400, { ok: false, error: err.code, message: err.message });
  console.error(err);
  return send(res, 500, { ok: false, error: 'server_error', message: 'Something went wrong' });
}
async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 10_000) throw new GameError('too_large', 'Request too large');
  }
  try { return body ? JSON.parse(body) : {}; } catch { throw new GameError('bad_json', 'Bad request'); }
}
function findRoom(code) {
  const room = rooms.get(String(code || '').trim().toUpperCase());
  if (!room) throw new GameError('room_not_found', 'Room not found');
  return room;
}
function auth(code, token) {
  const room = findRoom(code);
  const player = room.playerByToken(token);
  if (!player) throw new GameError('not_in_room', 'You are not in this room');
  return { room, player };
}

// Simple per-IP limit on room creation.
const createLog = new Map();
function rateLimit(ip) {
  const now = Date.now();
  const recent = (createLog.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (recent.length >= 20) throw new GameError('rate_limited', 'Too many rooms created. Try again later');
  recent.push(now);
  createLog.set(ip, recent);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
  const file = path.normalize(path.join(publicDir, rel));
  if (!file.startsWith(publicDir + path.sep)) { res.writeHead(403); return res.end(); }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    // Unknown paths (e.g. /KBZW join links) get the app.
    const html = await readFile(path.join(publicDir, 'index.html'));
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
    res.end(html);
  }
}

// ---------- routes ----------
const ACTIONS = {
  start: (room, p) => room.start(p.id),
  next: (room, p) => room.next(p.id),
  skip: (room, p) => room.skip(p.id),
  playAgain: (room, p) => room.playAgain(p.id),
  done: (room, p) => room.done(p.id),
  groupDone: (room, p, body) => room.groupDone(p.id, body.partnerIds),
  buzz: (room, p) => room.buzz(p.id),
  sayResult: (room, p, body) => room.sayResult(p.id, body.correct),
  leave: (room, p) => room.leave(p.id),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const { pathname } = url;
  try {
    if (req.method === 'POST' && pathname === '/api/rooms') {
      rateLimit(req.socket.remoteAddress);
      const body = await readJson(req);
      const room = createRoom();
      try {
        const p = room.addPlayer(body.name);
        return send(res, 200, { ok: true, code: room.code, playerId: p.id, token: p.token });
      } catch (e) {
        rooms.delete(room.code);
        throw e;
      }
    }

    const join = pathname.match(/^\/api\/rooms\/([A-Za-z]{4})\/join$/);
    if (req.method === 'POST' && join) {
      const body = await readJson(req);
      const room = findRoom(join[1]);
      const p = room.addPlayer(body.name);
      return send(res, 200, { ok: true, code: room.code, playerId: p.id, token: p.token });
    }

    if (req.method === 'GET' && pathname === '/api/session') {
      const { room, player } = auth(url.searchParams.get('code'), url.searchParams.get('token'));
      return send(res, 200, { ok: true, code: room.code, playerId: player.id });
    }

    if (req.method === 'GET' && pathname === '/api/events') {
      const { room, player } = auth(url.searchParams.get('code'), url.searchParams.get('token'));
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 1500\n\n');
      const key = `${room.code}:${player.id}`;
      if (!streams.has(key)) streams.set(key, new Set());
      streams.get(key).add(res);
      room.setConnected(player.id, true);
      res.write(`event: state\ndata: ${JSON.stringify(room.snapshot(player.id))}\n\n`);
      req.on('close', () => {
        const set = streams.get(key);
        if (!set) return;
        set.delete(res);
        if (set.size === 0) {
          streams.delete(key);
          if (rooms.get(room.code) === room) room.setConnected(player.id, false);
        }
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/action') {
      const body = await readJson(req);
      const { room, player } = auth(body.code, body.token);
      const fn = ACTIONS[body.type];
      if (!fn) throw new GameError('bad_action', 'Unknown action');
      fn(room, player, body);
      return send(res, 200, { ok: true });
    }

    if (pathname === '/healthz') return send(res, 200, { ok: true, rooms: rooms.size });
    if (req.method === 'GET') return serveStatic(req, res, pathname);
    res.writeHead(404);
    res.end();
  } catch (err) {
    sendError(res, err);
  }
});

// Heartbeat keeps proxies from closing idle streams.
setInterval(() => {
  for (const set of streams.values()) for (const res of set) res.write(': ping\n\n');
}, 15000).unref();

// Clean up idle / old rooms.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const idle = room.connectedPlayers().length === 0 && now - room.lastActivityAt > config.roomIdleMs;
    if (idle || now - room.createdAt > config.roomMaxAgeMs) {
      room.destroy();
      rooms.delete(code);
      for (const key of streams.keys()) if (key.startsWith(code + ':')) {
        for (const res of streams.get(key)) res.end();
        streams.delete(key);
      }
    }
  }
}, 60_000).unref();

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => {
  console.log(`Chaotic Party running on http://localhost:${PORT}`);
});
