// melodica-web: the encrypted store for "Remember me on this device" (docs/BRIDGE.md 5).
//
// One AES-GCM 256 key, generated with extractable: false and kept as a CryptoKey in
// IndexedDB; one record {v: 1, iv, ct} next to it, ct being the encryption of
// {session, credential, relay}. Nothing secret goes to localStorage. wipe() deletes the
// database (key and record). This keeps the password out of anything that reads the
// profile's files or localStorage as text; script running in this origin can still use
// the key, and nothing here pretends otherwise.

export const DB_NAME = 'melodica-vault';
const STORE = 'vault';
const KEY_ID = 'key';
const RECORD_ID = 'record';

const req = (r) => new Promise((ok, fail) => { r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error); });

export class Vault {
  constructor({ idb = globalThis.indexedDB, crypto = globalThis.crypto } = {}) {
    this.idb = idb;
    this.crypto = crypto;
    this.db = null;
  }

  get available() { return !!(this.idb && this.crypto && this.crypto.subtle); }

  async open() {
    if (this.db) return this.db;
    const r = this.idb.open(DB_NAME, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
    this.db = await req(r);
    this.db.onversionchange = () => { this.db.close(); this.db = null; };
    return this.db;
  }

  async get(id) {
    const db = await this.open();
    return req(db.transaction(STORE, 'readonly').objectStore(STORE).get(id));
  }

  async put(id, value) {
    const db = await this.open();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, id);
    await new Promise((ok, fail) => { tx.oncomplete = ok; tx.onerror = () => fail(tx.error); tx.onabort = () => fail(tx.error); });
  }

  async key(create) {
    let k = await this.get(KEY_ID);
    if (k || !create) return k || null;
    k = await this.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await this.put(KEY_ID, k);
    return k;
  }

  // The stored object, or null (nothing stored, no key, or it does not decrypt).
  async read(id = RECORD_ID) {
    if (!this.available) return null;
    try {
      const rec = await this.get(id);
      if (!rec || rec.v !== 1) return null;
      const k = await this.key(false);
      if (!k) return null;
      const plain = await this.crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, k, rec.ct);
      const obj = JSON.parse(new TextDecoder().decode(plain));
      return obj && typeof obj === 'object' ? obj : null;
    } catch (_) {
      return null;
    }
  }

  async write(obj, id = RECORD_ID) {
    if (!this.available) return false;
    const k = await this.key(true);
    const iv = this.crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await this.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(JSON.stringify(obj))));
    await this.put(id, { v: 1, iv, ct });
    return true;
  }

  // Deletes the key and the record (the whole database).
  async wipe() {
    if (!this.idb) return;
    if (this.db) { this.db.close(); this.db = null; }
    try {
      await new Promise((ok) => { const r = this.idb.deleteDatabase(DB_NAME); r.onsuccess = ok; r.onerror = ok; r.onblocked = ok; });
    } catch (_) { /* nothing to delete */ }
  }
}
