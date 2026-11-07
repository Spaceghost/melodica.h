// melodica-web: the link to the melodica extension. When the extension's content
// script answers on this page, the extension's background player is the only player:
// the page is a view of it and a remote for it, and plays nothing itself. Without an
// extension (or with one too old to be a remote) the page plays on its own through
// the relay. Same-window postMessage only: no network permission, no CSP change.
// Works in browsers and in Node with a fake window (tests).
//
// Protocol (every message carries melodica: 1 and is posted to location.origin;
// melodica-extension's docs/BRIDGE.md):
//   page -> script   {type: 'hello'}                              repeated until ready (HELLO_WINDOW_MS)
//   script -> page   {type: 'ready', name, version, player}       answer, or unsolicited at any time
//   page -> script   {type: 'subscribe'}                          repeated until the first state
//   script -> page   {type: 'state', state}                       on every change
//   page -> script   {type: 'command', id, action, ...fields}     play, pause, resume, toggle, next, love,
//                                                                 ban, tired, stop, volume, quality, stations,
//                                                                 open-login
//   script -> page   {type: 'result', id, ok, error, state}
//   page -> script   {type: 'unsubscribe'}
// Only messages with event.source === window and event.origin === location.origin
// are accepted. `ready` without `player: true` (extension before 0.3.0) is not a
// remote; the page then ignores the extension and uses the relay.

export const HELLO_WINDOW_MS = 3_000;
export const HELLO_EVERY_MS = 250;
export const SUBSCRIBE_EVERY_MS = 1_000;
export const COMMAND_TIMEOUT_MS = 10_000;

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
    this.log = options.log || (() => {});
    this.helloWindow = options.helloWindow === undefined ? HELLO_WINDOW_MS : options.helloWindow;
    this.helloEvery = options.helloEvery || HELLO_EVERY_MS;
    this.subscribeEvery = options.subscribeEvery || SUBSCRIBE_EVERY_MS;
    this.active = false;      // a content script said ready
    this.name = '';
    this.version = '';
    this.player = false;      // ready said player: true (the extension is a remote-controllable player)
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
    try { this.win.postMessage({ melodica: 1, ...msg }, this.origin); return true; } catch (_) { return false; }
  }

  // Listen, and say hello every `helloEvery` ms until ready or `helloWindow` ms have
  // passed (a content script injected at document_idle may miss the first one; it
  // also announces itself, which is accepted at any time).
  start() {
    this.win.addEventListener('message', this.onMessage);
    this.post({ type: 'hello' });
    const t0 = Date.now();
    const again = () => {
      if (this.active || Date.now() - t0 >= this.helloWindow) return;
      this.post({ type: 'hello' });
      this.timers.push(setTimeout(again, this.helloEvery));
    };
    this.timers.push(setTimeout(again, this.helloEvery));
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
    if (d.type === 'ready') {
      const name = typeof d.name === 'string' && d.name.trim() ? d.name.trim() : 'melodica extension';
      const version = typeof d.version === 'string' ? d.version.trim() : '';
      const player = d.player === true;
      const changed = !this.active || name !== this.name || version !== this.version || player !== this.player;
      this.active = true;
      this.name = name;
      this.version = version;
      this.player = player;
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
    if (d.type === 'result' && typeof d.id === 'string' && this.pending.has(d.id)) {
      const p = this.pending.get(d.id);
      this.pending.delete(d.id);
      clearTimeout(p.timer);
      p.resolve({
        ok: d.ok === true,
        error: d.error === undefined || d.error === null ? '' : String(d.error),
        state: d.state && typeof d.state === 'object' ? d.state : null,
      });
    }
  }

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
