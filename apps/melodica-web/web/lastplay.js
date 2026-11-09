// melodica-web: the song this device played last, so a reload, a back/forward or a
// new visit shows it paused where it was with Resume (docs/BRIDGE.md 5.2), and a copy
// of its audio for when its link has expired.
//
// The record lives in the encrypted store (web/vault.js, record "last"), written only
// by the device that plays. On that same device an explicit extension bridge
// export can mirror its actual play and cached bytes; remotes never fetch its media.
// Copies are in the Cache API, keyed by track token: the playing song and the next one
// at most; a copy is deleted when its song finishes. A full disk (quota) only means no
// copy.

export const LAST_ID = 'last';
// Pandora's audio links carry no expiry the client can read; they are treated as
// stale this long after the playlist that brought them (an estimate, on the safe side).
export const AUDIO_URL_MS = 50 * 60_000;
export const QUEUE_MAX = 8;
const CACHE = 'melodica-audio-v1';
const SONG_FIELDS = ['trackToken', 'title', 'artist', 'album', 'coverArt', 'audioUrl', 'audioFormat', 'duration', 'fileGain', 'rating',
  'quality', 'fetchedAt', 'stationId', 'songDetailUrl', 'artistDetailUrl', 'albumDetailUrl', 'musicId', 'trackGain'];

export function songRecord(song) {
  const out = {};
  for (const k of SONG_FIELDS) if (song[k] !== undefined && song[k] !== null) out[k] = song[k];
  return out;
}

// {v, station: {id, name}, song, position, queue, savedAt}: the station's own songs only.
export function lastRecord({ station, song, position, queue, now = Date.now() }) {
  if (!station || !song || song.isInsert || !song.trackToken) return null;
  return {
    v: 1, station: { id: station.id, name: station.name || '' }, song: songRecord(song),
    position: Math.max(0, Number(position) || 0),
    queue: (queue || []).filter((s) => s && !s.isInsert && s.trackToken).slice(0, QUEUE_MAX).map(songRecord),
    savedAt: now,
  };
}

export function validLast(rec) {
  return !!(rec && rec.v === 1 && rec.station && rec.station.id && rec.song && rec.song.trackToken);
}

export function urlExpired(song, now = Date.now()) {
  return !song || !song.audioUrl || !(Number(song.fetchedAt) > 0) || now > Number(song.fetchedAt) + AUDIO_URL_MS;
}

export class AudioCopies {
  // relayRequest(url) -> [url, init] for the relay's audio stream, or null (fetch directly).
  constructor({ caches = globalThis.caches, fetch = globalThis.fetch.bind(globalThis), relayRequest = () => null, origin = globalThis.location.origin, log = () => {} } = {}) {
    this.caches = caches;
    this.fetch = fetch;
    this.relayRequest = relayRequest;
    this.origin = origin;
    this.log = log;
    this.inflight = new Map(); // token -> AbortController
    this.off = !caches;
  }

  key(token) { return `${this.origin}/melodica/__audio/${encodeURIComponent(token)}`; }

  async open() { return this.caches.open(CACHE); }

  async has(token) {
    if (this.off || !token) return false;
    try { return !!(await (await this.open()).match(this.key(token))); } catch (_) { return false; }
  }

  // Downloads the song's audio once; true when a copy is kept.
  async save(song) {
    if (this.off || !song || song.isInsert || !song.trackToken || !song.audioUrl) return false;
    const token = song.trackToken;
    if (this.inflight.has(token) || await this.has(token)) return true;
    const ctl = new AbortController();
    this.inflight.set(token, ctl);
    try {
      // Pandora's CDN sent no CORS headers when checked (2026-11-08), and the page's CSP
      // allows only its own origin, so its audio comes through the relay; other hosts
      // (melodica-tuner in the tests) directly.
      const via = this.relayRequest(song.audioUrl);
      const r = via ? await this.fetch(via[0], { ...via[1], signal: ctl.signal })
        : await this.fetch(song.audioUrl, { mode: 'cors', credentials: 'omit', signal: ctl.signal });
      if (!r.ok) return false;
      const blob = await r.blob();
      if (!this.inflight.has(token) || this.inflight.get(token) !== ctl) return false; // dropped meanwhile
      await (await this.open()).put(this.key(token), new Response(blob, { headers: { 'content-type': blob.type || r.headers.get('content-type') || 'audio/mp4', 'content-length': String(blob.size) } }));
      return true;
    } catch (err) {
      this.log(err && err.name === 'QuotaExceededError' ? 'no room for a copy' : `copy failed: ${err && err.message}`);
      return false;
    } finally {
      if (this.inflight.get(token) === ctl) this.inflight.delete(token);
    }
  }

  // Import bytes already cached by this device's extension. No media request.
  async put(token, blob) {
    if (this.off || !token || !blob || !blob.size) return false;
    try {
      await (await this.open()).put(this.key(token), new Response(blob, { headers: {
        'content-type': blob.type || 'audio/mp4', 'content-length': String(blob.size),
      } }));
      return true;
    } catch (err) { this.log(`copy import failed: ${err && err.message}`); return false; }
  }

  async drop(token) {
    const ctl = this.inflight.get(token);
    if (ctl) { this.inflight.delete(token); ctl.abort(); }
    if (this.off || !token) return;
    try { await (await this.open()).delete(this.key(token)); } catch (_) { /* gone */ }
  }

  // Keeps the copies of these tokens only (and stops any other download).
  async keep(tokens) {
    const want = new Set(tokens.filter(Boolean).map((t) => this.key(t)));
    for (const [t, ctl] of this.inflight) if (!want.has(this.key(t))) { this.inflight.delete(t); ctl.abort(); }
    if (this.off) return;
    try {
      const c = await this.open();
      for (const req of await c.keys()) if (!want.has(req.url)) await c.delete(req);
    } catch (_) { /* nothing kept */ }
  }

  // Everything, e.g. on sign-out or when this page becomes a remote.
  async clear() {
    for (const ctl of this.inflight.values()) ctl.abort();
    this.inflight.clear();
    if (this.off) return;
    try { await this.caches.delete(CACHE); } catch (_) { /* none */ }
  }

  // A blob: URL of the copy, or ''.
  async blobUrl(token) {
    if (this.off || !token) return '';
    try {
      const r = await (await this.open()).match(this.key(token));
      return r ? URL.createObjectURL(await r.blob()) : '';
    } catch (_) { return ''; }
  }
}
