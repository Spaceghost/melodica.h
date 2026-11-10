import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { compile } from 'imba/compiler';
import { validatePlayback } from '../src/playback-transfer.js';

const source = await readFile(new URL('../src/engine.imba', import.meta.url), 'utf8');
const compiled = compile(source, { platform: 'node', format: 'esm', sourcePath: 'src/engine.imba', raiseErrors: true });
await mkdir(new URL('../build/node/', import.meta.url), { recursive: true });
await writeFile(new URL('../build/node/engine-transfer.js', import.meta.url), compiled.js);
const { Engine } = await import('../build/node/engine-transfer.js');

const sid = 'same-device-session-id';
const song = (token = 'T1') => ({ title: token, artist: 'Band', album: 'Album', audioUrl: `https://audio.pandora.com/${token}.m4a`, trackToken: token, duration: 200 });
const playback = (patch = {}) => ({ v: 1, sid, at: Date.now(), station: { id: 'S1', name: 'Station' }, song: song(),
  queue: [song('T2'), song('T3')], position: 37.5, duration: 200, volume: 65, quality: 'high', status: 'playing', ...patch });

test('private transfer validation binds fresh playback to the current session', () => {
  assert.equal(validatePlayback(playback(), sid).song.trackToken, 'T1');
  for (const patch of [{ sid: 'another-account' }, { v: 2 }, { at: Date.now() - 31 * 60_000 }, { at: Date.now() + 60000 },
    { position: -1 }, { position: Infinity }, { status: 'loading' }, { song: { ...song(), ad: true } },
    { song: { ...song(), audioUrl: 'javascript:alert(1)' } }, { song: { ...song(), audioUrl: 'https://evil.example/audio.mp3' } },
    { song: { ...song(), audioUrl: 'https://user:secret@audio.pandora.com/T1.m4a' } }, { station: { id: '../outside' } }]) {
    assert.equal(validatePlayback(playback(patch), sid), null, JSON.stringify(patch));
  }
  assert.equal(validatePlayback(playback({ song: { ...song(), audioUrl: 'http://127.0.0.1:8443/test.m4a' } }), sid), null);
  assert.ok(validatePlayback(playback({ song: { ...song(), audioUrl: 'http://127.0.0.1:8443/test.m4a' } }), sid, 'https://127.0.0.1:8443/services/json/'));
});

test('validated handoffs preserve bounded genome and same-session listen provenance only', () => {
  const marker = { sid, trackToken: 'T1', startedAt: Math.floor(Date.now() / 1000) - 30, sent: true, played: 12.5 };
  const validated = validatePlayback(playback({ song: { ...song(), genome: ['minor key', 'guitar'], melodicaPlay: marker } }), sid);
  assert.deepEqual(validated.song.genome, ['minor key', 'guitar']);
  assert.deepEqual(validated.song.melodicaPlay, marker);
  assert.equal(validated.played, true);
  assert.equal(validatePlayback(playback({ song: { ...song(), genome: ['x'.repeat(65)], melodicaPlay: marker } }), sid).song.genome.length, 0);
  for (const forged of [
    { ...marker, sid: 'another-session' },
    { ...marker, trackToken: 'T2' },
    { ...marker, startedAt: Date.now() / 1000 + 301 },
    { ...marker, sent: 'yes' },
    { ...marker, played: -1 },
    { ...marker, played: 206 },
  ]) {
    const result = validatePlayback(playback({ played: true, song: { ...song(), melodicaPlay: forged } }), sid);
    assert.equal(result.song.melodicaPlay, undefined);
    assert.equal(result.played, false, 'unvalidated provenance cannot assert that audio was heard');
  }
});

class Audio extends EventTarget {
  paused = true; ended = false; readyState = 1; currentTime = 0; duration = 200; src = ''; error = null;
  async play() { this.paused = false; this.dispatchEvent(new Event('play')); }
  pause() { if (!this.paused) { this.paused = true; this.dispatchEvent(new Event('pause')); } }
  load() { this.error = null; if (this.src.startsWith('blob:')) this.readyState = 2; }
  removeAttribute(key) { if (key === 'src') this.src = ''; }
}
function engine() {
  const saves = [], reports = [];
  let playlistCalls = 0;
  const e = new Engine({ document: { createElement: () => new Audio(), body: { appendChild() {} } },
    api: { playlist: () => { playlistCalls++; throw new Error('transfer must not fetch a playlist'); } },
    remember: (r) => saves.push(r), report: (r) => reports.push(r) });
  return { e, saves, reports, calls: () => playlistCalls };
}

