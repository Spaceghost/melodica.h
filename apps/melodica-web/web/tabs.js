// One same-origin playback engine. localStorage contains only the public view and
// a short lease; credentials and audio URLs stay in memory or the encrypted vault.
export const TAB_STATE = 'melodica.tabs.v1';
const LOCK = 'melodica-player-v1';
const CHANNEL = 'melodica-player-v1';
const LEASE_MS = 6000;
const RELOAD_GRACE_MS = 1800;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const id = () => globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2);

export class TabPlayer {
  constructor({ win = window, snapshot, command, takeover, lose, fetch: fetchImpl, checkpoint, suspend, prepareRequest } = {}) {
    this.win = win;
    this.snapshot = snapshot;
    this.runCommand = command;
    this.takeover = takeover;
    this.lose = lose;
    this.checkpoint = checkpoint;
    this.suspend = suspend;
    this.prepareRequest = prepareRequest;
    this.nativeFetch = fetchImpl || win.fetch.bind(win);
    this.pending = new Map();
    this.cache = new Map();
    this.inflight = new Map();
    this.owner = false;
    this.closed = false;
    this.started = false;
    this.bus = typeof win.BroadcastChannel === 'function' ? new win.BroadcastChannel(CHANNEL) : null;
    // sessionStorage is tab-specific and survives a reload. Duplicated tabs can
    // inherit it, so every document also has a fresh address for RPC replies.
    this.address = id();
    try { this.id = win.sessionStorage.getItem(LOCK) || id(); win.sessionStorage.setItem(LOCK, this.id); } catch (_) { this.id = id(); }
    this.read = () => { try { const v = JSON.parse(win.localStorage.getItem(TAB_STATE)); return v?.v === 1 ? v : null; } catch (_) { return null; } };
    this.write = (v) => { try { win.localStorage.setItem(TAB_STATE, JSON.stringify(v)); } catch (_) { /* BC still coordinates */ } };
    this.current = this.read();
    this.onStorage = (e) => { if (e.key === TAB_STATE) this.accept(this.read()); };
    this.onPagehide = () => this.close();
    this.onPageshow = async (event) => {
      if (!event.persisted || !this.closed) return;
      this.closed = false;
      this.address = id();
      this.current = this.read();
      this.win.addEventListener('storage', this.onStorage);
      this.bus = typeof win.BroadcastChannel === 'function' ? new win.BroadcastChannel(CHANNEL) : null;
      if (this.bus) this.bus.onmessage = (e) => this.receive(e.data);
      await this.start();
      if (this.owner) await this.takeover?.(); else this.lose?.();
    };
    win.addEventListener('storage', this.onStorage);
    win.addEventListener('pagehide', this.onPagehide);
    win.addEventListener('pageshow', this.onPageshow);
    if (this.bus) this.bus.onmessage = (e) => this.receive(e.data);
    // Proxy only application requests. ES module and media loading are browser
    // operations; this wrapper does not change them.
    win.fetch = (...args) => this.fetch(...args);
  }

  send(m) {
    const packet = { ...m, from: this.address };
    if (this.bus) this.bus.postMessage(packet);
    else {
      // Storage events provide RPC when BroadcastChannel is unavailable. Never put
      // request headers, response bodies or credentials in this public fallback.
      if (m.type === 'command' || m.type === 'hello') {
        try { this.win.localStorage.setItem(`${TAB_STATE}.command`, JSON.stringify(packet)); } catch (_) { /* unavailable */ }
      }
    }
  }

  async start() {
    if (!this.bus) {
      this.onFallback = (e) => { if (e.key === `${TAB_STATE}.command` && e.newValue) { try { this.receive(JSON.parse(e.newValue)); } catch (_) { /* malformed */ } } };
      this.win.addEventListener('storage', this.onFallback);
    }
    await this.elect(true);
    this.started = true;
    this.timer = this.win.setInterval(() => this.tick(), 500);
    this.send({ type: 'hello' });
    return this.owner;
  }

  fresh(v = this.current) { return !!v && v.until > Date.now(); }
  accept(v) {
    if (!v) return;
    if (this.owner && v.owner !== this.address && v.until > Date.now()) {
      // Web Locks prevents split ownership. This handles a storage-lease fallback
      // losing arbitration before it starts any playback.
      this.owner = false;
      this.release?.();
      this.lose?.();
    }
    this.current = v;
    if (!this.owner && v.state) this.onState?.(v.state);
  }

