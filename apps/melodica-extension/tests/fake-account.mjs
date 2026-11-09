// The smokes' stand-in for the spacegho.st account server (docs/ACCOUNT.md): the
// melodica access check (POST /oauth/melodica/access, an allow-list of login emails),
// and an OAuth 2.1 authorization-code + PKCE provider with a GitHub sign-in page,
// rotating refresh tokens, /oauth/userinfo and /oauth/melodica/policy. The test sets
// who is on the list and what each answer says.
//
//   createAccountServer({ issuer }) -> { handle(req, res, body), allow(email, {spots}),
//     disallow(email), requests: [{email, client}], calls: [...], setSlots(account, bool),
//     tokens, accounts }
//   startAccountServer() -> the same on http://localhost:<port> (the Firefox smoke)
//
// With SPACEGHOST_AUTH_ADAPTER=/path/to/adapter.mjs the smokes load that module's
// createAccountServer instead (same interface), e.g. one that runs the real
// spaceghost-auth Worker in Node. The adapter is not part of this repository.
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

const b64u = (b) => Buffer.from(b).toString('base64url');
const rand = (n = 24) => b64u(randomBytes(n));
const sha = (s) => createHash('sha256').update(s).digest('base64url');

// Registered clients and their redirect patterns (as on spacegho.st).
const CLIENTS = {
  'melodica-extension': [/^https:\/\/[a-z0-9-]+\.chromiumapp\.org\//, /^https:\/\/[a-z0-9-]+\.extensions\.allizom\.org\//],
  'melodica-ios': [/^https:\/\/spacegho\.st\/melodica\/app\/$/],
  'melodica-web': [/^https:\/\/spacegho\.st\/melodica\/app\/$/],
};

export function createAccountServer({ issuer = 'https://spacegho.st', accessTtl = 3600 } = {}) {
  // One spacegho.st account, linked to GitHub. `spots` is what /oauth/melodica/policy
  // answers for it.
  const accounts = {
    github: { id: 'u_github_ci', email: null, name: 'octo-ci', github: 'octo-ci', spots: true },
  };
  // The access allow-list: login email (lowercased) -> {spots}; every ask is recorded.
  const allowList = new Map();
  const requests = [];
  const byId = (id) => Object.values(accounts).find((a) => a.id === id) || null;
  const sessions = new Map(); // cookie -> account id
  const githubStates = new Map(); // state -> next
  const codes = new Map(); // code -> {...}
  const refresh = new Map(); // token -> {id, clientId, scope}
  const access = new Map(); // token -> {id, exp}
  const calls = [];
  const tokens = { issued: 0, refreshed: 0, revoked: 0, refused: 0 };
  // Usernames per login (generated until chosen), names already held by others,
  // melodica tokens from login-ok, and every login-ok / username call.
  const users = new Map();
  const takenNames = new Set(['octo-ci', 'taken_name']);
  const melodicaTokens = new Map();
  const loginOks = [];
  const usernameCalls = [];
  const scrobbleSettings = new Map();
  const listens = [];
  const scrobbleRefused = [];
  let scrobbleDown = false;
  let scrobbleFail = null;
  const seededListens = [];
  const scrobbleUiCalls = [];
  const userOf = (email) => {
    if (!users.has(email)) users.set(email, { username: `listener-${sha(email).slice(0, 6).toLowerCase().replace(/[^a-z0-9]/g, '0')}`, chosen: false, suggested: '' });
    return users.get(email);
  };

  const jwt = (claims) => `${b64u(JSON.stringify({ alg: 'ES256', typ: 'at+jwt' }))}.${b64u(JSON.stringify(claims))}.${rand(16)}`;
  const issue = (id, clientId, scope) => {
    const now = Math.floor(Date.now() / 1000);
    const a = byId(id);
    const at = jwt({ iss: issuer, sub: id, aud: clientId, client_id: clientId, scope, iat: now, exp: now + accessTtl, jti: rand(8) });
    access.set(at, { id, exp: now + accessTtl });
    const rt = rand(32);
    refresh.set(rt, { id, clientId, scope });
    const idt = jwt({ iss: issuer, sub: id, aud: clientId, iat: now, exp: now + accessTtl, ...(a && a.name ? { name: a.name } : {}) });
    return { access_token: at, token_type: 'Bearer', expires_in: accessTtl, refresh_token: rt, id_token: idt, scope };
  };
  const bearer = (req) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    const t = m && access.get(m[1]);
    return t && t.exp > Date.now() / 1000 ? byId(t.id) : null;
  };
  const cookieAccount = (req) => {
    const m = /(?:^|;\s*)sg_session=([^;]+)/.exec(req.headers.cookie || '');
    return m ? byId(sessions.get(m[1])) : null;
  };
  const newSession = (id) => { const c = rand(); sessions.set(c, id); return `sg_session=${c}; Path=/oauth; HttpOnly; SameSite=Lax${issuer.startsWith('https:') ? '; Secure' : ''}`; };
  const page = (res, title, body, status = 200) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><meta charset=utf-8><title>${title}</title><body><h1>${title}</h1>${body}</body>`);
  };
  const json = (res, status, obj) => {
    res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  const go = (res, location, cookie) => { res.writeHead(302, { location, ...(cookie ? { 'set-cookie': cookie } : {}), 'cache-control': 'no-store' }); res.end(); };
  const signInPage = (res, next) => page(res, 'Sign in to spacegho.st',
    `<p><a id="sg-github" href="/oauth/github/start?next=${encodeURIComponent(next)}">Continue with GitHub</a></p>`);

  async function handle(req, res, body = '') {
    const url = new URL(req.url, issuer);
    const p = url.pathname;
    const f = new URLSearchParams(body);
    calls.push({ method: req.method, path: p });
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST' }); return res.end(); }

    if (p === '/oauth/' || p === '/oauth') {
      const a = cookieAccount(req);
      return page(res, 'Your account', a ? `<p id="sg-who">${a.name || a.email}</p>` : '<p>Not signed in.</p>');
    }
    if (p === '/oauth/github/start') {
      const st = rand(12);
      githubStates.set(st, url.searchParams.get('next') || '/oauth/');
      return go(res, `/__fake-github/authorize?state=${encodeURIComponent(st)}`);
    }
    // GitHub's consent screen, faked: one link per GitHub-linked account.
    if (p === '/__fake-github/authorize') {
      const st = encodeURIComponent(url.searchParams.get('state') || '');
      const links = Object.values(accounts).filter((a) => a.github).map((a) => `<a id="gh-${a.github}" href="/oauth/github/callback?code=code-${a.github}&state=${st}">Authorize as ${a.github}</a>`).join(' ');
      return page(res, 'GitHub (test)', `<p>${links}</p>`);
    }
    if (p === '/oauth/github/callback') {
      const next = githubStates.get(url.searchParams.get('state') || '');
      const login = String(url.searchParams.get('code') || '').replace(/^code-/, '');
      const a = Object.values(accounts).find((x) => x.github && x.github === login);
      if (!next || !a) return page(res, 'Sign-in failed', '<p>GitHub did not confirm the sign-in.</p>', 400);
      githubStates.delete(url.searchParams.get('state'));
      return go(res, next, newSession(a.id));
    }
    if (p === '/oauth/authorize') {
      const q = url.searchParams;
      const clientId = q.get('client_id') || '';
      const redirectUri = q.get('redirect_uri') || '';
      if (!(CLIENTS[clientId] || []).some((re) => re.test(redirectUri))) return page(res, 'Error', '<p>Unknown client or redirect.</p>', 400);
      if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) {
        return go(res, `${redirectUri}${redirectUri.includes('?') ? '&' : '?'}error=invalid_request&state=${encodeURIComponent(q.get('state') || '')}&iss=${encodeURIComponent(issuer)}`);
      }
      const a = cookieAccount(req);
      if (!a) {
        if (q.get('prompt') === 'none') return go(res, `${redirectUri}?error=login_required&state=${encodeURIComponent(q.get('state') || '')}&iss=${encodeURIComponent(issuer)}`);
        return signInPage(res, p + url.search);
      }
      const code = rand();
      codes.set(code, { id: a.id, clientId, redirectUri, challenge: q.get('code_challenge'), scope: q.get('scope') || 'openid', exp: Date.now() + 60000 });
      return go(res, `${redirectUri}${redirectUri.includes('?') ? '&' : '?'}code=${encodeURIComponent(code)}&state=${encodeURIComponent(q.get('state') || '')}&iss=${encodeURIComponent(issuer)}`);
    }
    if (p === '/oauth/token' && req.method === 'POST') {
      if (f.get('grant_type') === 'authorization_code') {
        const c = codes.get(f.get('code') || '');
        codes.delete(f.get('code') || '');
        if (!c || c.exp < Date.now() || c.clientId !== f.get('client_id') || c.redirectUri !== f.get('redirect_uri') || sha(f.get('code_verifier') || '') !== c.challenge) {
          tokens.refused++;
          return json(res, 400, { error: 'invalid_grant' });
        }
        tokens.issued++;
        return json(res, 200, issue(c.id, c.clientId, c.scope));
      }
      if (f.get('grant_type') === 'refresh_token') {
        const r = refresh.get(f.get('refresh_token') || '');
        if (!r || r.clientId !== f.get('client_id')) { tokens.refused++; return json(res, 400, { error: 'invalid_grant' }); }
        refresh.delete(f.get('refresh_token'));
        tokens.refreshed++;
        return json(res, 200, issue(r.id, r.clientId, r.scope));
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    if (p === '/oauth/revoke' && req.method === 'POST') {
      if (refresh.delete(f.get('token') || '')) tokens.revoked++;
      return json(res, 200, {});
    }
    if (p === '/oauth/userinfo') {
      const a = bearer(req);
      if (!a) return json(res, 401, { error: 'invalid_token' });
      return json(res, 200, { sub: a.id, ...(a.name ? { name: a.name } : {}), ...(a.email ? { email: a.email, email_verified: true } : {}) });
    }
    if (p === '/oauth/melodica/access' && req.method === 'POST') {
      let q = null;
      try { q = JSON.parse(body); } catch { q = null; }
      const email = q && typeof q.email === 'string' ? q.email.trim().toLowerCase() : '';
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) return json(res, 400, { error: 'invalid_request' });
      const a = req.headers.authorization ? bearer(req) : null;
      const entry = allowList.get(email);
      requests.push({ email, client: q.client, bearer: !!a, allowed: !!entry });
      if (!entry) return json(res, 200, { allowed: false, plus: false, message: 'melodica access is by allow-list. Your request has been sent.' });
      return json(res, 200, { allowed: true, plus: !(entry.spots && (!a || a.spots)), token: jwt({ iss: issuer, sub: `melodica:${email}`, iat: Math.floor(Date.now() / 1000) }) });
    }
    // login-ok: the Pandora session must be present (the real Worker checks it with
    // Pandora); answers a verified melodica token and the user's username.
    if (p === '/oauth/melodica/login-ok' && req.method === 'POST') {
      let q = null;
      try { q = JSON.parse(body); } catch { q = null; }
      const email = q && typeof q.email === 'string' ? q.email.trim().toLowerCase() : '';
      const pd = q && q.pandora;
      const ok = pd && typeof pd.userAuthToken === 'string' && pd.userAuthToken && typeof pd.userId === 'string' && pd.userId
        && typeof pd.partnerId === 'string' && pd.partnerId && Number.isInteger(pd.syncTimeOffset);
      loginOks.push({ client: q && q.client, pandora: !!ok });
      if (!email || !ok) return json(res, 400, { error: 'invalid_request' });
      if (!allowList.has(email)) return json(res, 403, { error: 'not_allowed', error_description: 'Not allowed.' });
      const u = userOf(email);
      const now = Math.floor(Date.now() / 1000);
      const t = jwt({ iss: issuer, sub: `melodica:${sha(email)}`, iat: now, exp: now + 12 * 3600 });
      melodicaTokens.set(t, email);
      return json(res, 200, { ok: true, plus: !allowList.get(email).spots, token: t, username: u.username, username_chosen: u.chosen, scrobbling: false });
    }
    if (p === '/oauth/melodica/me' || (p === '/oauth/melodica/username' && req.method === 'POST')) {
      const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      const email = m && melodicaTokens.get(m[1]);
      const u = email ? userOf(email) : null;
      if (!u) return json(res, 401, { error: 'invalid_token' });
      usernameCalls.push({ path: p, bearer: 'melodica' });
      if (p === '/oauth/melodica/me') {
        return json(res, 200, { username: u.username, username_chosen: u.chosen, github: null, scrobbling: false, ...(u.suggested ? { suggested: u.suggested } : {}) });
      }
      let q = null;
      try { q = JSON.parse(body); } catch { q = null; }
      const name = q && typeof q.username === 'string' ? q.username.trim().toLowerCase() : '';
      if (!/^[a-z0-9][a-z0-9_-]{1,22}[a-z0-9]$/.test(name) || /^listener-|melodica|pandora|spaceghost/.test(name)) {
        return json(res, 422, { error: 'username_invalid', reason: 'format', error_description: 'That username is not allowed.' });
      }
      if (takenNames.has(name)) return json(res, 409, { error: 'username_taken', error_description: 'That username is taken.' });
      Object.assign(u, { username: name, chosen: true });
      return json(res, 200, { username: name, username_chosen: true });
    }
    // Spaceghost Scrobbles (melodica-scrobble src/worker.js api()): settings and
    // listen ingest, bearer = the melodica token or an account access token.
    if (p === '/scrobble/api/leaderboard') {
      scrobbleUiCalls.push(p);
      return json(res, 200, { window: url.searchParams.get('window') || '7d', songs: [{ artist: 'Board Artist', title: 'Board Song', listens: 7 }], artists: [{ artist: 'Board Artist', listens: 9 }], listeners: [{ name: 'board_listener', listens: 11 }], generated_at: new Date().toISOString() });
    }
    if (p === '/scrobble/api/live/poll') { scrobbleUiCalls.push(p); return json(res, 200, { events: [], now: Date.now() }); }
    if (p === '/scrobble/api/live') return json(res, 404, { error: 'not_found' });
    if (p === '/scrobble/api/me' || p.startsWith('/scrobble/api/me/')) {
      const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
      const email = m && melodicaTokens.get(m[1]);
      const a = !email && req.headers.authorization ? bearer(req) : null;
      const who = email ? `m:${email}` : a ? `a:${a.id}` : '';
      if (!who) return json(res, 401, { error: 'invalid_token' });
      if (!scrobbleSettings.has(who)) scrobbleSettings.set(who, { scrobbling: true });
      const st = scrobbleSettings.get(who);
      const mine = () => listens.filter((l) => l.who === who && l.body.listen_type === 'single').map((l, i) => {
        const pl = l.body.payload[0]; const m = pl.track_metadata;
        return { id: i + 1, listened_at: pl.listened_at, session: pl.listened_at, artist: m.artist_name, title: m.track_name, ...(m.release_name ? { album: m.release_name } : {}), client: m.additional_info.submission_client };
      }).reverse();
      if (p === '/scrobble/api/me' || p === '/scrobble/api/me/') {
        return json(res, 200, { account: { name: null, github: a ? a.github || null : null }, settings: { scrobbling: st.scrobbling }, counts: { listens: mine().length }, now_playing: null, recent: [...seededListens, ...mine()].slice(0, 15), next_cursor: null, crew_viewer: !!(a && a.github), territory: null });
      }
      if (p === '/scrobble/api/me/listens' && req.method === 'GET') return json(res, 200, { listens: [...seededListens, ...mine()].slice(0, 25), next_cursor: null });
      if (p === '/scrobble/api/me/settings') {
        if (req.method === 'POST') {
          let q = null;
          try { q = JSON.parse(body); } catch { q = null; }
          if (q && typeof q.scrobbling === 'boolean') st.scrobbling = q.scrobbling;
        }
        return json(res, 200, { name: null, display_name: null, handle: null, github: null, scrobbling: st.scrobbling, opted_out_by: st.scrobbling ? null : 'user', leaderboard: true, crew: false, live: false });
      }
      if (p === '/scrobble/api/me/listens' && req.method === 'POST') {
        if (scrobbleDown) return json(res, 503, { error: 'unavailable' });
        if (scrobbleFail) { scrobbleRefused.push(JSON.parse(body || 'null')); return json(res, scrobbleFail.status, { error: scrobbleFail.error }); }
        let q = null;
        try { q = JSON.parse(body); } catch { q = null; }
        if (!q || !['single', 'playing_now'].includes(q.listen_type) || !Array.isArray(q.payload)) return json(res, 400, { error: 'invalid_request' });
        if (!st.scrobbling) { scrobbleRefused.push(q); return json(res, 403, { error: 'scrobbling_off' }); }
        listens.push({ who, body: q });
        return json(res, 200, { status: 'ok' });
      }
    }
    if (p === '/oauth/melodica/policy') {
      if (!req.headers.authorization) return json(res, 200, { playback: { plus: false }, display: { name: null } });
      const a = bearer(req);
      if (!a) return json(res, 401, { error: 'invalid_token' });
      return json(res, 200, { playback: { plus: !a.spots }, display: { name: a.name } });
    }
    return json(res, 404, { error: 'not_found' });
  }

  return {
    issuer, accounts, calls, tokens, requests, handle, users, loginOks, usernameCalls, listens, scrobbleRefused, scrobbleSettings, scrobbleUiCalls,
    scrobbleOffline(down) { scrobbleDown = !!down; },
    scrobbleFailWith(status, error) { scrobbleFail = status ? { status, error } : null; },
    seedListen(l) { seededListens.unshift(l); },
    allow(email, { spots = true } = {}) { allowList.set(String(email).trim().toLowerCase(), { spots: !!spots }); },
    disallow(email) { allowList.delete(String(email).trim().toLowerCase()); },
    setSpots(which, on) { accounts[which].spots = !!on; },
    // Make every access token issued so far stale, so the next check must refresh.
    expireAccess() { for (const v of access.values()) v.exp = 0; },
    refreshTokens() { return refresh.size; },
  };
}

export async function loadAccountServer(opts) {
  const adapter = process.env.SPACEGHOST_AUTH_ADAPTER;
  if (adapter) {
    const m = await import(adapter);
    return m.createAccountServer(opts);
  }
  return createAccountServer(opts);
}

// A request body as a string.
export const readBody = (req) => new Promise((ok) => { let s = ''; req.on('data', (d) => { s += d; }); req.on('end', () => ok(s)); });

// The Firefox smoke has no host-resolver flag: serve the account server on
// http://localhost:<port> and point the extension there (storage key accountBase).
export async function startAccountServer() {
  const server = http.createServer();
  await new Promise((ok) => server.listen(0, 'localhost', ok));
  const issuer = `http://localhost:${server.address().port}`;
  const acct = await loadAccountServer({ issuer });
  server.on('request', async (req, res) => {
    try { await acct.handle(req, res, await readBody(req)); } catch (e) { res.writeHead(500); res.end(String(e)); }
  });
  return Object.assign(acct, { server, base: issuer });
}