test('engine transfer preserves signed media, exact position and queued songs without a playlist request', async () => {
  const { e, saves, calls } = engine();
  const p = validatePlayback(playback(), sid);
  await e.importPlayback(p);
  assert.equal(e.audio.src, p.song.audioUrl);
  assert.equal(e.audio.currentTime, 37.5);
  assert.equal(e.audio.paused, false);
  assert.equal(e.snapshot.status, 'playing');
  assert.equal(saves.length, 1, 'save only after its own audio play event');
  const exported = e.exportPlayback();
  assert.equal(exported.played, true);
  assert.equal(exported.song.audioUrl, p.song.audioUrl);
  assert.equal(exported.position, 37.5);
  assert.deepEqual(exported.queue.map((s) => s.trackToken), ['T2', 'T3']);
  assert.equal(calls(), 0);
  e.pause();
  await e.resume();
  assert.equal(e.audio.currentTime, 37.5);
  await e.skip();
  assert.equal(e.snapshot.track.trackToken, 'T2');
  assert.equal(calls(), 0, 'next uses transferred playlist remainder');
  assert.equal(e.snapshot.queue[0].audioUrl, undefined, 'ordinary queue metadata stays public');
  const longQueue = Array.from({ length: 7 }, (_, i) => song('next' + i));
  await e.importPlayback(validatePlayback(playback({ queue: longQueue, status: 'paused' }), sid));
  assert.deepEqual(e.exportPlayback().queue, longQueue, 'live handoff keeps more than the four saved-resume songs');
});

test('ordinary source stays playable without CORS while DJ capture switches the same player to a clean cached Blob', async () => {
  const oldCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  const oldFetch = globalThis.fetch;
  let saved = null;
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: { open: async () => ({
    keys: async () => [], delete: async () => true,
    match: async () => saved?.clone() || null,
    put: async (_key, value) => { saved = value.clone(); },
  }) } });
  globalThis.fetch = async () => new Response(new Blob([new Uint8Array([0, 1, 2, 3])], { type: 'audio/mp4' }));
  try {
    const { e } = engine();
    const p = validatePlayback(playback(), sid);
    await e.importPlayback(p);
    assert.equal(e.audio.crossOrigin, undefined, 'private radio uses normal media loading for a CDN without ACAO');
    assert.equal(e.audio.src, p.song.audioUrl);
    e.audio.currentTime = 37.5;
    await e.preparePlayerAudioForCapture();
    assert.match(e.audio.src, /^blob:/, 'room capture uses the origin-clean cached copy');
    assert.ok(Math.abs(e.audio.currentTime - 37.5) < 0.01, 'source change preserves the track position');
    assert.equal(e.audio.paused, false, 'the same player keeps playing after its source is prepared');
  } finally {
    globalThis.fetch = oldFetch;
    if (oldCaches) Object.defineProperty(globalThis, 'caches', oldCaches);
    else delete globalThis.caches;
  }
});

test('DJ capture can prepare a clean Blob with Cache Storage unavailable', async () => {
  const oldCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  const oldFetch = globalThis.fetch;
  if (oldCaches) delete globalThis.caches;
  globalThis.fetch = async () => new Response(new Blob([new Uint8Array([4, 3, 2, 1])], { type: 'audio/mp4' }));
  try {
    const { e } = engine();
    const p = validatePlayback(playback(), sid);
    await e.importPlayback(p);
    await e.preparePlayerAudioForCapture();
    assert.match(e.audio.src, /^blob:/, 'the privileged fetch fallback supports DJ capture without persistent cache');
    assert.equal(e.audio.paused, false);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldCaches) Object.defineProperty(globalThis, 'caches', oldCaches);
  }
});

