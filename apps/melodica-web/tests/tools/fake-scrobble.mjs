// A contract fake of the spacegho.st Scrobbles API the page uses (web/scrobble.js), on
// the page's own origin:
//   GET  /scrobble/api/me              {account, settings, crew_viewer, recent (15), next_cursor}
//   GET  /scrobble/api/me/listens      ?limit&before=<listened_at>.<id> -> {listens, next_cursor}
//   POST /scrobble/api/me/listens      ListenBrainz {listen_type, payload}; 403 scrobbling_off
//   GET|POST /scrobble/api/me/settings {display_name?, leaderboard?, crew?, live?, scrobbling?}
//   GET  /scrobble/api/leaderboard?window=   public: {window, songs, artists, listeners, generated_at}
//   GET  /scrobble/api/game, game/moves     crew only (403 crew_only): a small map
//   GET  /scrobble/api/live/poll?since=     {events (pushed with `emit`), now}; GET live (no
//                                           upgrade: the test server has no WebSocket, so the
//                                           shared UI falls back to polling)
// me/listens takes ?cursor= (contract v1) and the deprecated ?before= (web 0.9.x).
// Bearers are resolved by `who(token)` (fake-account's who): an unknown one is 401.
// Every POST to /me/listens is kept in `posts` with the account it named.
//
// `export function makeScrobbles({who})` returns {handle(Request), posts, accounts,
// seedCount (listens a new account starts with), defaultOn (its scrobbling setting),
// crewViewers (keys answered crew_viewer: true), reset()}.

import { createHash } from 'node:crypto';

const NAME_RE = /^[a-z0-9][a-z0-9_-]{1,22}[a-z0-9]$/;

