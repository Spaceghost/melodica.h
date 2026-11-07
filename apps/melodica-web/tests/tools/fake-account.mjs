// A stand-in for the spacegho.st account server (spaceghost-auth), implementing the
// client contract in docs/ACCOUNT.md and the pages a browser walks through, with the
// same routes, markup and cookies as the real Worker:
//
//   GET  /.well-known/openid-configuration
//   GET  /oauth/authorize            session -> 302 redirect_uri?code&state&iss; else the
//                                    sign-in page ("Continue with GitHub", and the email
//                                    form when sending is on); prompt=none -> login_required
//   POST /oauth/token                authorization_code (PKCE S256) and refresh_token (rotated)
//   GET  /oauth/userinfo, GET /oauth/melodica/policy, POST /oauth/revoke
//   POST /oauth/melodica/access      the allow-list check (also accessCheck/accessVerify for
//                                    the fake relay); its tokens are policy bearers too
//   GET|POST /oauth/invite           invite confirm page; POST accepts once, makes the email
//                                    account, sets the session cookie, 302 /oauth/
//   POST /oauth/email, GET|POST /oauth/email/verify   magic-link sign-in for email accounts
//   GET  /oauth/github/start         302 to github.com's authorize URL (the test intercepts it)
//   GET  /oauth/github/callback      ?code=code-<login>&state -> session, 302 next
//
// Test helpers: invite(email) -> token, setPolicy(name, {ads}), mail (sent messages),
// allow(email, {ads}) (the allow-list), requests (emails that asked for access).
// `export function makeBackend(issuer, opts)` returns {handle(Request), ...helpers}; the
// real Worker can be plugged in instead (tests/account.spec.mjs, SPACEGHOST_AUTH_DIR).