test('pausing during blob buffering remains authoritative', async () => {
  const oldCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  const oldFetch = globalThis.fetch;
  if (oldCaches) delete globalThis.caches;
  globalThis.fetch = async () => new Response(new Blob([new Uint8Array([4, 3, 2, 1])], { type: 'audio/mp4' }));
  try {
    const { e } = engine();
    const p = validatePlayback(playback(), sid);
    await e.importPlayback(p);
    e.audio.load = () => { if (e.audio.src.startsWith('blob:')) e.audio.readyState = 1; };
    const preparing = e.preparePlayerAudioForCapture();
    await new Promise((resolve) => setTimeout(resolve, 30));
    e.pause();
    e.audio.readyState = 2;
    await preparing;
    assert.equal(e.audio.paused, true, 'preparation does not resume audio after an explicit pause');
    assert.equal(e.snapshot.status, 'paused');
  } finally {
    globalThis.fetch = oldFetch;
    if (oldCaches) Object.defineProperty(globalThis, 'caches', oldCaches);
  }
});

test('a track change during uncached fetch leaves the new private source untouched', async () => {
  const oldCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  const oldFetch = globalThis.fetch;
  if (oldCaches) delete globalThis.caches;
  let finishFetch;
  globalThis.fetch = () => new Promise((resolve) => { finishFetch = resolve; });
  try {
    const { e } = engine();
    const p = validatePlayback(playback(), sid);
    await e.importPlayback(p);
    const original = e.audio.src;
    const preparing = e.preparePlayerAudioForCapture();
    while (!finishFetch) await new Promise((resolve) => setTimeout(resolve, 0));
    e.generation++;
    e.state.track = song('T2');
    e.audio.src = e.state.track.audioUrl;
    finishFetch(new Response(new Blob([new Uint8Array([4, 3, 2, 1])], { type: 'audio/mp4' })));
    await assert.rejects(preparing, /player changed tracks/);
    assert.equal(e.audio.src, song('T2').audioUrl, 'stale preparation never replaces the new track');
    assert.notEqual(e.audio.src, original);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldCaches) Object.defineProperty(globalThis, 'caches', oldCaches);
  }
});

test('a track change while the clean blob buffers clears only the stale capture marker', async () => {
  const oldCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  const oldFetch = globalThis.fetch;
  if (oldCaches) delete globalThis.caches;
  globalThis.fetch = async () => new Response(new Blob([new Uint8Array([4, 3, 2, 1])], { type: 'audio/mp4' }));
  try {
    const { e } = engine();
    await e.importPlayback(validatePlayback(playback(), sid));
    e.audio.load = () => { if (e.audio.src.startsWith('blob:')) e.audio.readyState = 1; };
    const preparing = e.preparePlayerAudioForCapture();
    while (!e.preparingSource) await new Promise((resolve) => setTimeout(resolve, 0));
    const staleBlobUrl = e.preparingSource;
    e.start(song('T2'));
    await assert.rejects(preparing, /player changed tracks before audio capture was ready/);
    assert.equal(e.audio.src, song('T2').audioUrl);
    assert.equal(e.preparingSource, null, 'only the old capture marker is cleared');
    assert.notEqual(e.copyUrl, staleBlobUrl, 'the old capture URL is released by the normal track-change path');
  } finally {
    globalThis.fetch = oldFetch;
    if (oldCaches) Object.defineProperty(globalThis, 'caches', oldCaches);
  }
});

test('a failing clean blob load restores the original private source and suppresses its own media error', async () => {
  const oldCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  const oldFetch = globalThis.fetch;
  if (oldCaches) delete globalThis.caches;
  globalThis.fetch = async () => new Response(new Blob([new Uint8Array([4, 3, 2, 1])], { type: 'audio/mp4' }));
  try {
    const { e } = engine();
    const p = validatePlayback(playback(), sid);
    await e.importPlayback(p);
    const original = e.audio.src;
    e.audio.load = () => {
      if (!e.audio.src.startsWith('blob:')) { e.audio.readyState = 2; return; }
      e.audio.readyState = 0;
      e.audio.error = { code: 4 };
      e.audio.dispatchEvent(new Event('error'));
    };
    await assert.rejects(e.preparePlayerAudioForCapture(), /Private playback was restored/);
    assert.equal(e.audio.src, original);
    assert.equal(e.audio.paused, false, 'the player resumes the original source after blob decode fails');
    assert.equal(e.snapshot.track.trackToken, 'T1', 'an internal blob error does not auto-skip the private song');
  } finally {
    globalThis.fetch = oldFetch;
    if (oldCaches) Object.defineProperty(globalThis, 'caches', oldCaches);
  }
});

