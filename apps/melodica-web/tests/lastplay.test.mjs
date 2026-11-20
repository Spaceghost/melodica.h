import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { AudioCopies } from '../dist/lastplay.js';

const song = (overrides = {}) => ({
  trackToken: 'track-1', audioUrl: 'https://audio.pandora.com/song.m4a?token=private', ...overrides,
});

function memoryCaches() {
  const entries = new Map();
  const cache = {
    match: async (key) => entries.get(typeof key === 'string' ? key : key.url),
    put: async (key, value) => entries.set(typeof key === 'string' ? key : key.url, value),
    delete: async (key) => entries.delete(typeof key === 'string' ? key : key.url),
    keys: async () => [...entries.keys()].map((url) => new Request(url)),
  };
  return { entries, caches: { open: async () => cache, delete: async () => { entries.clear(); return true; } } };
}

test('readBlob returns a cached copy without making a network request', async () => {
  const { entries, caches } = memoryCaches();
  const expected = new Blob(['cached audio'], { type: 'audio/mp4' });
  entries.set('https://app.example/melodica/__audio/track-1', new Response(expected));
  let requests = 0;
  const copies = new AudioCopies({ caches, origin: 'https://app.example', fetch: async () => { requests += 1; throw new Error('unexpected fetch'); } });

  const actual = await copies.readBlob(song());
  assert.equal(await actual.text(), 'cached audio');
  assert.equal(actual.type, 'audio/mp4');
  assert.equal(requests, 0);
});

test('readBlob fetches through the authenticated relay even when persistent caching is disabled', async () => {
  let request;
  const signal = new AbortController().signal;
  const copies = new AudioCopies({
    caches: null,
    relayRequest: (url) => {
      assert.equal(url, song().audioUrl);
      return ['/scrobble/api/?audio=encoded', { credentials: 'omit', headers: { 'x-melodica-access': 'access-token' } }];
    },
    fetch: async (url, init) => {
      request = { url, init };
      return new Response('live audio', { headers: { 'content-type': 'audio/aac' } });
    },
    origin: 'https://app.example',
  });

  const actual = await copies.readBlob(song(), { signal });
  assert.equal(await actual.text(), 'live audio');
  assert.equal(actual.type, 'audio/aac');
  assert.equal(request.url, '/scrobble/api/?audio=encoded');
  assert.equal(request.init.credentials, 'omit');
  assert.equal(request.init.headers['x-melodica-access'], 'access-token');
  assert.equal(request.init.signal, signal);
  assert.notEqual(request.init.mode, 'no-cors');
});

test('readBlob uses readable CORS mode for non-Pandora audio hosts', async () => {
  let request;
  const copies = new AudioCopies({
    caches: null,
    relayRequest: () => null,
    fetch: async (url, init) => { request = { url, init }; return new Response('direct audio'); },
    origin: 'https://app.example',
  });
  await copies.readBlob(song({ audioUrl: 'https://melodica-tuner.example/song.m4a' }));
  assert.equal(request.url, 'https://melodica-tuner.example/song.m4a');
  assert.equal(request.init.mode, 'cors');
  assert.equal(request.init.credentials, 'omit');
});

test('readBlob reports HTTP failures clearly and never accepts opaque responses', async (t) => {
  await t.test('HTTP failure', async () => {
    const copies = new AudioCopies({ caches: null, origin: 'https://app.example', fetch: async () => new Response('unavailable', { status: 502, statusText: 'Bad Gateway' }) });
    await assert.rejects(copies.readBlob(song()), /HTTP 502 Bad Gateway/);
  });
  await t.test('opaque response', async () => {
    const copies = new AudioCopies({ caches: null, origin: 'https://app.example', fetch: async () => ({ type: 'opaque', ok: false, status: 0, blob: async () => new Blob(['hidden']) }) });
    await assert.rejects(copies.readBlob(song()), /response is not readable/);
  });
});

test('readBlob propagates aborts and rejects inserts or missing URLs', async () => {
  const controller = new AbortController();
  controller.abort(new DOMException('Stopped', 'AbortError'));
  const copies = new AudioCopies({ caches: null, origin: 'https://app.example', fetch: async () => { throw new Error('unexpected fetch'); } });
  await assert.rejects(copies.readBlob(song(), { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(copies.readBlob(song({ isInsert: true })), /cannot be shared/);
  await assert.rejects(copies.readBlob(song({ audioUrl: '' })), /no audio URL/);
});

test('save still shares relay fetch policy and drop aborts its in-flight cache copy', async () => {
  const { caches } = memoryCaches();
  let request;
  const copies = new AudioCopies({
    caches,
    origin: 'https://app.example',
    relayRequest: () => ['/audio-proxy', { credentials: 'omit', headers: { 'x-melodica-access': 'token' } }],
    fetch: (url, init) => {
      request = { url, init };
      return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true }));
    },
  });
  const pending = copies.save(song());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(request.url, '/audio-proxy');
  assert.equal(request.init.credentials, 'omit');
  assert.equal(request.init.headers['x-melodica-access'], 'token');
  await copies.drop('track-1');
  assert.equal(await pending, false);
  assert.equal(await copies.has('track-1'), false);
});