import { createHash, randomBytes } from 'node:crypto';

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sha = (s) => b64url(createHash('sha256').update(s).digest());
const rand = (n = 32) => b64url(randomBytes(n));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function makeBackend(issuer, { github = {}, emailSending = true } = {}) {
  const users = new Map();       // id -> {id, name, email, github, ads}
  const invites = new Map();     // sha(token) -> {email, used}
  const sessions = new Map();    // cookie -> user id
  const codes = new Map();       // code -> {user, redirectUri, challenge, scope, exp}
  const access = new Map();      // token -> {user, scope}
  const refresh = new Map();     // token -> {user, scope}
  const emailLinks = new Map();  // sha(token) -> {email, next}
  const ghStates = new Map();    // state -> next
  const mail = [];
  const allowList = new Map();   // email -> {ads}
  const accessTokens = new Map(); // melodica access token -> email
  const requests = [];
  const log = [];
  const redirectUri = `${issuer}/melodica/app/`;

  const html = (body, status = 200, headers = {}) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>spacegho.st</title></head><body><main>${body}</main></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
  const redirect = (location, cookies = []) => {
    const h = new Headers({ location });
    for (const c of cookies) h.append('set-cookie', c);
    return new Response(null, { status: 302, headers: h });
  };
  // Secure as on spacegho.st; left off for a plain-http test origin (the ads smoke on localhost).
  const secure = issuer.startsWith('https:') ? '; Secure' : '';
  const sessionCookie = (v, age = 2592000) => `sg_session=${v}; Path=/oauth; Max-Age=${age}; HttpOnly${secure}; SameSite=Lax`;
  const newSession = (userId) => { const v = rand(); sessions.set(v, userId); return sessionCookie(v); };
  const sessionUser = (req) => {
    const m = /(?:^|;\s*)sg_session=([^;]+)/.exec(req.headers.get('cookie') || '');
    return m ? users.get(sessions.get(m[1])) || null : null;
  };
  const bearer = (req) => (/^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') || '') || [])[1] || '';
  const newUser = (fields) => { const u = { id: `u_${rand(8)}`, ads: true, ...fields }; users.set(u.id, u); return u; };
  const form = async (req) => new URLSearchParams(await req.text());
  const signInPage = (next) => html(`<section class="card"><p class="eyebrow">spacegho.st</p><h2>Sign in</h2>
<p class="intro">to continue to melodica</p>
<a class="button" href="/oauth/github/start?next=${encodeURIComponent(next)}">Continue with GitHub</a>
${emailSending ? `<p class="or">or</p><form method="post" action="/oauth/email"><input type="hidden" name="next" value="${esc(next)}">
<input type="email" name="email" required aria-label="Email address"><button class="quiet" type="submit">Continue with email</button></form>`
    : '<p class="fine">Have an invite? Open the link you were sent to sign in by email.</p>'}</section>`);
  const confirmPage = (heading, action, t, button) => html(`<section class="card"><h2>${esc(heading)}</h2>
<form method="post" action="${action}"><input type="hidden" name="t" value="${esc(t)}"><button class="primary" type="submit">${esc(button)}</button></form></section>`);
  const tokens = (user, scope) => {
    const a = rand(); const r = rand();
    access.set(a, { user: user.id, scope }); refresh.set(r, { user: user.id, scope });
    return { access_token: a, token_type: 'Bearer', expires_in: 3600, refresh_token: r, id_token: 'x.y.z', scope };
  };

  const norm = (e) => String(e || '').trim().toLowerCase();
  function accessCheck(email) {
    const e = norm(email);
    const entry = allowList.get(e);
    if (!entry) { if (!requests.includes(e)) requests.push(e); return { allowed: false, ads: true }; }
    const token = `mat.${rand()}`;
    accessTokens.set(token, e);
    return { allowed: true, ads: entry.ads, token };
  }
  const accessVerify = (token) => !!token && accessTokens.has(token);

  async function handle(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;
    log.push(`${m} ${p}`);
    if (p === '/.well-known/openid-configuration') {
      return json({ issuer, authorization_endpoint: `${issuer}/oauth/authorize`, token_endpoint: `${issuer}/oauth/token`,
        userinfo_endpoint: `${issuer}/oauth/userinfo`, revocation_endpoint: `${issuer}/oauth/revoke`, end_session_endpoint: `${issuer}/oauth/logout`,
        jwks_uri: `${issuer}/oauth/jwks`, code_challenge_methods_supported: ['S256'] });
    }
    if (p === '/oauth/authorize' && m === 'GET') {
      const q = url.searchParams;
      if (q.get('client_id') !== 'melodica-web' || q.get('redirect_uri') !== redirectUri) return html('<h2>Unknown application</h2>', 400);
      const back = (params) => { const u = new URL(redirectUri); for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v); u.searchParams.set('iss', issuer); return redirect(u.toString()); };
      if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return back({ error: 'invalid_request', state: q.get('state') });
      const user = sessionUser(req);
      if (!user) return q.get('prompt') === 'none' ? back({ error: 'login_required', state: q.get('state') }) : signInPage(`/oauth/authorize${url.search}`);
      const code = rand();
      codes.set(code, { user: user.id, redirectUri, challenge: q.get('code_challenge'), scope: q.get('scope') || 'openid' });
      return back({ code, state: q.get('state') });
    }
    if (p === '/oauth/token' && m === 'POST') {
      const f = await form(req);
      if (f.get('client_id') !== 'melodica-web') return json({ error: 'invalid_client' }, 401);
      if (f.get('grant_type') === 'authorization_code') {
        const c = codes.get(f.get('code') || '');
        codes.delete(f.get('code') || '');
        if (!c || c.redirectUri !== f.get('redirect_uri') || sha(f.get('code_verifier') || '') !== c.challenge) return json({ error: 'invalid_grant' }, 400);
        return json(tokens(users.get(c.user), c.scope));
      }
      if (f.get('grant_type') === 'refresh_token') {
        const r = refresh.get(f.get('refresh_token') || '');
        refresh.delete(f.get('refresh_token') || '');
        if (!r) return json({ error: 'invalid_grant' }, 400);
        return json(tokens(users.get(r.user), r.scope));
      }
      return json({ error: 'unsupported_grant_type' }, 400);
    }
    if (p === '/oauth/userinfo') {
      const a = access.get(bearer(req));
      if (!a) return json({ error: 'invalid_token' }, 401);
      const u = users.get(a.user);
      const out = { sub: u.id, name: u.name || null };
      if (a.scope.split(' ').includes('email') && u.email) Object.assign(out, { email: u.email, email_verified: true });
      return json(out);
    }
    if (p === '/oauth/melodica/access' && m === 'POST') {
      let body = null;
      try { body = await req.json(); } catch (_) { /* below */ }
      if (!body || !/^[^@\s]+@[^@\s]+$/.test(norm(body.email))) return json({ error: 'invalid_request' }, 400);
      const d = accessCheck(body.email);
      return json(d.allowed ? d : { ...d, message: 'melodica access is by allow-list. Your request has been sent.' });
    }
    if (p === '/oauth/melodica/policy' && m === 'GET') {
      if (!bearer(req)) return json({ playback: { ads: true }, display: { name: null } });
      if (accessTokens.has(bearer(req))) return json({ playback: { ads: allowList.get(accessTokens.get(bearer(req))).ads }, display: { name: null } });
      const a = access.get(bearer(req));
      if (!a) return json({ error: 'invalid_token' }, 401);
      const u = users.get(a.user);
      return json({ playback: { ads: u.ads }, display: { name: u.name || null } });
    }
    if (p === '/oauth/revoke' && m === 'POST') { refresh.delete((await form(req)).get('token') || ''); return json({}); }
    if (p === '/oauth/invite') {
      if (m === 'GET') {
        const inv = invites.get(sha(url.searchParams.get('t') || ''));
        if (!inv || inv.used) return html('<h2>Invite not valid</h2>', 400);
        return confirmPage('You are invited', '/oauth/invite', url.searchParams.get('t'), 'Accept and sign in');
      }
      const t = (await form(req)).get('t') || '';
      const inv = invites.get(sha(t));
      if (!inv || inv.used) return html('<h2>Invite not valid</h2>', 400);
      inv.used = true;
      const user = [...users.values()].find((u) => u.email === inv.email) || newUser({ name: inv.email.split('@')[0], email: inv.email });
      return redirect(`${issuer}/oauth/`, [newSession(user.id)]);
    }
    if (p === '/oauth/email' && m === 'POST') {
      const f = await form(req);
      if (!emailSending) return html('<h2>Email sign-in is not available yet</h2>', 503);
      const email = String(f.get('email') || '').trim().toLowerCase();
      if ([...users.values()].some((u) => u.email === email)) {
        const t = rand();
        emailLinks.set(sha(t), { email, next: f.get('next') || '/oauth/' });
        mail.push({ to: email, link: `${issuer}/oauth/email/verify?t=${t}` });
      }
      return html('<h2>Check your email</h2>');
    }
    if (p === '/oauth/email/verify') {
      if (m === 'GET') return confirmPage('Sign in', '/oauth/email/verify', url.searchParams.get('t') || '', 'Sign in');
      const t = (await form(req)).get('t') || '';
      const row = emailLinks.get(sha(t));
      emailLinks.delete(sha(t));
      if (!row) return html('<h2>Link expired</h2>', 400);
      const user = [...users.values()].find((u) => u.email === row.email);
      return redirect(`${issuer}${row.next}`, [newSession(user.id)]);
    }
    if (p === '/oauth/github/start') {
      const state = rand(16);
      ghStates.set(state, url.searchParams.get('next') || '/oauth/');
      return redirect(`https://github.com/login/oauth/authorize?client_id=x&state=${encodeURIComponent(state)}`);
    }
    if (p === '/oauth/github/callback') {
      const next = ghStates.get(url.searchParams.get('state') || '');
      ghStates.delete(url.searchParams.get('state') || '');
      const login = String(url.searchParams.get('code') || '').replace(/^code-/, '');
      const person = github[login];
      if (!next || !person) return html('<h2>GitHub sign-in failed</h2>', 400);
      const user = [...users.values()].find((u) => u.github === login) || newUser({ name: login, github: login, ads: person.ads !== false });
      return redirect(`${issuer}${next}`, [newSession(user.id)]);
    }
    if (p === '/oauth/') return html(`<h2>${esc((sessionUser(req) || {}).name || 'Your account')}</h2>`);
    return json({ error: 'not_found' }, 404);
  }

  return {
    kind: 'fake',
    handle,
    log,
    mail,
    requests,
    accessCheck,
    accessVerify,
    allow(email, { ads = true } = {}) { allowList.set(norm(email), { ads }); },
    invite(email) { const t = rand(); invites.set(sha(t), { email: email.toLowerCase(), used: false }); return t; },
    async setPolicy(name, { ads }) { const u = [...users.values()].find((x) => x.name === name); if (!u) throw new Error(`no account ${name}`); u.ads = ads; },
  };
}
