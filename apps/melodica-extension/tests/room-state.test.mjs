import test from 'node:test';
import assert from 'node:assert/strict';
import { publicRoomMember, publicRoomSummary } from '../src/room-state.js';

test('public room members preserve canonical numeric joined_at and strip private fields', () => {
  assert.deepEqual(publicRoomMember({ account: 'user', name: 'Listener', role: 'dj', joined_at: 1730000000, access_token: 'private' }), {
    account: 'user', name: 'Listener', role: 'dj', joined_at: 1730000000,
  });
});

test('room summaries expose bounded search, DJ spots and nested metadata without private media fields', () => {
  const summary = publicRoomSummary({ id: 'room_id_123456789', name: '  Jazz  ', kind: 'public', mode: 'rotation',
    listeners: 4, spots: 3, created_at: 1730000000, secret: 'nope', current_play: { id: 'play-1', dj: 'dj-1',
      track_metadata: { track_name: 'Song', artist_name: 'Artist', additional_info: { duration_ms: 210000, art_url: 'https://art.example/cover.jpg' }, audioUrl: 'private' } } });
  assert.deepEqual(summary, { id: 'room_id_123456789', name: '  Jazz  ', kind: 'public', mode: 'rotation', listeners: 4, spots: 3,
    created_at: 1730000000, current_play: { id: 'play-1', dj: 'dj-1', track_metadata: { track_name: 'Song', artist_name: 'Artist',
      additional_info: { duration_ms: 210000, art_url: 'https://art.example/cover.jpg' } } } });
  assert.equal(publicRoomSummary({ id: 'invalid' }), null);
});

test('public room members retain bounded string timestamps and reject invalid timestamps', () => {
  assert.deepEqual(publicRoomMember({ joined_at: '2026-11-09T00:00:00Z', extra: 'private' }), { joined_at: '2026-11-09T00:00:00Z' });
  assert.deepEqual(publicRoomMember({ joined_at: null }), {});
});