test('a stale blob-buffer completion cannot restore or seek over the next private track', async () => {
  const oldCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  const oldFetch = globalThis.fetch;
  if (oldCaches) delete globalThis.caches;
  globalThis.fetch = async () => new Response(new Blob([new Uint8Array([4, 3, 2, 1])], { type: 'audio/mp4' }));
  try {
    const { e } = engine();
    await e.importPlayback(validatePlayback(playback(), sid));
    const oldSource = e.audio.src;
    e.audio.load = () => {
      e.audio.error = null;
      if (e.audio.src.startsWith('blob:')) {
        e.audio.blobLoadFailed = true;
        e.audio.readyState = 0; e.audio.error = { code: 4 }; e.audio.dispatchEvent(new Event('error'));
      } else e.audio.readyState = 0;
    };
    const preparing = e.preparePlayerAudioForCapture();
    while (!e.audio.blobLoadFailed || e.audio.src !== oldSource) await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 30));
    e.generation++;
    e.state.track = song('T2');
    e.audio.src = e.state.track.audioUrl;
    e.audio.readyState = 2;
    await assert.rejects(preparing, /player changed tracks before private audio could be restored/);
    assert.equal(e.audio.src, song('T2').audioUrl);
    assert.equal(e.copyUrl, null, 'stale restoration does not clear or revoke a newer copy URL');
    assert.equal(e.audio.paused, true, 'stale restoration cannot restart a new track');
  } finally {
    globalThis.fetch = oldFetch;
    if (oldCaches) Object.defineProperty(globalThis, 'caches', oldCaches);
  }
});

test('paused or autoplay-blocked transfers do not save an unheard song', async () => {
  for (const blocked of [false, true]) {
    const { e, saves, calls } = engine();
    if (blocked) e.audio.play = () => Promise.reject(Object.assign(new Error('gesture required'), { name: 'NotAllowedError' }));
    await e.importPlayback(validatePlayback(playback({ status: blocked ? 'playing' : 'paused' }), sid));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(e.audio.paused, true);
    e.pause(); e.saveLast();
    assert.equal(saves.length, 0);
    assert.equal(calls(), 0);
    assert.equal(e.snapshot.status, 'paused');
    assert.equal(e.exportPlayback().played, false);
  }
});

test('heard provenance survives paused engine recreation and cannot be forged by import', async () => {
  const { e, saves } = engine();
  const p = validatePlayback(playback({ status: 'paused', played: true }), sid);
  await e.importPlayback(p);
  assert.equal(e.exportPlayback().played, false);
  const replacement = engine();
  await replacement.e.hydrate(e.snapshot);
  replacement.e.saveLast();
  assert.equal(replacement.e.exportPlayback().played, false);
  assert.equal(replacement.saves.length, 0);
  await e.resume(); e.pause();
  assert.equal(e.exportPlayback().played, true);
  const heard = engine();
  await heard.e.hydrate({ ...e.snapshot, last: saves.at(-1) });
  assert.equal(heard.e.exportPlayback().played, true);
  const trustedTransfer = engine();
  const trusted = validatePlayback(playback({ status: 'paused', song: { ...song(), melodicaPlay: {
    sid, trackToken: 'T1', startedAt: Math.floor(Date.now() / 1000) - 30, sent: true, played: 12.5,
  } } }), sid);
  await trustedTransfer.e.importPlayback(trusted);
  assert.equal(trustedTransfer.e.exportPlayback().played, true);
});

test('a late play event cannot undo a held pause and reports have a strict order', async () => {
  const { e, reports } = engine();
  await e.importPlayback(validatePlayback(playback(), sid));
  e.pause();
  e.audio.paused = false;
  e.audio.dispatchEvent(new Event('play'));
  assert.equal(e.audio.paused, true);
  assert.equal(e.snapshot.status, 'paused');
  for (let i = 1; i < reports.length; i++) assert.ok(reports[i].changedAt > reports[i - 1].changedAt);
  await e.resume();
  assert.equal(e.snapshot.status, 'playing');
});
