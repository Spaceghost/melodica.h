#!/usr/bin/env node
// The link to the melodica extension without a browser or network: a fake window
// records what the page posts and plays the content script's part. Checks the hello
// handshake and its repeats, the message filter (source, origin, melodica marker),
// waitReady (also for an extension that appears late), that a ready without
// `player: true` is not a remote, the subscribe repeated until the first state,
// pushed states, and commands paired with results by id.

import { strict as assert } from 'node:assert';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(process.env.MELODICA_DIST || resolve(here, '..', 'dist'));
const { BridgeTransport, BridgeError, HELLO_WINDOW_MS } = await import(pathToFileURL(resolve(dist, 'bridge.js')).href);
const { PianoClient } = await import(pathToFileURL(resolve(dist, 'piano.js')).href);

const log = (...a) => console.log('[bridge-unit]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A window that is also the only other party: postMessage records the data and
// echoes it to the listeners (same-window delivery, like a browser), and
// `inject` lets the test play the content script.
function fakeWindow(origin = 'https://spacegho.st') {
  const listeners = new Set();
  const win = {
    location: { origin },
    posted: [],
    addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'message') listeners.delete(fn); },
    postMessage(data, targetOrigin) {
      win.posted.push({ data, targetOrigin });
      win.inject(data);
    },
    inject(data, overrides = {}) {
      const ev = { source: win, origin, data, ...overrides };
      for (const fn of [...listeners]) fn(ev);
    },
  };
  return win;
}

assert.equal(HELLO_WINDOW_MS, 3_000, 'hello is repeated for 3 s');
assert.equal('bridge' in new PianoClient({ apiBase: 'https://relay.example/api/' }), false, 'the Pandora client has no bridge transport');

// --- hello and ready ----------------------------------------------------------
{
  const win = fakeWindow();
  const changes = [];
  const bridge = new BridgeTransport(win, { onChange: (b) => changes.push(b.label) }).start();
  assert.deepEqual(win.posted[0], { data: { melodica: 1, type: 'hello' }, targetOrigin: 'https://spacegho.st' });
  assert.equal(bridge.active, false, 'not active before ready');
  assert.equal(bridge.label, '');

  // Messages that must be ignored: wrong source, wrong origin, no marker, other apps.
  win.inject({ melodica: 1, type: 'ready', name: 'evil', version: '9' }, { source: {} });
  win.inject({ melodica: 1, type: 'ready', name: 'evil', version: '9' }, { origin: 'https://evil.example' });
  win.inject({ type: 'ready', name: 'evil', version: '9' });
  win.inject({ melodica: 2, type: 'ready', name: 'evil', version: '9' });
  win.inject('ready');
  win.inject(null);
  assert.equal(bridge.active, false, 'filtered messages do not activate the bridge');

  win.inject({ melodica: 1, type: 'ready', name: 'melodica extension', version: '0.1.0' });
  assert.equal(bridge.active, true);
  assert.equal(bridge.label, 'melodica extension 0.1.0');
  assert.deepEqual(changes, ['melodica extension 0.1.0']);
  // A repeated identical ready is quiet; a new version is reported once.
  win.inject({ melodica: 1, type: 'ready', name: 'melodica extension', version: '0.1.0' });
  win.inject({ melodica: 1, type: 'ready', name: 'melodica extension', version: '0.1.1' });
  assert.deepEqual(changes, ['melodica extension 0.1.0', 'melodica extension 0.1.1']);
  log('hello/ready ok');

  // Unsolicited ready before hello also works (the script may load first).
  const win2 = fakeWindow();
  const b2 = new BridgeTransport(win2);
  win2.addEventListener('message', () => {});
  b2.start();
  win2.inject({ melodica: 1, type: 'ready' });
  assert.equal(b2.active, true);
  assert.equal(b2.label, 'melodica extension', 'a nameless ready gets the default name');
  log('unsolicited ready ok');
}

