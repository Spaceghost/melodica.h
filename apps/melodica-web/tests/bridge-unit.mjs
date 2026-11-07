#!/usr/bin/env node
// The extension bridge without a browser or network: a fake window records
// what the page posts and plays the content script's part. Checks the hello
// handshake, the message filter (source, origin, melodica marker), the
// request/response pairing by id, the 20 s timeout (shortened here) with
// fallback to the relay, bridge-level failures, HTTP errors through the
// bridge, and the ?api= / bridge / relay precedence as PianoClient.post sees it.

import { strict as assert } from 'node:assert';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(process.env.MELODICA_DIST || resolve(here, '..', 'dist'));
const { BridgeTransport, BridgeError, BRIDGE_TIMEOUT_MS, bodyToText } = await import(pathToFileURL(resolve(dist, 'bridge.js')).href);
const { PianoClient, PianoError } = await import(pathToFileURL(resolve(dist, 'piano.js')).href);

const log = (...a) => console.log('[bridge-unit]', ...a);
const enc = (s) => new TextEncoder().encode(s);

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

assert.equal(BRIDGE_TIMEOUT_MS, 20_000, 'the protocol timeout is 20 s');

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

// --- request / response -------------------------------------------------------
{
  const win = fakeWindow();
  const bridge = new BridgeTransport(win, { timeout: 200 }).start();
  win.inject({ melodica: 1, type: 'ready', name: 'melodica extension', version: '0.1.0' });

  const p = bridge.request('?method=auth.partnerLogin', enc('{"username":"android"}'));
  const req = win.posted.at(-1).data;
  assert.equal(req.melodica, 1);
  assert.equal(req.type, 'request');
  assert.equal(typeof req.id, 'string');
  assert.ok(req.id.length > 0);
  assert.equal(req.search, '?method=auth.partnerLogin');
  assert.ok(req.body instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(req.body), '{"username":"android"}');
  assert.equal(win.posted.at(-1).targetOrigin, 'https://spacegho.st');

  // A response for another id is ignored; the matching one resolves.
  win.inject({ melodica: 1, type: 'response', id: 'someone-else', ok: true, status: 200, body: enc('{"stat":"nope"}') });
  win.inject({ melodica: 1, type: 'response', id: req.id, ok: true, status: 200, body: enc('{"stat":"ok"}') });
  const res = await p;
  assert.deepEqual({ ...res, body: bodyToText(res.body) }, { ok: true, status: 200, body: '{"stat":"ok"}', error: '' });
  assert.equal(bridge.pending.size, 0);

  // Two in flight at once get distinct ids and pair up correctly.
  const pa = bridge.request('?method=a', enc(''));
  const pb = bridge.request('?method=b', enc(''));
  const [ra, rb] = win.posted.slice(-2).map((m) => m.data);
  assert.notEqual(ra.id, rb.id);
  win.inject({ melodica: 1, type: 'response', id: rb.id, ok: true, status: 200, body: enc('B') });
  win.inject({ melodica: 1, type: 'response', id: ra.id, ok: true, status: 200, body: enc('A') });
  assert.equal(bodyToText((await pa).body), 'A');
  assert.equal(bodyToText((await pb).body), 'B');

  // Timeout.
  const t0 = Date.now();
  await assert.rejects(bridge.request('?method=slow', enc('')), (err) => err instanceof BridgeError && err.kind === 'timeout');
  assert.ok(Date.now() - t0 >= 150, 'waited for the timeout');
  assert.equal(bridge.pending.size, 0, 'timed-out request is forgotten');
  // A late response for it is ignored without throwing.
  win.inject({ melodica: 1, type: 'response', id: win.posted.at(-1).data.id, ok: true, status: 200, body: enc('late') });

  // stop() rejects what is pending and detaches.
  const pending = bridge.request('?method=x', enc(''));
  bridge.stop();
  await assert.rejects(pending, BridgeError);
  assert.equal(bridge.active, false);
  win.inject({ melodica: 1, type: 'ready', name: 'melodica extension', version: '0.1.0' });
  assert.equal(bridge.active, false, 'detached after stop');
  log('request/response ok');
}