  async elect(initial = false) {
    if (this.electing || this.closed || this.owner) return;
    this.electing = true;
    try {
      const prev = this.read() || this.current;
      if (prev && prev.until > Date.now() && prev.owner !== this.address) {
        if (prev.leaving && prev.tab !== this.id && prev.until - Date.now() > LEASE_MS - RELOAD_GRACE_MS) return;
        if (!prev.leaving) {
          // The exclusive lock below decides whether a fresh stored lease belongs
          // to a living engine or was left behind by a browser shutdown.
          if (!this.win.navigator.locks?.request) return;
        }
      }
      if (this.win.navigator.locks?.request) {
        let answer;
        const ready = new Promise((ok) => { answer = ok; });
        this.win.navigator.locks.request(LOCK, { ifAvailable: true }, async (lock) => {
          if (!lock || this.closed) { answer(false); return; }
          this.owner = true;
          this.publish();
          answer(true);
          await new Promise((ok) => { this.release = ok; });
        }).catch(() => answer(false));
        await ready;
      } else {
        // localStorage is the common arbitration point, including browsers without
        // Web Locks. Confirm the claim after a turn before executing any requests.
        this.write({ v: 1, owner: this.address, tab: this.id, until: Date.now() + LEASE_MS, state: prev?.state || null });
        await sleep(100 + Math.random() * 70);
        const claim = this.read();
        if (!claim || claim.owner === this.address) { this.owner = true; this.publish(); }
      }
      if (this.owner && !initial) await this.takeover?.();
    } finally { this.electing = false; }
  }

  publish() {
    if (!this.owner || this.closed) return;
    const state = this.snapshot?.() || this.current?.state || null;
    const v = { v: 1, owner: this.address, tab: this.id, until: Date.now() + LEASE_MS, state };
    this.current = v;
    this.write(v);
    this.send({ type: 'state', value: v });
  }

  tick() {
    if (this.closed) return;
    if (this.owner) {
      this.publish();
      this.checkpoint?.();
    } else if (!this.fresh() || this.current?.leaving) this.elect();
  }

