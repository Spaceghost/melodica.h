// melodica-web: the extension bridge. A WebExtension content script running on
// the page can offer a direct path to tuner.pandora.com; this module speaks to
// it over same-window postMessage, so it needs no network permission and no
// CSP change. Works in browsers and in Node with a fake window (tests).
//
// Protocol (every message carries melodica: 1 and is posted to location.origin):
//   page -> script   {type: 'hello'}                              on startup
//   script -> page   {type: 'ready', name, version}               answer, or unsolicited
//   page -> script   {type: 'request', id, search, body}          search '?method=…', body Uint8Array
//   script -> page   {type: 'response', id, ok, status, body, error}
// Only messages with event.source === window and event.origin === location.origin
// are accepted. A request that gets no response within `timeout` ms fails with a
// BridgeError, and the caller falls back to the relay for that request.
//
// Remote control (extension 0.3.0+, `player: true` in ready; melodica-extension's
// docs/BRIDGE.md): the extension plays in the background and the page is a view of it.
//   page -> script   {type: 'subscribe'}                          answered with a state at once
//   script -> page   {type: 'state', state}                       on every change
//   page -> script   {type: 'command', id, action, ...fields}     play, pause, toggle, next, love,
//                                                                 ban, tired, stop, volume, quality, stations
//   script -> page   {type: 'result', id, ok, error, state}
//   page -> script   {type: 'unsubscribe'}

export const BRIDGE_TIMEOUT_MS = 20_000;
export const SUBSCRIBE_TIMEOUT_MS = 1_000;
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
    this.timeout = options.timeout === undefined ? BRIDGE_TIMEOUT_MS : options.timeout;
    this.onChange = options.onChange || (() => {});
    this.log = options.log || (() => {});
    this.active = false;
    this.name = '';
    this.version = '';
    this.player = false;      // ready said player: true (remote control exists)
    this.onState = null;      // set while subscribed
    this.pending = new Map();
    this.seq = 0;
    this.onMessage = this.onMessage.bind(this);
  }

  // "melodica extension 0.1.0" once ready, '' before.
  get label() { return this.active ? `${this.name} ${this.version}`.trim() : ''; }

  start() {
    this.win.addEventListener('message', this.onMessage);
    this.win.postMessage({ melodica: 1, type: 'hello' }, this.origin);
    return this;
  }

  stop() {
    this.win.removeEventListener('message', this.onMessage);
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new BridgeError(`bridge stopped while request ${id} was pending`));
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
      const changed = !this.active || name !== this.name || version !== this.version;
      this.active = true;
      this.name = name;
      this.version = version;
      this.player = d.player === true;
      if (changed) {
        this.log(`bridge ready: ${this.label}`);
        this.onChange(this);
      }
      return;
    }
    if (d.type === 'state') {
      if (this.onState && d.state && typeof d.state === 'object') this.onState(d.state);
      return;
    }
    if (d.type === 'result' && typeof d.id === 'string' && this.pending.has(d.id) && this.pending.get(d.id).kind === 'command') {
      const p = this.pending.get(d.id);
      this.pending.delete(d.id);
      clearTimeout(p.timer);
      p.resolve({
        ok: d.ok === true,
        error: d.error === undefined || d.error === null ? '' : String(d.error),
        state: d.state && typeof d.state === 'object' ? d.state : null,
      });
      return;
    }
    if (d.type === 'response' && typeof d.id === 'string' && this.pending.has(d.id) && this.pending.get(d.id).kind === 'request') {
      const p = this.pending.get(d.id);
      this.pending.delete(d.id);
      clearTimeout(p.timer);
      p.resolve({
        ok: d.ok === true,
        status: Number.isFinite(Number(d.status)) ? Number(d.status) : 0,
        body: d.body,
        error: d.error === undefined || d.error === null ? '' : String(d.error),
      });
    }
  }

  newId() {
    this.seq += 1;
    const c = globalThis.crypto;
    const rand = c && typeof c.randomUUID === 'function' ? c.randomUUID() : Math.random().toString(36).slice(2);
    return `mw-${this.seq}-${rand}`;
  }

  // Resolves with {ok, status, body, error}; rejects with BridgeError on
  // timeout or when posting fails.
  request(search, body) {
    return new Promise((resolve, reject) => {
      const id = this.newId();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError(`no response from the ${this.label || 'extension'} within ${this.timeout} ms`, 'timeout'));
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer, kind: 'request' });
      try {
        this.win.postMessage({ melodica: 1, type: 'request', id, search, body }, this.origin);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new BridgeError(`could not post to the extension: ${err && err.message ? err.message : err}`));
      }
    });
  }
}

// Remote control: subscribe and resolve with the first state, or null when none
// arrives within `timeout` ms (an extension older than 0.3.0 ignores subscribe; the
// page then plays locally). `onState` receives every later state.
BridgeTransport.prototype.subscribe = function subscribe(onState, timeout = SUBSCRIBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let first = true;
    const timer = setTimeout(() => {
      if (!first) return;
      first = false;
      this.unsubscribe();
      resolve(null);
    }, timeout);
    this.onState = (st) => {
      if (first) {
        first = false;
        clearTimeout(timer);
        resolve(st);
        return;
      }
      onState(st);
    };
    try {
      this.win.postMessage({ melodica: 1, type: 'subscribe' }, this.origin);
    } catch (_) {
      clearTimeout(timer);
      first = false;
      this.onState = null;
      resolve(null);
    }
  });
};

BridgeTransport.prototype.unsubscribe = function unsubscribe() {
  if (!this.onState) return;
  this.onState = null;
  try { this.win.postMessage({ melodica: 1, type: 'unsubscribe' }, this.origin); } catch (_) { /* gone */ }
};

// One remote command; resolves with {ok, error, state}, rejects with BridgeError on timeout.
BridgeTransport.prototype.command = function command(action, fields = {}, timeout = COMMAND_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const id = this.newId();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      reject(new BridgeError(`the ${this.label || 'extension'} did not answer "${action}" within ${timeout} ms`, 'timeout'));
    }, timeout);
    this.pending.set(id, { resolve, reject, timer, kind: 'command' });
    try {
      this.win.postMessage({ ...fields, melodica: 1, type: 'command', id, action }, this.origin);
    } catch (err) {
      clearTimeout(timer);
      this.pending.delete(id);
      reject(new BridgeError(`could not post to the extension: ${err && err.message ? err.message : err}`));
    }
  });
};

// Response bodies arrive as Uint8Array (structured clone keeps the type), but
// accept ArrayBuffer and strings from lenient scripts.
export function bodyToText(body) {
  if (body === undefined || body === null) return '';
  if (typeof body === 'string') return body;
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(body));
  if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body);
  return String(body);
}
