// Differential test inputs for ports of melodica-scrobble src/listen-uri.js.
// node listen-diff-gen.mjs N > inputs.txt (one \uXXXX-escaped input per line); node listen-diff-canon.mjs REF < inputs.txt
const seeds = [
  'listen://artist/Modest%20Mouse', 'web+listen://genre/thrash%20metal', 'https://spacegho.st/listen/station/4123456789012345',
  'listen://track/' + 'a'.repeat(64) + '?t=95', 'listen://map/neon-plains/synthwave-reach', 'listen://map/neon-plains',
  'listen://user/knewter', 'listen://listens', 'LISTEN://Leaderboard/', 'listen://artist/Sigur%20R%C3%B3s',
  'listen://artist/AC%2FDC', 'listen://http://evil.example', 'listen://artist/%E0%A4%A', 'listen://track/abc?t=1&t=2',
  'listen://artist/...', "listen://artist/Guns%20N'%20Roses", 'HTTPS://SPACEGHO.ST/LISTEN/artist/x', 'listen://track/abc?t=86400',
  'listen://track/abc?t=1=2', 'listen://listens?', 'listen://artist/x%C2%A0', 'listen://artist/%EF%BB%BFx', 'listen://artist/e%CC%81',
  'listen://tracK/abc', 'listen://artist/a+b', 'listen://artist/%25', 'listen://artist/%ED%A0%80', 'listen://artist/%C0%AF',
];
const alpha = ['a', 'Z', '0', '9', '-', '_', '.', '~', '%', '/', '?', '&', '=', '#', ' ', '+', ':', '@', '!', '$', "'", '(', ')', '*', ',', ';',
  '\\', '<', '"', 'é', 'K', 'İ', '\u0085', ' ', ' ', '﻿', '\n', '\t', '\u0000', '\ud800', 'ß', '%2F', '%2e', '%20', '%C3%A9',
  '%E2%80%A8', '%c2%85', '%F0%9F%8E%B5', '%FF', '%0', 't=', '?t=5', 'listen://', 'web+listen://', 'https://spacegho.st/listen/', 'artist/', 'map/',
  'user/', 'track/', 'station/', 'genre/'];
let seed = 12345;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
const pick = (a) => a[rnd(a.length)];
function mutate(s) {
  const k = 1 + rnd(4);
  for (let i = 0; i < k; i++) {
    const at = rnd(s.length + 1), op = rnd(5);
    if (op === 0) s = s.slice(0, at) + pick(alpha) + s.slice(at);
    else if (op === 1) s = s.slice(0, at) + s.slice(at + 1 + rnd(3));
    else if (op === 2) s = s.slice(0, at) + pick(alpha) + s.slice(at + 1);
    else if (op === 3) s = rnd(2) ? s.toUpperCase() : s.toLowerCase();
    else s = s.slice(0, at) + pick(alpha).repeat(1 + rnd(250)) + s.slice(at);
  }
  return s;
}
const n = Number(process.argv[2] || 20000);
const out = [];
for (const s of seeds) out.push(s);
for (let i = 0; i < n; i++) out.push(mutate(pick(seeds)));
const esc = (s) => [...Array(s.length).keys()].map((i) => { const c = s.charCodeAt(i); return c >= 0x20 && c < 0x7f && c !== 0x5c ? s[i] : '\\u' + c.toString(16).padStart(4, '0'); }).join('');
process.stdout.write(out.map(esc).join('\n') + '\n');