// --- bodyToText accepts the shapes a lenient script might send -----------------
assert.equal(bodyToText(enc('héllo')), 'héllo');
assert.equal(bodyToText(enc('héllo').buffer), 'héllo');
assert.equal(bodyToText('plain'), 'plain');
assert.equal(bodyToText(undefined), '');

// --- PianoClient.post: precedence and fallback ----------------------------------
// post() needs no wasm: it takes {urlPath, postData} and returns the body text.
{
  const relayCalls = [];
  const relay = async (url, init) => {
    relayCalls.push({ url, body: init.body });
    return new Response('{"stat":"ok","via":"relay"}', { status: 200 });
  };
  const req = { urlPath: '/services/json/?method=user.getStationList&auth_token=T&partner_id=42&user_id=U1', postData: 'deadbeef' };

  // No bridge at all: the relay.
  const plain = new PianoClient({ apiBase: 'https://spacegho.st/melodica/api/', fetch: relay });
  assert.equal(plain.transport, 'relay');
  assert.equal(await plain.post(req), '{"stat":"ok","via":"relay"}');
  assert.equal(relayCalls.at(-1).url, 'https://spacegho.st/melodica/api/?method=user.getStationList&auth_token=T&partner_id=42&user_id=U1');

  // Bridge present but not ready: still the relay.
  const win = fakeWindow();
  const bridge = new BridgeTransport(win, { timeout: 150 }).start();
  const client = new PianoClient({ apiBase: 'https://spacegho.st/melodica/api/', fetch: relay, bridge, log: () => {} });
  assert.equal(client.transport, 'relay');
  await client.post(req);
  assert.equal(relayCalls.length, 2);

  // Ready: requests go through the bridge with the query string and the body bytes.
  win.inject({ melodica: 1, type: 'ready', name: 'melodica extension', version: '0.1.0' });
  assert.equal(client.transport, 'bridge');
  const answer = (ok, status, body, error) => {
    const m = win.posted.at(-1).data;
    assert.equal(m.type, 'request');
    win.inject({ melodica: 1, type: 'response', id: m.id, ok, status, body: body === undefined ? undefined : enc(body), error });
  };
  let p = client.post(req);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(win.posted.at(-1).data.search, '?method=user.getStationList&auth_token=T&partner_id=42&user_id=U1');
  assert.equal(new TextDecoder().decode(win.posted.at(-1).data.body), 'deadbeef');
  answer(true, 200, '{"stat":"ok","via":"bridge"}');
  assert.equal(await p, '{"stat":"ok","via":"bridge"}');
  assert.equal(relayCalls.length, 2, 'the relay was not used');

  // Pandora's own error JSON comes back as text for mw_finish, even with a non-2xx status.
  p = client.post(req);
  await new Promise((r) => setTimeout(r, 0));
  answer(false, 500, '{"stat":"fail","code":1001}');
  assert.equal(await p, '{"stat":"fail","code":1001}');

  // An HTTP error with a non-JSON body through the bridge is final (no fallback).
  p = client.post(req);
  await new Promise((r) => setTimeout(r, 0));
  answer(false, 403, '<html>Just a moment</html>');
  await assert.rejects(p, (err) => err instanceof PianoError && err.kind === 'relay' && /HTTP 403 via the melodica extension 0\.1\.0/.test(err.message));
  assert.equal(relayCalls.length, 2);

  // A bridge-level failure (no status) falls back to the relay for this request.
  p = client.post(req);
  await new Promise((r) => setTimeout(r, 0));
  answer(false, 0, undefined, 'TypeError: Failed to fetch');
  assert.equal(await p, '{"stat":"ok","via":"relay"}');
  assert.equal(relayCalls.length, 3);

  // A timeout falls back to the relay for this request, and the bridge stays active.
  p = client.post(req);
  assert.equal(await p, '{"stat":"ok","via":"relay"}');
  assert.equal(relayCalls.length, 4);
  assert.equal(client.transport, 'bridge');
  log('PianoClient.post precedence and fallback ok');
}

log('ALL OK');
