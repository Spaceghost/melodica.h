import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackCopy, COPY_CHUNK_BYTES } from '../src/playback-copy.js';

test('copy chunks reassemble exact cached bytes without a network request', async () => {
  const original = Uint8Array.from({ length: COPY_CHUNK_BYTES * 2 + 71 }, (_, i) => i % 251);
  let reads = 0;
  const copy = new PlaybackCopy(async () => { reads++; return new Response(original, { headers: { 'content-type': 'audio/mp4' } }); });
  const parts = [];
  let offset = 0;
  do {
    const chunk = await copy.chunk('T1', offset, COPY_CHUNK_BYTES * 2);
    assert.equal(chunk.offset, offset);
    assert.equal(chunk.total, original.length);
    assert.equal(chunk.mime, 'audio/mp4');
    const bytes = Buffer.from(chunk.bytes, 'base64');
    assert.ok(bytes.length <= COPY_CHUNK_BYTES);
    parts.push(bytes); offset += bytes.length;
    assert.equal(chunk.done, offset === original.length);
  } while (offset < original.length);
  assert.deepEqual(Buffer.concat(parts), Buffer.from(original));
  assert.equal(reads, 1, 'one cached Blob read for the entire transfer');
  assert.equal(copy.cached, null, 'release the Blob after EOF');
});

test('unavailable copies retry without a cached empty result; offsets and tokens are bounded', async () => {
  let available = false;
  const copy = new PlaybackCopy(async () => available ? new Response(new Uint8Array([1, 2, 3])) : null);
  assert.equal(await copy.chunk('T1'), null);
  available = true;
  assert.equal((await copy.chunk('T1')).total, 3);
  for (const args of [['', 0], ['T1', -1], ['T1', 0.5], ['T1', 3], ['T1', 0, 0]]) {
    await assert.rejects(copy.chunk(...args));
  }
});
