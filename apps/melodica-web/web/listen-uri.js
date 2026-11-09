// listen:// URIs (docs/LISTEN-URI.md): parse and build. The same rules are implemented by
// every client; this module is the reference and is what the tests pin.
//
//   listen://artist/<name>            listen://genre/<name>
//   listen://station/<id or token>    listen://track/<id>?t=<seconds>
//   listen://map/<land>[/<province>]  listen://user/<username>
//   listen://listens                  listen://leaderboard
//
// Also accepted with the same paths: web+listen://… (the browser alias) and
// https://spacegho.st/listen/… (the shareable link).

export const HTTPS_BASE = 'https://spacegho.st/listen/';
const MAX_TEXT = 200;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const USERNAME = /^[a-z0-9][a-z0-9_-]{1,38}[a-z0-9]$/;
const STATION = /^[A-Za-z0-9]{1,64}$/;
const TRACK = /^(?:[0-9a-f]{64}|[A-Za-z0-9]{1,64})$/;

// target -> [segment rules], allowed query keys
const TARGETS = {
  artist: { segs: ['text'], query: [] },
  genre: { segs: ['text'], query: [] },
  station: { segs: ['station'], query: [] },
  track: { segs: ['track'], query: ['t'] },
  map: { segs: ['slug', 'slug?'], query: [] },
  user: { segs: ['username'], query: [] },
  listens: { segs: [], query: [] },
  leaderboard: { segs: [], query: [] },
};
const FIELD = { artist: ['name'], genre: ['name'], station: ['station'], track: ['track'], map: ['land', 'province'], user: ['username'], listens: [], leaderboard: [] };

function decodeSeg(raw) {
  if (!/^[A-Za-z0-9\-._~%!$&'()*+,;=:@]*$/.test(raw)) return null;
  let s;
  try { s = decodeURIComponent(raw); } catch { return null; }
  if (!s || s.length > MAX_TEXT || /[\u0000-\u001f\u007f/\\]/.test(s) || s !== s.trim()) return null;
  if (s === '.' || s === '..') return null; // never a path step in the https form
  return s.normalize('NFC');
}

function checkSeg(rule, v) {
  switch (rule.replace('?', '')) {
    case 'text': return v;
    case 'slug': return SLUG.test(v) ? v : null;
    case 'username': return USERNAME.test(v) ? v : null;
    case 'station': return STATION.test(v) ? v : null;
    case 'track': return TRACK.test(v) ? v : null;
    default: return null;
  }
}

// {target, name?|station?|track?|land?|province?|username?, t?, uri, web, https} or null.
export function parseListenUri(input) {
  if (typeof input !== 'string' || input.length > 1024) return null;
  let rest;
  const m = /^(listen|web\+listen):\/\/(.*)$/i.exec(input);
  if (m) rest = m[2];
  else if (input.toLowerCase().startsWith(HTTPS_BASE)) rest = input.slice(HTTPS_BASE.length);
  else return null;
  if (rest.includes('#')) return null;
  const q = rest.indexOf('?');
  const path = q >= 0 ? rest.slice(0, q) : rest;
  const query = q >= 0 ? rest.slice(q + 1) : '';
  const parts = path.replace(/\/$/, '').split('/');
  const target = parts.shift().toLowerCase();
  const spec = Object.hasOwn(TARGETS, target) ? TARGETS[target] : null;
  if (!spec) return null;
  const required = spec.segs.filter((r) => !r.endsWith('?')).length;
  if (parts.length < required || parts.length > spec.segs.length) return null;
  const out = { target };
  for (let i = 0; i < parts.length; i++) {
    const v = decodeSeg(parts[i]);
    const ok = v === null ? null : checkSeg(spec.segs[i], v);
    if (ok === null) return null;
    out[FIELD[target][i]] = ok;
  }
  if (query) {
    for (const pair of query.split('&')) {
      const [k, v = ''] = pair.split('=');
      if (!spec.query.includes(k) || Object.hasOwn(out, k)) return null;
      if (k === 't') {
        if (!/^\d{1,5}$/.test(v) || Number(v) > 86400) return null;
        out.t = Number(v);
      }
    }
  }
  return { ...out, ...forms(out) };
}

// The three forms of a parsed target.
function forms(o) {
  const segs = FIELD[o.target].filter((f) => o[f] !== undefined).map((f) => encodeURIComponent(o[f]));
  const path = [o.target, ...segs].join('/') + (o.t !== undefined ? `?t=${o.t}` : '');
  return { uri: `listen://${path}`, web: `web+listen://${path}`, https: `${HTTPS_BASE}${path}` };
}

// Build from {target, ...fields}; null when it would not parse back.
export function listenUri(o) {
  if (!o || !Object.hasOwn(TARGETS, o.target)) return null;
  const f = forms(o);
  return parseListenUri(f.uri) ? f : null;
}

// Where spacegho.st sends each target (the shell route; clients may handle it in place).
export function routeOf(p) {
  switch (p.target) {
    case 'artist': case 'genre': return `/melodica/app/?seed=${p.target}:${encodeURIComponent(p.name)}`;
    case 'station': return `/melodica/app/?station=${encodeURIComponent(p.station)}`;
    case 'track': return `/melodica/listens/?track=${encodeURIComponent(p.track)}${p.t !== undefined ? `&t=${p.t}` : ''}`;
    case 'map': return `/melodica/map/?land=${encodeURIComponent(p.land)}${p.province ? `&province=${encodeURIComponent(p.province)}` : ''}`;
    case 'user': return `/melodica/leaderboard/?user=${encodeURIComponent(p.username)}`;
    case 'listens': return '/melodica/listens/';
    case 'leaderboard': return '/melodica/leaderboard/';
    default: return '/melodica/';
  }
}
