// melodica-web: the link to the melodica extension. When the extension's content
// script answers on this page, the extension's background player is the only player:
// the page is a view of it and a remote for it, and plays nothing itself. Without an
// extension (or with one too old to be a remote) the page plays on its own through
// the relay. Same-window postMessage only: no network permission, no CSP change.
// Works in browsers and in Node with a fake window (tests).
//
// Protocol (every message carries melodica: 1 and is posted to location.origin;
// melodica-extension's docs/BRIDGE.md):
//   page -> script   {type: 'hello'}                              repeated until ready (HELLO_WINDOW_MS,
//                                                                 every 250 ms, backing off to 1 s)
//   script -> page   {type: 'present'}                            optional: the content script is there and
//                                                                 its background is waking (remote pending)
//   script -> page   {type: 'ready', name, version, player}       answer, or unsolicited at any time
//   page -> script   {type: 'subscribe'}                          repeated until the first state
//   script -> page   {type: 'state', state}                       on every change
//   page -> script   {type: 'command', id, action, ...fields}     play, pause, resume, toggle, next, love,
//                                                                 ban, tired, stop, volume, quality, stations,
//                                                                 open-login
//   script -> page   {type: 'result', id, ok, error, state}
//   page -> script   {type: 'unsubscribe'}
//   page -> script   {type: 'session-get', id}                    session layer (ready says session: 1;
//   script -> page   {type: 'session', id?, session, credential,  docs/BRIDGE.md 4): answer, and pushed
//                     account, revoked}                           on every change
//   page -> script   {type: 'session-offer', id, session, credential?, account?}
//   page -> script   {type: 'session-logout', id, sid}           both answered with a result {outcome}
//   page -> script   {type: 'account-signout', id}               spacegho.st sign-out (4.6), answered with a result
//   script -> page   {type: 'account-signout'}                   the extension signed out of spacegho.st
// The page talks only on https://spacegho.st/melodica/ (and on localhost for the
// tests): messages go to that exact origin, never '*', and only messages with
// event.source === window and that exact event.origin are accepted. `ready` without `player: true` (extension before 0.3.0) is not a
// remote; the page then ignores the extension and uses the relay.

// Long enough for a cold extension service worker to wake (docs/BRIDGE.md 1).
export const HELLO_WINDOW_MS = 5_000;
export const HELLO_MAX_EVERY_MS = 1_000;
export const HELLO_EVERY_MS = 250;
export const SUBSCRIBE_EVERY_MS = 1_000;
export const COMMAND_TIMEOUT_MS = 10_000;
export const SESSION_TIMEOUT_MS = 20_000;
export const BRIDGE_ORIGIN = 'https://spacegho.st';
export const BRIDGE_PATH = '/melodica/'; // every route of the shell (0.11.0)

// Whether this page may speak to the extension at all: the production origin and path
// exactly, or a local test server.
export function bridgeAllowed(loc) {
  if (!loc || !String(loc.pathname || '').startsWith(BRIDGE_PATH)) return false;
  if (loc.origin === BRIDGE_ORIGIN) return true;
  return loc.protocol === 'http:' && (loc.hostname === 'localhost' || loc.hostname === '127.0.0.1');
}

export class BridgeError extends Error {
  constructor(message, kind = 'bridge') {
    super(message);
    this.name = 'BridgeError';
    this.kind = kind;
  }
}

export class BridgeTransport {
  constructor(win, options = {}) {
    this.win = win;
    this.origin = options.origin || win.location.origin;
    this.onChange = options.onChange || (() => {});
    this.onSession = options.onSession || (() => {}); // unsolicited {session, credential, account, revoked}
    this.onRoomClock = options.onRoomClock || (() => {}); // lightweight room playback clock; never a player state
    this.onAccountSignout = options.onAccountSignout || (() => {}); // the extension signed out of spacegho.st
    this.log = options.log || (() => {});
    this.helloWindow = options.helloWindow === undefined ? HELLO_WINDOW_MS : options.helloWindow;
    this.helloEvery = options.helloEvery || HELLO_EVERY_MS;
    this.subscribeEvery = options.subscribeEvery || SUBSCRIBE_EVERY_MS;
    this.active = false;      // a content script said ready
    this.present = false;     // a content script said present or ready (remote pending until ready)
    this.name = '';
    this.version = '';
    this.player = false;      // ready said player: true (the extension is a remote-controllable player)
    this.rooms = 0;
    this.session = 0;         // ready said session: 1 (docs/BRIDGE.md 4)
    this.onState = null;      // set while subscribed
    this.gotState = false;
    this.pending = new Map();
    this.seq = 0;
    this.timers = [];
    this.onMessage = this.onMessage.bind(this);
  }

