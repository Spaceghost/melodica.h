// Verify a deployed shared-UI release before recording its content pin.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const { hash, commit, sha256 } = manifest;
if (!/^[0-9a-f]{16}$/.test(hash) || !/^[0-9a-f]{40}$/.test(commit)) throw new Error('Invalid shared UI manifest');
const files = ['scrobble-ui.js', 'scrobble-ui.css'];
const combined = createHash('sha256');
for (const file of files) {
  const expected = sha256?.[file];
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error(`Missing digest for ${file}`);
  const response = await fetch(`https://spacegho.st/scrobble/assets/ui/h/${hash}/${file}`);
  if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) throw new Error(`${file}: digest mismatch`);
  combined.update(bytes);
}
if (combined.digest('hex').slice(0, 16) !== hash) throw new Error('Shared UI content hash mismatch');
const pin = `hash=${hash}\ncommit=${commit}\njs_sha256=${sha256[files[0]]}\ncss_sha256=${sha256[files[1]]}\n`;
writeFileSync('scrobble-ui.pin', pin);
console.log(`Verified shared UI ${hash}`);
