#!/usr/bin/env node
// Print the Chrome extension id for an RSA private (or public) key in PEM form:
// the first 128 bits of SHA-256 over the DER SubjectPublicKeyInfo, each hex digit
// mapped to a-p (Chromium's crx_file/id_util.cc). The key itself is never printed.
//   node scripts/crx-id.mjs <key.pem>
import { createHash, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
const file = process.argv[2];
if (!file) { console.error('usage: crx-id.mjs <key.pem>'); process.exit(2); }
const der = createPublicKey(readFileSync(file)).export({ type: 'spki', format: 'der' });
const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
console.log(hex.replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16))));