  // "melodica extension 0.5.0" once ready, '' before.
  get label() { return this.active ? `${this.name} ${this.version}`.trim() : ''; }

  post(msg) {
    if (!this.origin || this.origin === '*') return false;
    try { this.win.postMessage({ melodica: 1, ...msg }, this.origin); return true; } catch (_) { return false; }
  }

  // Listen, and say hello every `helloEvery` ms until ready or `helloWindow` ms have
  // passed (a content script injected at document_idle may miss the first one; it
  // also announces itself, which is accepted at any time).
  start() {
    this.win.addEventListener('message', this.onMessage);
    this.post({ type: 'hello' });
    const t0 = Date.now();
    // Every helloEvery ms for the first second, then backing off to HELLO_MAX_EVERY_MS.
    let every = this.helloEvery;
    const again = () => {
      if (this.active || Date.now() - t0 >= this.helloWindow) return;
      this.post({ type: 'hello' });
      if (Date.now() - t0 >= 1000) every = Math.min(every * 2, Math.max(this.helloEvery, HELLO_MAX_EVERY_MS));
      this.timers.push(setTimeout(again, every));
    };
    this.timers.push(setTimeout(again, every));
    return this;
  }

  // Resolves true once a remote-capable extension is ready, false after `ms`
  // (it may still appear later; onChange reports that).
  waitReady(ms = this.helloWindow) {
    if (this.active && this.player) return Promise.resolve(true);
    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        if (this.active && this.player) return resolve(true);
        if (Date.now() - t0 >= ms) return resolve(false);
        this.timers.push(setTimeout(tick, 25));
      };
      tick();
    });
  }

  stop() {
    this.win.removeEventListener('message', this.onMessage);
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new BridgeError(`bridge stopped while command ${id} was pending`));
    }
    this.pending.clear();
    this.active = false;
  }

  onMessage(event) {
    if (event.source !== this.win || event.origin !== this.origin) return;
    const d = event.data;
    if (!d || d.melodica !== 1 || typeof d.type !== 'string') return;
    if (d.type === 'gone') {
      this.active = this.present = this.player = false;
      this.gone = true;
      this.onChange(this);
      return;
    }
    if (d.type === 'present') {
      if (!this.present) {
        this.present = true;
        this.log('bridge: extension present, waiting for ready');
        this.onChange(this);
      }
      return;
    }
    if (d.type === 'ready') {
      this.gone = false;
      this.present = true;
      const name = typeof d.name === 'string' && d.name.trim() ? d.name.trim() : 'melodica extension';
      const version = typeof d.version === 'string' ? d.version.trim() : '';
      const player = d.player === true;
      const session = d.session === 1 ? 1 : 0;
      const rooms = d.rooms === 1 ? 1 : 0;
      const changed = !this.active || name !== this.name || version !== this.version || player !== this.player || session !== this.session || rooms !== this.rooms;
      this.active = true;
      this.name = name;
      this.version = version;
      this.player = player;
      this.session = session;
      this.rooms = rooms;
      if (changed) {
        this.log(`bridge ready: ${this.label}${player ? '' : ' (no remote control)'}`);
        this.onChange(this);
      }
      return;
    }
    if (d.type === 'state') {
      if (this.onState && d.state && typeof d.state === 'object') {
        this.gotState = true;
        this.onState(d.state);
      }
      return;
    }
    if (d.type === 'room-clock') {
      const room = d.room;
      if (this.active && this.player && this.rooms === 1 && room && typeof room === 'object' && !Array.isArray(room) &&
        typeof room.id === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(room.id) &&
        room.state && typeof room.state === 'object' && !Array.isArray(room.state) &&
        d.state && typeof d.state === 'object' && !Array.isArray(d.state)) {
        this.onRoomClock({ melodica: 1, type: 'room-clock', room: d.room, state: d.state });
      }
      return;
    }
    if (d.type === 'account-signout' && (d.id === undefined || d.id === null)) {
      if (this.session) this.onAccountSignout();
      return;
    }
    if (d.type === 'session') {
      const msg = sessionMessage(d);
      if (typeof d.id === 'string' && this.pending.has(d.id)) this.settle(d.id, msg);
      else if (d.id === undefined || d.id === null) this.onSession(msg);
      return;
    }
    if (d.type === 'result' && typeof d.id === 'string' && this.pending.has(d.id)) {
      this.settle(d.id, {
        ok: d.ok === true,
        error: d.error === undefined || d.error === null ? '' : String(d.error),
        state: d.state && typeof d.state === 'object' ? d.state : null,
        outcome: typeof d.outcome === 'string' ? d.outcome : '',
        ...('room' in d ? { room: d.room && typeof d.room === 'object' && !Array.isArray(d.room) ? d.room : null } : {}),
        ...('result' in d ? { result: d.result } : {}),
        ...(Number.isInteger(d.status) ? { status: d.status } : {}),
        ...(Array.isArray(d.rooms) ? { rooms: d.rooms } : {}),
        ...(Array.isArray(d.recent) ? { recent: d.recent } : {}),
        ...('next_cursor' in d ? { next_cursor: typeof d.next_cursor === 'string' ? d.next_cursor : null } : {}),
        ...(Array.isArray(d.recentRoomIds) ? { recentRoomIds: d.recentRoomIds.filter((id) => typeof id === 'string') } : {}),
        ...(d.playback && typeof d.playback === 'object' ? { playback: d.playback } : {}),
        ...('copy' in d ? { copy: d.copy && typeof d.copy === 'object' ? d.copy : null } : {}),
      });
    }
  }

  settle(id, value) {
    const p = this.pending.get(id);
    this.pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(value);
  }

  // One request of the session layer; resolves with the answer, rejects on timeout.
  ask(type, fields = {}, timeout = SESSION_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const id = this.newId();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError(`the ${this.label || 'extension'} did not answer "${type}" within ${timeout} ms`, 'timeout'));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.post({ ...fields, type, id })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new BridgeError('could not post to the extension'));
      }
    });
  }
  sessionGet() { return this.ask('session-get'); }
  sessionOffer(fields) { return this.ask('session-offer', fields); }
  sessionLogout(sid) { return this.ask('session-logout', { sid: String(sid || '') }); }
  accountSignout() { return this.ask('account-signout'); }

  newId() {
    this.seq += 1;
    const c = globalThis.crypto;
    const rand = c && typeof c.randomUUID === 'function' ? c.randomUUID() : Math.random().toString(36).slice(2);
    return `mw-${this.seq}-${rand}`;
  }

  // Every pushed state goes to onState. No timeout: the subscribe is repeated every
  // `subscribeEvery` ms until the first state arrives (the extension's service worker
  // may need a while to start), then the extension pushes each change.
  subscribe(onState) {
    this.onState = onState;
    this.gotState = false;
    this.post({ type: 'subscribe' });
    const again = () => {
      if (!this.onState || this.gotState) return;
      this.post({ type: 'subscribe' });
      this.timers.push(setTimeout(again, this.subscribeEvery));
    };
    this.timers.push(setTimeout(again, this.subscribeEvery));
  }

  unsubscribe() {
    if (!this.onState) return;
    this.onState = null;
    this.post({ type: 'unsubscribe' });
  }

  // One remote command; resolves with {ok, error, state}, rejects with BridgeError on timeout.
  command(action, fields = {}, timeout = COMMAND_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const id = this.newId();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError(`the ${this.label || 'extension'} did not answer "${action}" within ${timeout} ms`, 'timeout'));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.post({ ...fields, type: 'command', id, action })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new BridgeError('could not post to the extension'));
      }
    });
  }
}

