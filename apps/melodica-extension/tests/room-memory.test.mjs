import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { RoomEngine } from '../src/room-engine.js';

test('leaving rooms releases listeners and room-scoped media objects', async () => {
  const refs = [];
  function track(kind, object) {
    refs.push({ kind, ref: new WeakRef(object) });
    return object;
  }

  const audio = new EventTarget();
  const media = {
    createRoomConnection: () => track('connection', {}),
    createRoomTransport: () => track('transport', {}),
    createRoomSession: () => track('session', Object.assign(new EventTarget(), {
      open() {}, close() {}, getState: () => ({ play: null }),
    })),
    capturePlayerAudio() {},
  };
  const rooms = new RoomEngine({
    engine: { audio, snapshot: {} }, send: async () => ({}), loadMedia: async () => media,
  });

  for (let i = 0; i < 32; i++) {
    await rooms.join('room-memory-test-123');
    await rooms.leave();
    for (const type of ['play', 'pause']) {
      assert.equal(getEventListeners(audio, type).length, 0, type + ' listener survived leave');
    }
  }

  // WeakRef targets stay alive until the current JS job ends.
  await setImmediate();
  globalThis.gc();
  for (const { kind, ref } of refs) {
    assert.equal(ref.deref(), undefined, kind + ' survived leave');
  }
  // Keep the actual player owner live through collection.
  assert.equal(rooms.engine.audio, audio);
});
