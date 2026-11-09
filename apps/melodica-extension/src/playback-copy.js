export const COPY_CHUNK_BYTES = 256 * 1024;
const BLOB_TTL_MS = 30_000;

// Cache Storage returns a Blob; slicing it bounds each message without repeatedly
// base64-encoding the whole song. Keep just one Blob while its chunks are read.
export class PlaybackCopy {
  constructor(readCached) { this.readCached = readCached; this.cached = null; this.timer = null; }
  clear() { clearTimeout(this.timer); this.timer = null; this.cached = null; }

  async chunk(trackToken, offset = 0, limit = COPY_CHUNK_BYTES) {
    if (typeof trackToken !== 'string' || !trackToken || trackToken.length > 8192) throw new Error('Invalid track token.');
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid copy offset.');
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid copy limit.');
    limit = Math.min(limit, COPY_CHUNK_BYTES);
    let record = this.cached;
    if (!record || record.trackToken !== trackToken || Date.now() - record.at > BLOB_TTL_MS) {
      const response = await this.readCached(trackToken);
      if (!response) return null;
      const blob = await response.blob();
      if (!blob.size) return null;
      const mime = /^(?:audio|video)\/[A-Za-z0-9.+-]+$/.test(blob.type) ? blob.type : 'audio/mp4';
      record = { trackToken, blob, mime, at: Date.now() };
      this.cached = record;
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { if (this.cached === record) this.clear(); }, BLOB_TTL_MS);
    this.timer.unref?.(); // Node unit tests should not stay alive for the expiry timer.
    const total = record.blob.size;
    if (offset >= total) throw new Error('Copy offset is past the end.');
    const raw = new Uint8Array(await record.blob.slice(offset, offset + limit).arrayBuffer());
    let binary = '';
    for (let i = 0; i < raw.length; i += 8192) binary += String.fromCharCode(...raw.subarray(i, i + 8192));
    const done = offset + raw.length === total;
    record.at = Date.now();
    if (done && this.cached === record) this.clear();
    return { trackToken, offset, total, mime: record.mime, bytes: btoa(binary), done };
  }
}
