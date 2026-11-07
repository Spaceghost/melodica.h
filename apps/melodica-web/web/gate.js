// melodica-web: the GitHub sign-in gate, client side. The hosted player and its
// relay require a GitHub sign-in and an allowed account (the Worker runs an
// allowlist check). This module only moves the token around: it takes
// `#melodica_token=…` off the URL after the GitHub round trip, keeps it in
// localStorage, asks `<authBase>me` who the token belongs to and whether the
// account is allowed, and forgets it on sign-out. The relay enforces the rule;
// this is the UI for it. No DOM here, so Node can test it.
//
// Status values from check():
//   off        /auth/me answered 503: the gate is not configured, show the Pandora login
//   allowed    signed in, allowed: show the Pandora login
//   denied     signed in, not allowed: say so, offer sign-out
//   anonymous  no (valid) token: offer "Sign in with GitHub"
//   unknown    /auth/me unreachable or odd: proceed to the Pandora login; the relay decides

export const TOKEN_KEY = 'melodica.github';
export const HASH_TOKEN = 'melodica_token';
export const HASH_ERROR = 'melodica_error';

// The callback puts the token (or an error code) in the fragment. Returns
// {token, error, rest}; `rest` is the fragment with those two parameters removed.
export function parseHash(hash) {
  const raw = (hash || '').replace(/^#/, '');
  if (!raw) return { token: '', error: '', rest: '' };
  const params = new URLSearchParams(raw);
  const token = params.get(HASH_TOKEN) || '';
  const error = params.get(HASH_ERROR) || '';
  params.delete(HASH_TOKEN);
  params.delete(HASH_ERROR);
  const rest = params.toString();
  return { token: looksLikeToken(token) ? token : '', error: error.slice(0, 64), rest };
}

export function looksLikeToken(t) {
  return typeof t === 'string' && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(t) && t.length <= 4096;
}

// The claims a token carries, decoded but NOT verified (only the Worker holds the
// key). Enough to show "signed in as …" before /auth/me has answered.
export function decodeClaims(token) {
  if (!looksLikeToken(token)) return null;
  try {
    const b64 = token.slice(0, token.indexOf('.')).replace(/-/g, '+').replace(/_/g, '/');
    const json = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    const c = JSON.parse(json);
    return c && typeof c === 'object' && typeof c.sub === 'string' ? c : null;
  } catch (_) {
    return null;
  }
}

export class GithubGate {
  // authBase: absolute URL ending in '/', e.g. https://spacegho.st/melodica/auth/
  // store: {get, set, remove} over localStorage (or a Map in tests)
  constructor({ authBase, store, fetch: fetchImpl, log } = {}) {
    this.authBase = authBase;
    this.store = store;
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
    this.log = log || (() => {});
    this.login = '';
    this.allowed = false;
  }

  get token() {
    const t = this.store.get(TOKEN_KEY);
    return looksLikeToken(t) ? t : '';
  }

  // Store a token that arrived in the fragment and clean the URL (replaceState, no
  // navigation, no history entry). Returns {token, error}.
  takeTokenFromHash(location, history) {
    const { token, error, rest } = parseHash(location.hash);
    if (token) {
      this.store.set(TOKEN_KEY, token);
      this.log('token received from the GitHub sign-in');
    }
    if (token || error) {
      try {
        history.replaceState(history.state, '', location.pathname + location.search + (rest ? `#${rest}` : ''));
      } catch (_) { /* a sandboxed page may refuse; the token is stored either way */ }
    }
    return { token, error };
  }

  startUrl(returnTo) {
    return `${this.authBase}start?return_to=${encodeURIComponent(returnTo)}`;
  }

  // Ask the Worker about the stored token (or, without one, whether the gate is on).
  async check() {
    const token = this.token;
    let res;
    try {
      res = await this.fetch(`${this.authBase}me`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        cache: 'no-store',
      });
    } catch (err) {
      this.log(`auth/me unreachable: ${err && err.message ? err.message : err}`);
      return { status: 'unknown', token, login: '', allowed: false, reason: 'unreachable' };
    }
    if (res.status === 503) return { status: 'off', token, login: '', allowed: false, reason: 'not configured' };
    if (res.status === 401) {
      if (token) {
        this.store.remove(TOKEN_KEY);
        this.log('stored GitHub token rejected; forgotten');
      }
      return { status: 'anonymous', token: '', login: '', allowed: false, reason: token ? 'rejected' : 'no token' };
    }
    if (!res.ok) {
      this.log(`auth/me answered HTTP ${res.status}`);
      return { status: 'unknown', token, login: '', allowed: false, reason: `http ${res.status}` };
    }
    let me;
    try {
      me = await res.json();
    } catch (_) {
      return { status: 'unknown', token, login: '', allowed: false, reason: 'bad json' };
    }
    if (!token) return { status: 'anonymous', token: '', login: '', allowed: false, reason: 'no token' };
    if (looksLikeToken(me.token) && me.token !== token) {
      this.store.set(TOKEN_KEY, me.token); // the Worker re-ran its check and refreshed the token
      this.log('GitHub token refreshed');
    }
    this.login = typeof me.login === 'string' ? me.login : '';
    this.allowed = me.friend === true; // the Worker's field is named `friend`; here it is `allowed`
    return {
      status: this.allowed ? 'allowed' : 'denied',
      token: this.token, login: this.login, allowed: this.allowed,
      stale: me.stale === true, checkedAt: me.checked_at,
    };
  }

  // Forget the token here; tell the Worker as a courtesy (it is a no-op there).
  signOut() {
    const token = this.token;
    this.store.remove(TOKEN_KEY);
    this.login = '';
    this.allowed = false;
    if (!token) return Promise.resolve();
    return this.fetch(`${this.authBase}logout`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
      .then(() => undefined, () => undefined);
  }
}
