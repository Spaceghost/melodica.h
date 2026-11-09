// Private engine handoff. Signed media URLs belong only in direct bridge replies
// and encrypted device storage, never in public state or localStorage snapshots.
export function validatePlayback(input, sid, endpoint = 'https://tuner.pandora.com/') {
  if (!input || input.v !== 1 || typeof sid !== 'string' || !sid || input.sid !== sid) return null;
  const at = Number(input.at);
  if (!Number.isFinite(at) || at > Date.now() + 5000 || Date.now() - at > 30 * 60_000) return null;
  if (!['playing', 'paused'].includes(input.status)) return null;
  const position = Number(input.position);
  if (!Number.isFinite(position) || position < 0 || position > 86400) return null;
  const id = input.station && (input.station.id || input.station.token);
  if (typeof id !== 'string' || !/^[A-Za-z0-9]{1,128}$/.test(id)) return null;
  let endpointHost;
  try { endpointHost = new URL(endpoint).hostname; } catch { return null; }
  const song = (t) => {
    if (!t || t.ad || t.isInsert || typeof t.trackToken !== 'string' || !t.trackToken || t.trackToken.length > 8192) return null;
    if (typeof t.audioUrl !== 'string' || t.audioUrl.length > 16384) return null;
    let u;
    try { u = new URL(t.audioUrl); } catch { return null; }
    if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.hash) return null;
    if (!/(^|\.)(pandora\.com|p-cdn\.us|p-cdn\.com)$/i.test(u.hostname) && u.hostname !== endpointHost) return null;
    const out = { trackToken: t.trackToken, audioUrl: t.audioUrl };
    for (const key of ['title', 'artist', 'album', 'coverArt', 'audioFormat', 'quality']) {
      if (typeof t[key] === 'string') out[key] = t[key].slice(0, key === 'coverArt' ? 4096 : 512);
    }
    for (const key of ['duration', 'gain', 'rating', 'fetchedAt']) if (Number.isFinite(Number(t[key]))) out[key] = Number(t[key]);
    return out;
  };
  const current = song(input.song);
  if (!current) return null;
  const queue = Array.isArray(input.queue) ? input.queue.slice(0, 20).map(song).filter(Boolean) : [];
  return { v: 1, sid, at, station: { id, name: String(input.station.name || '').slice(0, 512) },
    song: current, queue, position, duration: Math.max(0, Math.min(86400, Number(input.duration) || current.duration || 0)),
    status: input.status, quality: ['high', 'medium', 'low'].includes(input.quality) ? input.quality : 'high',
    volume: Number.isFinite(Number(input.volume)) ? Math.max(0, Math.min(100, Number(input.volume))) : 80 };
}
