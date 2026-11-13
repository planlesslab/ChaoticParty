// Offline stand-in for Firebase, for testing in one browser with several tabs.
// Open the game with ?mock=1 in each tab. Not used in normal play.
const KEY = (code) => `cp_mock_room_${code}`;

export async function createBackend() {
  let uid = sessionStorage.getItem('cp_mock_uid');
  if (!uid) {
    uid = 'mock_' + Math.random().toString(36).slice(2, 10);
    sessionStorage.setItem('cp_mock_uid', uid);
  }
  const channel = new BroadcastChannel('cp_mock');
  const listeners = new Map(); // code -> Set<cb>

  const read = (code) => {
    const s = localStorage.getItem(KEY(code));
    return s ? JSON.parse(s) : null;
  };
  const notify = (code) => {
    const v = read(code);
    (listeners.get(code) || new Set()).forEach((cb) => cb(v));
  };
  channel.onmessage = (e) => notify(e.data);
  const write = (code, value) => {
    if (value === null) localStorage.removeItem(KEY(code));
    else localStorage.setItem(KEY(code), JSON.stringify(value));
    notify(code);
    channel.postMessage(code);
  };

  return {
    uid,
    now: () => Date.now(),
    watch(code, cb) {
      if (!listeners.has(code)) listeners.set(code, new Set());
      listeners.get(code).add(cb);
      setTimeout(() => cb(read(code)), 0);
      return () => listeners.get(code).delete(cb);
    },
    async transact(code, fn) {
      const cur = read(code);
      const next = fn(cur);
      if (next === undefined) return { committed: false, value: cur };
      write(code, next);
      return { committed: true, value: next };
    },
    presence(code) {
      const set = (connected) => {
        const r = read(code);
        if (!r || !r.players || !r.players[uid]) return;
        r.players[uid].connected = connected;
        if (!connected) r.players[uid].disconnectedAt = Date.now();
        write(code, r);
      };
      set(true);
      const bye = () => set(false);
      addEventListener('pagehide', bye);
      return async () => removeEventListener('pagehide', bye);
    },
    onConnection(cb) { cb(true); return () => {}; },
  };
}
