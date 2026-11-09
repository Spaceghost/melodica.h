// For clients' CI: fails when a pinned shared-UI build is more than one release behind the
// live one. Usage: node check-ui-pin.mjs <pinned-hash | path to a vendored scrobble-ui.js>
//   [latest.json URL or a local file, default https://spacegho.st/scrobble/assets/ui/latest.json]
// The hash is the first 16 hex of sha256(scrobble-ui.js || scrobble-ui.css).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [arg, url = 'https://spacegho.st/scrobble/assets/ui/latest.json'] = process.argv.slice(2);
if (!arg) { console.error('usage: check-ui-pin.mjs <hash | scrobble-ui.js>'); process.exit(2); }
let pinned = arg;
if (existsSync(arg)) {
  const css = join(dirname(arg), 'scrobble-ui.css');
  pinned = createHash('sha256').update(readFileSync(arg)).update(readFileSync(css)).digest('hex').slice(0, 16);
}
if (!/^[0-9a-f]{16}$/.test(pinned)) { console.error(`not a content hash: ${pinned}`); process.exit(2); }
// The second argument may also be a local copy of latest.json (e.g. fetched with curl).
let live;
if (existsSync(url)) live = JSON.parse(readFileSync(url, 'utf8'));
else {
  const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'melodica-ui-pin-check/1 (+https://spacegho.st/melodica/)' } });
  if (!res.ok) { console.error(`latest.json: HTTP ${res.status}${res.status === 403 ? ' (blocked before the Worker; pass a curl-fetched copy as the second argument)' : ''}`); process.exit(2); }
  live = await res.json();
}
if (pinned === live.hash) { console.log(`ui pin ${pinned}: current`); process.exit(0); }
if (pinned === live.previous) { console.log(`ui pin ${pinned}: one release behind ${live.hash} (allowed; bump soon)`); process.exit(0); }
console.error(`ui pin ${pinned} is more than one release behind the live ${live.hash} (previous ${live.previous}). Bump it: fetch ${live.js} and ${live.css}.`);
process.exit(1);
