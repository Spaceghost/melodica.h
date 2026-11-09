import { writeFile } from 'node:fs/promises';
import { renderScrobbleUiPin } from './scrobble-ui-pin.mjs';

const output = process.argv[2];
if (!output) throw new Error('usage: write-scrobble-ui-pin.mjs <output-path>');
let input = '';
for await (const chunk of process.stdin) input += chunk;
const manifest = JSON.parse(input);
await writeFile(output, renderScrobbleUiPin(manifest));
