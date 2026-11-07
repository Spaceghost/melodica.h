// Unit test for the wasm core, run in Node: the libpiano vector from
// melodica.h tests/crypt.c, round trips with the android partner keys, hex,
// the syncTime handshake (the tuner's layout: 4 junk bytes + 10 digits + 2
// NULs) and the request envelope.
//   node core/test.mjs [path/to/melodica_core.wasm]
import { readFileSync } from 'node:fs';
import { Core } from "../build/node/core.js";

const path = process.argv[2] || new URL('../build/core/melodica_core.wasm', import.meta.url);
const core = await Core.load(readFileSync(path));
let n = 0;
const eq = (a, b, what) => {
  n++;
  if (a !== b) { console.error(`FAIL ${what}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); process.exit(1); }
};

eq(core.abi, 1, 'abi');
eq(core.version, '0.1.0', 'version');

// melodica.h tests/crypt.c: key "abcdefgh", "hello" -> 936f264832cfda48
eq(core.initKeys('abcdefgh', 'abcdefgh'), true, 'initKeys');
eq(core.encrypt('hello'), '936f264832cfda48', 'libpiano vector');
eq(Buffer.from(core.decryptHex('936f264832cfda48')).toString('latin1'), 'hello\0\0\0', 'libpiano vector decrypt');

eq(core.init(), true, 'init android');
const enc = core.encrypt('{"loginType":"user"}');
eq(enc.length, 48, 'padded hex length');
eq(/^[0-9a-f]+$/.test(enc), true, 'lowercase hex');
eq(core.decryptHex(enc).length, 24, 'decrypt keeps padding');

// Known android-key answer from the tuner's blowfish tests would need its
// vector; instead cross-check with a reference implementation of the same
// algorithm in JS below (independent code path).
import { blowfishEncryptHexRef } from './ref-blowfish.mjs';
for (const text of ['', 'a', '12345678', 'The quick brown fox jumps over the lazy dog', 'ü日本語']) {
  eq(core.encrypt(text), blowfishEncryptHexRef('6#26FRL$ZWD', text), `ref encrypt ${JSON.stringify(text)}`);
}

eq(core.hexEncode(new Uint8Array([0, 15, 16, 255])), '000f10ff', 'hexEncode');
eq(Buffer.from(core.hexDecode('000F10ff')).toString('hex'), '000f10ff', 'hexDecode');
eq(core.hexDecode('abc'), null, 'odd hex rejected');
eq(core.hexDecode('zz'), null, 'non-hex rejected');

// syncTime: encrypt with the *decrypt* key (the server's inkey) like the tuner.
const serverNow = 1762480000;
const plain = 'TUNR' + String(serverNow).padStart(10, '0') + '\0\0';
const syncHex = blowfishEncryptHexRef('R=U!LH$O2B#', plain);
const hostNow = serverNow - 37;
eq(core.syncParse(syncHex, hostNow), serverNow, 'syncParse');
eq(core.syncOffset, 37, 'offset');
eq(core.syncTime(hostNow + 10), serverNow + 10, 'syncTime');
eq(core.syncParse('zz', hostNow), 0, 'bad sync');

// Envelope: JSON + syncTime, encrypted with the partner encrypt key. To read it
// back through decryptHex (which uses the decrypt key) set both keys equal,
// keeping the offset syncParse established.
eq(core.initKeys('6#26FRL$ZWD', '6#26FRL$ZWD'), true, 'same key both ways');
core.setSyncOffset(37);
const env = core.envelope('{"userAuthToken":"T"}', hostNow);
const dec = Buffer.from(core.decryptHex(env)).toString('utf8').replace(/\0+$/, '');
eq(dec, `{"userAuthToken":"T","syncTime":${serverNow}}`, 'envelope');
eq(Buffer.from(core.decryptHex(core.envelope('{}', hostNow))).toString('utf8').replace(/\0+$/, ''),
  `{"syncTime":${serverNow}}`, 'envelope empty object');
eq(Buffer.from(core.decryptHex(core.envelope(' { "a" : 1 } \n', hostNow))).toString('utf8').replace(/\0+$/, ''),
  ` { "a" : 1,"syncTime":${serverNow}}`, 'envelope whitespace');
eq(core.envelope('[1]', hostNow), null, 'envelope rejects non-object');
eq(core.init(), true, 'back to the android keys');

// Arena: allocations are released; a large payload still fits.
const big = 'x'.repeat(60000);
eq(core.encrypt(big).length, 120000, 'large encrypt');
eq(core.arenaUsed, 0, 'arena released');

console.log(`core/test.mjs: ${n} checks passed (${core.version}, ${core.wasmBytes} bytes)`);
