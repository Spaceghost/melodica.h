import test from 'node:test';
import assert from 'node:assert/strict';
import { publicRoomMember } from '../src/room-state.js';

test('public room members preserve canonical numeric joined_at and strip private fields', () => {
  assert.deepEqual(publicRoomMember({ account: 'user', name: 'Listener', role: 'dj', joined_at: 1730000000, access_token: 'private' }), {
    account: 'user', name: 'Listener', role: 'dj', joined_at: 1730000000,
  });
});

test('public room members retain bounded string timestamps and reject invalid timestamps', () => {
  assert.deepEqual(publicRoomMember({ joined_at: '2026-11-09T00:00:00Z', extra: 'private' }), { joined_at: '2026-11-09T00:00:00Z' });
  assert.deepEqual(publicRoomMember({ joined_at: null }), {});
});
