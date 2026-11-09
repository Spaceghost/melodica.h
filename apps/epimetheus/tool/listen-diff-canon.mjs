// node canon.mjs REFERENCE.js < inputs.txt: the canonical parse of each input by the reference.
import { createInterface } from 'node:readline';
const { parseListenUri, routeOf } = await import(process.argv[2]);
const un = (s) => s.replace(/\\u([0-9a-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
const lines = [];
for await (const line of createInterface({ input: process.stdin })) {
  const p = parseListenUri(un(line));
  if (!p) { lines.push('null'); continue; }
  const keys = ['name', 'station', 'track', 'land', 'province', 'username'].filter((k) => p[k] !== undefined).sort();
  const fields = '{' + keys.map((k) => `${k}=${p[k]}`).join(', ') + '}';
  lines.push(`${p.target}|${fields}|${p.t === undefined ? 'null' : p.t}|${p.uri}|${p.https}|${routeOf(p)}`);
}
process.stdout.write(lines.join('\n') + '\n');