  async receive(m) {
    if (!m || m.from === this.address) return;
    if (m.type === 'state') { this.accept(m.value); return; }
    if (m.type === 'handoff' && m.from === this.current?.owner) { this.handoff = m.value; return; }
    if (m.type === 'hello' && this.owner) { this.publish(); if (this.handoff) this.send({ type: 'handoff', value: this.handoff }); return; }
    if (m.type === 'reply' && m.to === this.address) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      clearTimeout(p.timer);
      if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
      return;
    }
    if (!this.owner || (m.to && m.to !== this.address)) return;
    if (m.type === 'scrobble-live') { this.updateScrobbles(m.event); return; }
    if (m.type === 'command' || m.type === 'fetch') {
      try {
        const result = m.type === 'fetch' ? await this.executeFetch(m.request) : await this.runCommand(m.action, m.fields || {});
        this.publish();
        this.send({ type: 'reply', to: m.from, id: m.id, result });
      } catch (err) { this.send({ type: 'reply', to: m.from, id: m.id, error: err.message || String(err) }); }
    }
  }

  ask(type, fields) {
    return new Promise((resolve, reject) => {
      const token = id();
      const timer = setTimeout(() => { this.pending.delete(token); reject(new Error('The player tab did not answer.')); }, 12000);
      this.pending.set(token, { resolve, reject, timer });
      this.send({ type, ...fields, id: token, to: this.current?.owner });
    });
  }

  command(action, fields = {}) {
    if (this.owner) return this.runCommand(action, fields);
    if (!this.bus) {
      if (action === 'login') return Promise.resolve({ ok: false, error: 'Sign in in the player tab.' });
      // Commands contain only action names, station ids and public settings. Reply
      // through the next published snapshot rather than putting bodies in storage.
      this.send({ type: 'command', action, fields });
      return Promise.resolve({ ok: true });
    }
    return this.ask('command', { action, fields });
  }

  // Coalescing and TTLs are scoped to the actual URL, method and authorization.
  // Bodies and access headers are memory-only; encrypted with the engine checkpoint
  // so a close/reload handoff reuses valid answers without another me/relay request.
  async executeFetch(request) {
    request = await this.prepareRequest?.(request) || request;
    const { url, method, headers, body, credentials, cache } = request;
    const key = JSON.stringify([url, method, headers]);
    const path = new URL(url).pathname;
    const ttl = method === 'GET' && /\/(me|policy)$/.test(path) ? 30000
      : method === 'GET' && path.endsWith('/.well-known/openid-configuration') ? 300000 : 0;
    const saved = this.cache.get(key);
    if (ttl && saved && saved.until > Date.now()) return saved.value;
    if (ttl && this.inflight.has(key)) return this.inflight.get(key);
    const operation = (async () => {
      const r = await this.nativeFetch(url, { method, headers, body: ['GET', 'HEAD'].includes(method) ? undefined : body, credentials, cache });
      const bytes = new Uint8Array(await r.arrayBuffer());
      const value = { status: r.status, statusText: r.statusText, headers: [...r.headers], bytes: [...bytes] };
      if (r.ok && method === 'POST' && /^\/scrobble\/api\/me\/(listens|settings)$/.test(path)) {
        for (const cachedKey of this.cache.keys()) {
          const [cachedUrl] = JSON.parse(cachedKey);
          if (new URL(cachedUrl).pathname === '/scrobble/api/me') this.cache.delete(cachedKey);
        }
      }
      if (ttl && r.ok) this.cache.set(key, { until: Date.now() + ttl, value });
      return value;
    })();
    if (ttl) this.inflight.set(key, operation);
    try { return await operation; } finally { this.inflight.delete(key); }
  }

  updateScrobbles(event) {
    if (!event || !['playing', 'listen'].includes(event.type)) return;
    if (!this.owner) { if (this.bus) this.send({ type: 'scrobble-live', event }); return; }
    let changed = false;
    for (const [key, saved] of this.cache) {
      if (saved.until <= Date.now()) continue;
      try {
        const [url] = JSON.parse(key);
        if (new URL(url).pathname !== '/scrobble/api/me') continue;
        const data = JSON.parse(new TextDecoder().decode(new Uint8Array(saved.value.bytes)));
        if (event.type === 'playing') {
          if (Number(event.at) < (saved.playingAt || 0)) continue;
          data.now_playing = event.now_playing || null;
          saved.playingAt = Number(event.at) || 0;
        } else {
          const listen = event.listen;
          if (!listen?.id || data.recent?.some((l) => l.id === listen.id)) continue;
          // Retain the older rows and their opaque cursor; later pages must not skip them.
          data.recent = [listen, ...(data.recent || [])];
          const age = Date.now() / 1000 - Number(listen.listened_at);
          data.counts = { ...data.counts, all: (data.counts?.all || 0) + 1,
            '30d': (data.counts?.['30d'] || 0) + (age <= 30 * 86400 ? 1 : 0),
            today: (data.counts?.today || 0) + (age <= 86400 ? 1 : 0) };
          if (data.now_playing?.title === listen.title && data.now_playing?.artist === listen.artist) data.now_playing = null;
        }
        const bytes = [...new TextEncoder().encode(JSON.stringify(data))];
        saved.value = { ...saved.value, bytes, headers: saved.value.headers.filter(([name]) => name.toLowerCase() !== 'content-length') };
        changed = true;
      } catch (_) { this.cache.delete(key); }
    }
    if (changed) this.checkpoint?.(true);
  }

  async fetch(input, init) {
    const r = new Request(new URL(typeof input === 'string' ? input : input.url, this.win.location.href), { ...(input instanceof Request ? { method: input.method, headers: input.headers, credentials: input.credentials, cache: input.cache } : {}), ...init });
    const request = { url: r.url, method: r.method, headers: [...r.headers], body: ['GET', 'HEAD'].includes(r.method) ? null : await r.text(), credentials: r.credentials, cache: r.cache };
    // No secret-bearing storage fallback. With no BC the remote's panel requests
    // may use the native fetch, while playback commands remain coordinated.
    const value = this.owner ? await this.executeFetch(request) : this.bus ? await this.ask('fetch', { request }) : await this.executeFetch(request);
    return new Response([204, 205, 304].includes(value.status) ? null : new Uint8Array(value.bytes), { status: value.status, statusText: value.statusText, headers: value.headers });
  }

  publishHandoff(value) { this.handoff = value; if (this.bus) this.send({ type: 'handoff', value }); }

  restoreCache(values) { this.cache = new Map((values || []).filter(([, v]) => v?.until > Date.now())); }

  close() {
    if (this.closed) return;
    if (this.owner) {
      const value = { ...this.current, leaving: true, until: Date.now() + LEASE_MS, state: this.snapshot?.() || this.current?.state };
      this.write(value);
      this.send({ type: 'state', value });
    }
    this.suspend?.();
    this.closed = true;
    this.owner = false;
    this.release?.();
    clearInterval(this.timer);
    this.win.removeEventListener('storage', this.onStorage);
    this.win.removeEventListener('storage', this.onFallback);
    this.bus?.close();
  }
}
