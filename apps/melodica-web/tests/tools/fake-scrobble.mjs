// A contract fake of the spacegho.st Scrobbles API the page uses (web/scrobble.js), on
// the page's own origin:
//   GET  /scrobble/api/me              {account, settings, crew_viewer, recent (15), next_cursor}
//   GET  /scrobble/api/me/listens      ?limit&before=<listened_at>.<id> -> {listens, next_cursor}
//   POST /scrobble/api/me/listens      ListenBrainz {listen_type, payload}; 403 scrobbling_off
//   GET|POST /scrobble/api/me/settings {display_name?, leaderboard?, crew?, live?, scrobbling?}
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
  const self = { handle, posts, requests, accounts, seedCount: 0, defaultOn: true, crewViewers: new Set(), reset() { accounts.clear(); posts.length = 0; requests.length = 0; self.crewViewers.clear(); self.seedCount = 0; } };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  const id = (l) => createHash('sha256').update(`${l.listened_at}|${l.artist}|${l.title}`).digest('hex');

  function account(key) {
    let a = accounts.get(key);
    if (!a) {
      a = { settings: { name: 'tuner_listener', display_name: '', handle: 'sgs-1', github: null, scrobbling: self.defaultOn, opted_out_by: null, leaderboard: true, crew: false, live: false }, listens: [], now: null };
      const t0 = Math.floor(Date.now() / 1000) - 60;
      for (let i = 0; i < self.seedCount; i++) {
        const l = { listened_at: t0 - i * 200, artist: `Seed Artist ${i + 1}`, title: `Seed Song ${i + 1}`, album: 'Seeds', duration_ms: 200000, client: 'melodica-web' };
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
    const auth = req.headers.get('authorization') || '';
    const key = auth.startsWith('Bearer ') ? who(auth.slice(7)) : '';
    requests.push(`${m} ${p}${url.search}`);
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
      return json(page(a, url.searchParams.get('before') || '', limit));
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
      const l = { listened_at: entry.listened_at, artist: md.artist_name, title: md.track_name, album: md.release_name, duration_ms: md.additional_info && md.additional_info.duration_ms, client: md.additional_info && md.additional_info.submission_client };
      const lid = id(l);
      if (!a.listens.some((x) => x.id === lid)) a.listens.unshift({ id: lid, ...l });
      a.listens.sort((x, y) => y.listened_at - x.listened_at || (y.id < x.id ? -1 : 1));
      return json({ status: 'ok' });
    }
    if (p === '/scrobble/api/me/settings' && m === 'GET') return json(a.settings);
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
  return self;
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
