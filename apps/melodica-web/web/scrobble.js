// melodica-web: Spaceghost Scrobbles (https://spacegho.st/scrobble/, the spaceghost-scrobble
// Worker on the page's own origin). Listens go there by default; the user can turn it off
// (the account's `scrobbling` setting, kept by the server). The bearer is the melodica
// access token (the relay's x-melodica-access, or the extension's login-ok token kept
// with a shared session) or the spacegho.st account's token.
//
// Only the side whose audio plays submits (docs/BRIDGE.md 3): in remote mode the
// extension submits and the page only reads. Ads are never submitted. No DOM here.

export const BASE_PATH = '/scrobble';
export const SUBMISSION_CLIENT = 'melodica-web';
export const MIN_TRACK_S = 30;      // tracks of 30 s or less never count
export const MAX_NEEDED_S = 240;    // 4 minutes of play always counts
export const PAGE_SIZE = 15;

// Seconds of play after which a track counts as listened: half its length or 4 minutes,
// whichever comes first; Infinity for tracks of 30 s or less (or of unknown length).
export function listenThreshold(durationS) {
  const d = Number(durationS);
  if (!Number.isFinite(d) || d <= MIN_TRACK_S) return Infinity;
  return Math.min(d / 2, MAX_NEEDED_S);
}

// The ListenBrainz track_metadata for a song (no station, Pandora ids or stream URLs).
export function trackMetadata(song, durationS) {
  const info = { submission_client: SUBMISSION_CLIENT };
  const d = Number(durationS);
  if (Number.isFinite(d) && d > 0) info.duration_ms = Math.round(d * 1000);
  if (typeof song.coverArt === 'string' && /^https:\/\//.test(song.coverArt)) info.art_url = song.coverArt;
  const m = { artist_name: String(song.artist || ''), track_name: String(song.title || ''), additional_info: info };
  if (song.album) m.release_name = String(song.album);
  return m;
}

export class ScrobbleError extends Error {
  constructor(status, code, message) {
    super(message || `Scrobbles answered HTTP ${status}`);
    this.name = 'ScrobbleError';
    this.status = status;
    this.code = code || '';
  }
}

export class Scrobbles {
  // token(): the bearer to use now, or ''.
  constructor({ origin, fetch: fetchImpl, token } = {}) {
    this.base = `${origin}${BASE_PATH}`;
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
    this.token = token || (() => '');
  }

  get links() {
    // The pages under /melodica/ (spaceghost-scrobble docs/CLIENTS.md); the old /scrobble/ pages redirect there.
    const site = this.base.slice(0, -BASE_PATH.length);
    return { dashboard: `${site}/melodica/listens/`, leaderboard: `${site}/melodica/leaderboard/`, crew: `${site}/melodica/map/` };
  }

  async call(path, init = {}) {
    const t = await this.token();
    if (!t) throw new ScrobbleError(0, 'no_token', 'Not signed in.');
    let res;
    try {
      res = await this.fetch(`${this.base}/api/${path}`, {
        ...init, cache: 'no-store', credentials: 'omit',
        headers: { ...(init.headers || {}), authorization: `Bearer ${t}` },
      });
    } catch (err) {
      throw new ScrobbleError(0, 'network', 'Scrobbles could not be reached.');
    }
    let body = null;
    try { body = await res.json(); } catch (_) { /* below */ }
    if (!res.ok) throw new ScrobbleError(res.status, body && body.error, body && body.message);
    return body || {};
  }

  // {account: {github}, settings: {name, scrobbling, leaderboard, crew, ...}, crew_viewer, recent, next_cursor}
  me() { return this.call('me'); }
  settings() { return this.call('me/settings'); }
  setSettings(patch) {
    return this.call('me/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
  }
  // {listens: [{id, listened_at, artist, title, album?, art?, duration_ms?}], next_cursor}
  listens(before = '', limit = PAGE_SIZE) {
    const q = new URLSearchParams({ limit: String(limit) });
    if (before) q.set('before', before);
    return this.call(`me/listens?${q}`);
  }
  submit(listenType, song, durationS, listenedAt) {
    const entry = { track_metadata: trackMetadata(song, durationS) };
    if (listenType === 'single') entry.listened_at = Math.floor(listenedAt);
    return this.call('me/listens', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ listen_type: listenType, payload: [entry] }),
    });
  }
}

// One play of one song, fed with the audio element's clock. tick(currentTime, playing)
// adds only forward progress while playing (Pandora has no seeking), so a pause or a
// stall never counts. due() is true once, when the play has reached the threshold.
export class ListenTracker {
  constructor(song, startedAtS, durationS) {
    this.song = song;
    this.startedAt = startedAtS;
    this.duration = Number(durationS) || 0;
    this.played = 0;
    this.last = null;
    this.sent = false;
  }
  setDuration(d) { if (!this.duration && Number.isFinite(d) && d > 0) this.duration = d; }
  tick(currentTime, playing) {
    const t = Number(currentTime);
    if (!Number.isFinite(t)) return;
    if (playing && this.last !== null) {
      const step = t - this.last;
      if (step > 0 && step < 5) this.played += step; // a jump (new source, reload) is not play
    }
    this.last = t;
  }
  due() {
    if (this.sent || this.song.isAd) return false;
    return this.played >= listenThreshold(this.duration);
  }
}
