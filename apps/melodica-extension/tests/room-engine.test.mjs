import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomEngine, roomTrackMetadata, validRoomCommand } from '../src/room-engine.js';

test('room track metadata contains only the song fields needed by the room API', () => {
  const metadata = roomTrackMetadata({
    trackToken: 'private-token', title: 'Song', artist: 'Artist', album: 'Album',
    duration: 180, coverArt: 'https://art.example/cover.jpg', audioUrl: 'https://audio.example/signed.m4a',
  });
  assert.deepEqual(metadata, {
    track_name: 'Song', artist_name: 'Artist', release_name: 'Album',
    additional_info: { duration_ms: 180000, art_url: 'https://art.example/cover.jpg' },
  });
  assert.equal(JSON.stringify(metadata).includes('audioUrl'), false);
  assert.equal(roomTrackMetadata({ trackToken: 'x', title: '', artist: 'Artist' }), null);
});

test('room commands validate action-specific fields and do not accept extra payload', () => {
  assert.deepEqual(validRoomCommand({ action: 'react', play_id: 'play-1', reaction: 'like' }), { action: 'react', play_id: 'play-1', reaction: 'like' });
  assert.deepEqual(validRoomCommand({ action: 'settings', kind: 'private', mode: 'rotation', spots: 3, skip_fraction: .5 }),
    { action: 'settings', kind: 'private', mode: 'rotation', spots: 3, skip_fraction: .5 });
  for (const command of [
    { action: 'react', play_id: 'play-1', reaction: 'skip' },
    { action: 'skip', play_id: 'play-1', sdp: 'forged' },
    { action: 'settings', kind: 'public', mode: 'solo', spots: 100, skip_fraction: .5 },
    { action: 'heard', play_id: 'play-1', listened_ms: -1 },
    { action: 'root-command' },
  ]) assert.throws(() => validRoomCommand(command));
});

class FakeSession extends EventTarget {
  calls = [];
  open() {
    this.calls.push('open');
    const room = { id: 'r'.repeat(20), seq: 1, you: 'dj-user', current_dj: 'dj-user', ready_at: 1,
      members: [{ account: 'dj-user' }], play: null };
    this.room = room;
    this.dispatchEvent(new CustomEvent('state', { detail: room }));
  }
  getState() { return this.room; }
  getAudioState() { return { state: 'idle' }; }
  async pause() { this.calls.push('pause'); }
  close() {}
}

test('room engine uses the current player audio and waits for a fresh song to actually play', async () => {
  const audio = new EventTarget();
  audio.paused = false;
  const engine = {
    audio,
    snapshot: { station: { token: 'station' }, track: { trackToken: 'old', title: 'Old', artist: 'Band' }, status: 'playing', changedAt: 1 },
    async skip() {
      setTimeout(() => { this.snapshot = { ...this.snapshot, track: { trackToken: 'fresh', title: 'Fresh', artist: 'Band', duration: 20, audioUrl: 'https://example.invalid/signed' }, status: 'playing', changedAt: 2 }; }, 30);
    },
    pause() { audio.paused = true; },
    resume() { audio.paused = false; },
    setVolume() {},
  };
  let playerOptions;
  const connection = new EventTarget();
  connection.open = () => {};
  connection.close = () => {};
  connection.command = async () => null;
  connection.getState = () => null;
  connection.setAudio = () => {};
  const transport = new EventTarget();
  transport.sync = async () => {};
  transport.startDj = async () => {};
  transport.stop = async () => {};
  transport.unmount = () => {};
  const session = new FakeSession();
  const roomEngine = new RoomEngine({ engine, send: async () => ({ ok: true }), loadMedia: async () => ({
    createRoomConnection: () => connection,
    createRoomTransport: () => transport,
    createRoomSession: (options) => { playerOptions = options.player; return session; },
    capturePlayerAudio: (element) => ({ element }),
  }) });
  await roomEngine.join('r'.repeat(20), { base: 'https://spacegho.st', scrobbling: false });
  const next = await playerOptions.startTurn();
  assert.deepEqual(next.track_metadata, { track_name: 'Fresh', artist_name: 'Band', release_name: '', additional_info: { duration_ms: 20000 } });
  assert.equal(Object.hasOwn(next.track_metadata, 'audioUrl'), false);
  assert.equal(playerOptions.capture().element, audio);
  assert.equal(playerOptions.scrobbling(), false);
  await roomEngine.leave({ leave: false });
  const held = new FakeSession();
  const heldEngine = new RoomEngine({ engine, send: async () => ({ ok: true }), loadMedia: async () => ({
    createRoomConnection: () => connection,
    createRoomTransport: () => transport,
    createRoomSession: () => held,
    capturePlayerAudio: (element) => ({ element }),
  }) });
  await heldEngine.join('r'.repeat(20), { base: 'https://spacegho.st', paused: true });
  assert.deepEqual(held.calls.slice(0, 2), ['pause', 'open']);
  await heldEngine.leave({ leave: false });
});