// A session message, checked field by field (docs/BRIDGE.md 4.1); anything malformed is null.
const str = (v) => (typeof v === 'string' ? v : '');
export function sessionMessage(d) {
  const s = d && d.session;
  let session = null;
  if (s && typeof s === 'object' && s.partner && s.user && str(s.sid) && str(s.partner.authToken) && str(s.user.authToken) && str(s.user.id)) {
    session = {
      sid: str(s.sid), email: str(s.email),
      partner: { authToken: str(s.partner.authToken), id: Number(s.partner.id) | 0 },
      user: { authToken: str(s.user.authToken), id: str(s.user.id) },
      syncOffset: Number(s.syncOffset) | 0,
      createdAt: Number(s.createdAt) || 0,
    };
  }
  const c = d && d.credential;
  const credential = c && typeof c === 'object' && str(c.email) && str(c.password) ? { email: str(c.email), password: str(c.password) } : null;
  const a = d && d.account;
  const account = a && typeof a === 'object'
    ? { signedIn: a.signedIn === true, username: str(a.username), github: str(a.github) || null } : null;
  const revoked = Array.isArray(d && d.revoked) ? d.revoked.filter((x) => typeof x === 'string').slice(-8) : [];
  const access = typeof (d && d.access) === 'string' && d.access.length < 4096 ? d.access : null;
  return { session, credential, account, revoked, access };
}
