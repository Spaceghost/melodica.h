// Independent reference Blowfish (test only, not shipped): the standard
// algorithm with the pi-derived constants computed from the same hex digits,
// used to cross-check the wasm core on arbitrary inputs.
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./pi_hex.nelua', import.meta.url), 'utf8');
const hex = [...src.matchAll(/= "([0-9a-f]+)"/g)].map((m) => m[1]).join('');
if (hex.length !== 8336) throw new Error(`pi hex has ${hex.length} digits`);
const words = [];
for (let i = 0; i < 1042; i++) words.push(parseInt(hex.slice(i * 8, i * 8 + 8), 16) >>> 0);

function init(keyBytes) {
  const P = words.slice(0, 18);
  const S = [0, 1, 2, 3].map((b) => words.slice(18 + b * 256, 18 + (b + 1) * 256));
  let j = 0;
  for (let i = 0; i < 18; i++) {
    let v = 0;
    for (let k = 0; k < 4; k++) { v = ((v << 8) | keyBytes[j]) >>> 0; j = (j + 1) % keyBytes.length; }
    P[i] = (P[i] ^ v) >>> 0;
  }
  const f = (x) => ((((S[0][x >>> 24] + S[1][(x >>> 16) & 255]) >>> 0) ^ S[2][(x >>> 8) & 255]) + S[3][x & 255]) >>> 0;
  const enc = (l, r) => {
    for (let i = 0; i < 16; i++) { l = (l ^ P[i]) >>> 0; r = (r ^ f(l)) >>> 0; [l, r] = [r, l]; }
    [l, r] = [r, l];
    r = (r ^ P[16]) >>> 0; l = (l ^ P[17]) >>> 0;
    return [l, r];
  };
  let l = 0, r = 0;
  for (let i = 0; i < 18; i += 2) { [l, r] = enc(l, r); P[i] = l; P[i + 1] = r; }
  for (let b = 0; b < 4; b++) for (let i = 0; i < 256; i += 2) { [l, r] = enc(l, r); S[b][i] = l; S[b][i + 1] = r; }
  return enc;
}

export function blowfishEncryptHexRef(key, text) {
  const enc = init(Buffer.from(key, 'latin1'));
  const data = Buffer.from(text, 'utf8');
  const padded = Buffer.alloc(Math.ceil(data.length / 8) * 8);
  data.copy(padded);
  for (let i = 0; i < padded.length; i += 8) {
    const [l, r] = enc(padded.readUInt32BE(i), padded.readUInt32BE(i + 4));
    padded.writeUInt32BE(l, i); padded.writeUInt32BE(r, i + 4);
  }
  return padded.toString('hex');
}