// --- hello repeats, waitReady, a late extension ---------------------------------------
{
  const win = fakeWindow();
  const changes = [];
  const bridge = new BridgeTransport(win, { helloWindow: 300, helloEvery: 50, onChange: (b) => changes.push([b.label, b.player]) }).start();
  await sleep(400);
  const hellos = win.posted.filter((p) => p.data.type === 'hello').length;
  assert.ok(hellos >= 4 && hellos <= 8, `hello repeated within the window (${hellos})`);
  await sleep(150);
  assert.equal(win.posted.filter((p) => p.data.type === 'hello').length, hellos, 'no hello after the window');
  assert.equal(await bridge.waitReady(100), false, 'no extension yet');
  // The extension appears later (its content script loaded late): accepted, reported.
  const waiting = bridge.waitReady(1000);
  setTimeout(() => win.inject({ melodica: 1, type: 'ready', name: 'melodica-extension', version: '0.5.0', player: true }), 100);
  assert.equal(await waiting, true, 'waitReady resolves when it appears');
  assert.deepEqual(changes, [['melodica-extension 0.5.0', true]]);
  // Hello stops as soon as ready arrived.
  const win2 = fakeWindow();
  const b2 = new BridgeTransport(win2, { helloWindow: 500, helloEvery: 50 }).start();
  win2.inject({ melodica: 1, type: 'ready', player: true });
  await sleep(200);
  assert.equal(win2.posted.filter((p) => p.data.type === 'hello').length, 1, 'no repeat after ready');
  b2.stop();
  // An extension before 0.3.0 (no player: true) is not a remote.
  const win3 = fakeWindow();
  const b3 = new BridgeTransport(win3, { helloWindow: 100 }).start();
  win3.inject({ melodica: 1, type: 'ready', name: 'melodica extension', version: '0.1.0' });
  assert.equal(b3.active, true);
  assert.equal(b3.player, false);
  assert.equal(await b3.waitReady(100), false, 'waitReady wants a remote-capable extension');
  bridge.stop(); b3.stop();
  log('hello repeats, late extension, old extension ok');
}

// --- remote control: subscribe / state / command / result ------------------------
{
  const win = fakeWindow();
  const bridge = new BridgeTransport(win, { subscribeEvery: 50 }).start();
  win.inject({ melodica: 1, type: 'ready', name: 'melodica-extension', version: '0.3.0', player: true });
  assert.equal(bridge.player, true, 'ready says player: true');

  // Subscribe is repeated until the first state (a slow service worker), then stops.
  const pushed = [];
  bridge.subscribe((st) => pushed.push(st));
  assert.deepEqual(win.posted.at(-1).data, { melodica: 1, type: 'subscribe' });
  await sleep(180);
  const subs = win.posted.filter((p) => p.data.type === 'subscribe').length;
  assert.ok(subs >= 3, `subscribe repeated while no state came (${subs})`);
  win.inject({ melodica: 1, type: 'state', state: { status: 'idle', n: 1 } });
  await sleep(150);
  assert.equal(win.posted.filter((p) => p.data.type === 'subscribe').length, subs, 'no repeat after the first state');
  win.inject({ melodica: 1, type: 'state', state: { status: 'playing', n: 2 } });
  win.inject({ melodica: 1, type: 'state' }); // no state object: ignored
  win.inject({ melodica: 1, type: 'state', state: { n: 3 } }, { origin: 'https://evil.example' }); // filtered
  assert.deepEqual(pushed, [{ status: 'idle', n: 1 }, { status: 'playing', n: 2 }]);

  // Commands carry action and fields; results pair by id.
  const c = bridge.command('play', { station: { token: 'S1', name: 'One' } }, 200);
  const cmd = win.posted.at(-1).data;
  assert.equal(cmd.type, 'command');
  assert.equal(cmd.action, 'play');
  assert.deepEqual(cmd.station, { token: 'S1', name: 'One' });
  assert.equal(typeof cmd.id, 'string');
  win.inject({ melodica: 1, type: 'result', id: 'someone-else', ok: true });
  win.inject({ melodica: 1, type: 'result', id: cmd.id, ok: true, state: { status: 'loading' } });
  assert.deepEqual(await c, { ok: true, error: '', state: { status: 'loading' } });
  const bad = bridge.command('next', {}, 200);
  win.inject({ melodica: 1, type: 'result', id: win.posted.at(-1).data.id, ok: false, error: 'not signed in' });
  assert.deepEqual(await bad, { ok: false, error: 'not signed in', state: null });
  await assert.rejects(bridge.command('pause', {}, 50), (err) => err instanceof BridgeError && err.kind === 'timeout');

  bridge.unsubscribe();
  assert.deepEqual(win.posted.at(-1).data, { melodica: 1, type: 'unsubscribe' });
  win.inject({ melodica: 1, type: 'state', state: { n: 4 } });
  assert.equal(pushed.length, 2, 'no states after unsubscribe');
  bridge.stop();
  log('remote control ok');
}

log('ALL OK');
