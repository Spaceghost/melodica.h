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

class Audio extends EventTarget {
  paused = true; ended = false; readyState = 1; currentTime = 0; duration = 200; src = '';
  async play() { this.paused = false; this.dispatchEvent(new Event('play')); }
  pause() { if (!this.paused) { this.paused = true; this.dispatchEvent(new Event('pause')); } }
  load() {}
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