export function makeScrobbles({ who }) {
  const accounts = new Map(); // key -> {settings, listens (newest first), now}
  const posts = [];
  const requests = []; // 'GET /scrobble/api/me', ...
  const auth = [];     // the Authorization header of each request
  const events = [];
  const sockets = new Set(); // live WebSockets: {key, sock}
  const self = { handle, posts, requests, auth, events, emit(key, ev) { const e = { at: Date.now(), ...ev }; events.push({ key, ev: e }); for (const c of sockets) if (c.key === key) wsSend(c.sock, e); }, accounts, seedCount: 0, defaultOn: true, crewViewers: new Set(), cookies: new Map(), reset() { self.cookies.clear(); accounts.clear(); posts.length = 0; requests.length = 0; auth.length = 0; events.length = 0; self.crewViewers.clear(); self.seedCount = 0; } };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  const id = (l) => createHash('sha256').update(`${l.listened_at}|${l.artist}|${l.title}`).digest('hex');

  function account(key) {
    let a = accounts.get(key);
    if (!a) {
      a = { settings: { name: 'tuner_listener', display_name: '', handle: 'sgs-1', github: null, scrobbling: self.defaultOn, opted_out_by: null, leaderboard: true, crew: false, live: false }, listens: [], now: null };
      const t0 = Math.floor(Date.now() / 1000) - 60;
      for (let i = 0; i < self.seedCount; i++) {
        const at = t0 - i * 200;
        const l = { listened_at: at, artist: `Seed Artist ${i + 1}`, title: `Seed Song ${i + 1}`, album: 'Seeds', duration_ms: 200000, client: 'melodica-web', session: t0 - Math.floor(i / 10) * 2000 - 1800 };
        a.listens.push({ id: id(l), ...l });
      }
      accounts.set(key, a);
    }
    return a;
  }
  function page(a, before, limit) {
    let list = a.listens;
    if (before) {
      const [at, bid] = before.split('.');
      list = list.filter((l) => l.listened_at < Number(at) || (l.listened_at === Number(at) && l.id < bid));
    }
    const out = list.slice(0, limit);
    const last = out[out.length - 1];
    return { listens: out, next_cursor: list.length > limit && last ? `${last.listened_at}.${last.id}` : null };
  }

  async function handle(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;
    const auth_ = req.headers.get('authorization') || '';
    // Without a bearer, the spacegho.st session cookie (as the shared panels read with token null).
    const ck = (/(?:^|;\s*)scrobble_session=([^;]+)/.exec(req.headers.get('cookie') || '') || [])[1] || '';
    const key = auth_.startsWith('Bearer ') ? who(auth_.slice(7)) : (self.cookies.get(ck) || '');
    requests.push(`${m} ${p}${url.search}`);
    auth.push(auth_);
    if (!p.startsWith('/scrobble/api/')) return json({ error: 'not_found' }, 404);
    if (!key) return json({ error: 'invalid_token', message: 'Sign in again.' }, 401);
    const a = account(key);
    if (p === '/scrobble/api/me' && m === 'GET') {
      const first = page(a, '', 15);
      return json({ account: { kind: key.startsWith('u:') ? 'user' : 'melodica', github: null, created_at: 0 }, settings: a.settings,
        counts: { total: a.listens.length }, now_playing: a.now, recent: first.listens, next_cursor: first.next_cursor,
        crew_viewer: self.crewViewers.has(key) });
    }
    if (p === '/scrobble/api/me/listens' && m === 'GET') {
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 15));
      return json(page(a, url.searchParams.get('cursor') || url.searchParams.get('before') || '', limit));
    }
    if (p === '/scrobble/api/me/listens' && m === 'POST') {
      let body = null;
      try { body = await req.json(); } catch (_) { return json({ error: 'bad_json' }, 400); }
      posts.push({ key, body, at: Date.now() });
      if (!a.settings.scrobbling) return json({ error: 'scrobbling_off', message: 'Scrobbling is off.' }, 403);
      const entry = body && Array.isArray(body.payload) ? body.payload[0] : null;
      const md = entry && entry.track_metadata;
      if (!md || !md.artist_name || !md.track_name) return json({ error: 'invalid_listen' }, 400);
      if (body.listen_type === 'playing_now') { a.now = { artist: md.artist_name, title: md.track_name }; return json({ status: 'ok' }); }
      if (body.listen_type !== 'single' || !Number.isFinite(entry.listened_at)) return json({ error: 'invalid_listen' }, 400);
      const l = { session: entry.listened_at, listened_at: entry.listened_at, artist: md.artist_name, title: md.track_name, album: md.release_name, duration_ms: md.additional_info && md.additional_info.duration_ms, client: md.additional_info && md.additional_info.submission_client };
      const lid = id(l);
      if (!a.listens.some((x) => x.id === lid)) a.listens.unshift({ id: lid, ...l });
      a.listens.sort((x, y) => y.listened_at - x.listened_at || (y.id < x.id ? -1 : 1));
      return json({ status: 'ok' });
    }
    if (p === '/scrobble/api/me/settings' && m === 'GET') return json(a.settings);
    if (p === '/scrobble/api/leaderboard' && m === 'GET') {
      return json({ window: url.searchParams.get('window') || '7d', generated_at: Date.now(),
        songs: [{ artist: 'Aurora Fields', title: 'Slow Light', listens: 9 }, { artist: 'Band Two', title: 'Second Song', listens: 4 }],
        artists: [{ artist: 'Aurora Fields', listens: 12 }], listeners: [{ name: 'tuner_listener', listens: 40 }, { name: 'moonlit', listens: 7 }] });
    }
    if (p.startsWith('/scrobble/api/game')) {
      if (!self.crewViewers.has(key)) return json({ error: 'crew_only', message: 'The map is for the crew.' }, 403);
      if (p === '/scrobble/api/game/moves') return json({ season: '2026-11', moves: [], next_cursor: null });
      if (p === '/scrobble/api/game' && m === 'GET') {
        const who = { github: 'tunerfan', name: 'tuner_listener', avatar: null, you: true };
        const prov = (k, n, g) => ({ key: k, name: n, holder: who, garrison: g, dethroner: null, armies: [{ ...who, armies: g }],
          towns: [{ key: 'aurora fields', name: 'Aurora Fields', armies: g, leader: who, live: [] }], town_count: 1, live: [] });
        return json({ generated_at: Date.now(), season: '2026-11', season_ends_at: Date.now() + 7 * 864e5, rules: {},
          me: { playing: true, left: 3, granted: 5, attacks_left: 2, dethrone_bonus: 0, handicapped: false },
          regions: [{ name: 'Rock', holder: who, provinces: [prov('indie rock', 'indie rock', 6), prov('punk', 'punk', 2)] },
            { name: 'Ambient', holder: null, provinces: [prov('drone', 'drone', 1)] }],
          standings: [{ ...who, regions: 1, provinces: 3, armies: 9 }], log: [], trophies: [] });
      }
      return json({ error: 'not_found' }, 404);
    }
    if (p === '/scrobble/api/live/poll' && m === 'GET') {
      const since = Number(url.searchParams.get('since')) || 0;
      return json({ events: events.filter((e) => e.key === key && e.ev.at > since).map((e) => e.ev), now: Date.now() });
    }
    if (p === '/scrobble/api/live' && m === 'GET') return json({ members: [] });
    if (p === '/scrobble/api/me/settings' && m === 'POST') {
      let body = null;
      try { body = await req.json(); } catch (_) { return json({ error: 'bad_json' }, 400); }
      if (typeof body.display_name === 'string') {
        if (!NAME_RE.test(body.display_name)) return json({ error: 'invalid_display_name', message: 'Use 3 to 24 letters, digits, - or _.' }, 422);
        a.settings.display_name = a.settings.name = body.display_name;
      }
      for (const k of ['leaderboard', 'crew', 'live', 'scrobbling']) if (typeof body[k] === 'boolean') a.settings[k] = body[k];
      if (body.scrobbling === false) a.settings.opted_out_by = 'user';
      if (body.scrobbling === true) a.settings.opted_out_by = null;
      return json(a.settings);
    }
    return json({ error: 'not_found' }, 404);
  }
  // The live channel's WebSocket (contract v1): the bearer rides in the subprotocol list
  // ('melodica-live.v1', 'bearer.<token>'); accepted with 'melodica-live.v1', then hello.
  // Incoming frames (pings) are ignored. attach(server) hooks the node:http 'upgrade'.
  self.attach = (server) => server.on('upgrade', (req, sock) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/scrobble/api/live') { sock.destroy(); return; }
    const protos = String(req.headers['sec-websocket-protocol'] || '').split(',').map((x) => x.trim());
    const bearer = (protos.find((x) => x.startsWith('bearer.')) || '').slice(7);
    const key = bearer ? who(bearer) : '';
    requests.push(`WS /scrobble/api/live${key ? '' : ' (refused)'}`);
    if (!protos.includes('melodica-live.v1') || !key) { sock.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 0\r\n\r\n'); return; }
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\nsec-websocket-protocol: melodica-live.v1\r\n\r\n`);
    const c = { key, sock };
    sockets.add(c);
    sock.on('data', () => {});
    sock.on('error', () => {});
    sock.on('close', () => sockets.delete(c));
    wsSend(sock, { type: 'hello', at: Date.now(), account: { name: 'tuner_listener', github: self.crewViewers.has(key) ? 'tunerfan' : null }, crew_viewer: self.crewViewers.has(key) });
  });
  self.closeSockets = () => { for (const c of sockets) c.sock.destroy(); sockets.clear(); };
  return self;
}

function wsSend(sock, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  const head = body.length < 126 ? Buffer.from([0x81, body.length])
    : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
  try { sock.write(Buffer.concat([head, body])); } catch (_) { /* closed */ }
}

// Serves a fetch-style handler from a node:http request (the test servers' glue).
export async function serveNode(handle, req, res, origin) {
  const url = new URL(req.url, origin);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (k !== 'host') headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  const r = await handle(new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }));
  const out = {};
  r.headers.forEach((v, k) => { out[k] = v; });
  res.writeHead(r.status, out);
  res.end(Buffer.from(await r.arrayBuffer()));
}
