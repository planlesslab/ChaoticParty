// Firebase backend: anonymous sign-in + Realtime Database.
// The rest of the app only talks to the small interface returned here.
import { firebaseConfig, FIREBASE_SDK_VERSION as V } from './firebase-config.js?v=0.4.0';

const CDN = `https://www.gstatic.com/firebasejs/${V}`;

export async function createBackend() {
  const [{ initializeApp }, A, D] = await Promise.all([
    import(`${CDN}/firebase-app.js`),
    import(`${CDN}/firebase-auth.js`),
    import(`${CDN}/firebase-database.js`),
  ]);

  const app = initializeApp(firebaseConfig);
  const auth = A.getAuth(app);
  const db = D.getDatabase(app);

  // Reuse this phone's anonymous identity if it has one.
  const user = await new Promise((resolve, reject) => {
    const off = A.onAuthStateChanged(auth, (u) => {
      off();
      if (u) resolve(u);
      else A.signInAnonymously(auth).then((c) => resolve(c.user), reject);
    }, reject);
  });
  const uid = user.uid;

  let offset = 0;
  D.onValue(D.ref(db, '.info/serverTimeOffset'), (s) => { offset = s.val() || 0; });

  const roomRef = (code) => D.ref(db, `rooms/${code}`);

  return {
    uid,
    /** Current time on the database's clock (ms). */
    now: () => Date.now() + offset,

    /** Live room updates. Returns an unsubscribe function. */
    watch(code, cb) {
      return D.onValue(roomRef(code), (s) => cb(s.val()), () => cb(null));
    },

    /** Atomic read-modify-write. fn(current) returns the new value, or undefined to abort. */
    async transact(code, fn) {
      const res = await D.runTransaction(roomRef(code), fn);
      return { committed: res.committed, value: res.snapshot.val() };
    },

    /** Mark this player online, and offline automatically if the connection drops. */
    presence(code) {
      const pRef = D.ref(db, `rooms/${code}/players/${uid}`);
      const off = D.onValue(D.ref(db, '.info/connected'), async (s) => {
        if (!s.val()) return;
        try {
          await D.onDisconnect(pRef).update({ connected: false, disconnectedAt: D.serverTimestamp() });
          await D.runTransaction(pRef, (p) => (p && p.name ? { ...p, connected: true } : undefined));
        } catch (e) { console.warn('presence', e); }
      });
      return async () => {
        off();
        try { await D.onDisconnect(pRef).cancel(); } catch {}
      };
    },

    /** Calls cb(true/false) as the connection to the database comes and goes. */
    onConnection(cb) {
      return D.onValue(D.ref(db, '.info/connected'), (s) => cb(!!s.val()));
    },
  };
}
