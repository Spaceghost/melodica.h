// Build the extension: Imba -> ES modules with esbuild (one bundle per entry,
// stable names, no hashing, no inline scripts), copy public/, the wasm core
// and generated icons, and write one manifest per browser:
//   dist/chrome/   manifest without Firefox-only keys (self-hosted: carries update_url)
//   dist/cws/      the Chrome build without update_url, for the Chrome Web Store and Edge Add-ons
//   dist/firefox/  manifest with browser_specific_settings and background.scripts
// Also emits build/node/core.js (the Core wrapper for Node) for core/test.mjs and
// build/node/pandora.js (the Pandora client) for scripts/real-pandora-probe.mjs.
//
//   node scripts/build.mjs [--version 0.1.0] [--core build/core/melodica_core.wasm]
import { build } from 'esbuild';
import { compile } from 'imba/compiler';
import { readFile, writeFile, mkdir, rm, cp, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const version = arg('--version', process.env.MELODICA_EXTENSION_VERSION || '0.0.0');
const corePath = resolve(root, arg('--core', 'build/core/melodica_core.wasm'));
const dist = resolve(root, 'dist');

if (!existsSync(corePath)) {
  console.error(`missing ${corePath}; run scripts/build-core.sh first`);
  process.exit(1);
}

const imbaPlugin = {
  name: 'imba',
  setup(b) {
    b.onLoad({ filter: /\.imba$/ }, async (args) => {
      const source = await readFile(args.path, 'utf8');
      const sourcePath = relative(root, args.path);
      const sourceId = createHash('sha1').update(sourcePath).digest('hex').slice(0, 8);
      const r = compile(source, {
        platform: 'browser', format: 'esm', sourcePath, sourceId, raiseErrors: true, sourcemap: false,
      });
      const errors = (r.diagnostics || []).filter((d) => d.severity === 'error');
      if (errors.length) {
        return { errors: errors.map((d) => ({ text: `${sourcePath}: ${d.message}`, location: d.range ? { file: sourcePath, line: d.range.start.line + 1 } : null })) };
      }
      return { contents: r.js, loader: 'js', resolveDir: dirname(args.path) };
    });
  },
};

async function bundle(entry, outfile, platform = 'browser') {
  const result = await build({
    entryPoints: [resolve(root, entry)],
    outfile,
    bundle: true,
    format: 'esm',
    platform,
    target: platform === 'browser' ? ['chrome121', 'firefox128'] : ['node22'],
    conditions: platform === 'browser' ? ['browser'] : ['node'],
    plugins: [imbaPlugin],
    minify: false,
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
    define: { 'process.env.NODE_ENV': '"production"', 'process.env.IMBA_HMR': 'undefined' },
  });
  return result;
}

// Minimal PNG writer for the icons: a gold disc on ink (the melodica mark).
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function iconPng(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const cx = (size - 1) / 2, cy = cx, R = size * 0.46;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx, y - cy) / R;
      let r = 0x11, g = 0x16, b = 0x22, a = 255;
      if (d > 1.0) { a = 0; }
      else if (d > 0.9) { r = 0xd8; g = 0xb2; b = 0x6a; }
      else if (Math.abs(d - 0.68) < 0.03 || Math.abs(d - 0.46) < 0.03) { r = 0x9a; g = 0x82; b = 0x50; }
      else if (d < 0.14) { r = 0xf0; g = 0xd9; b = 0xa4; }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function listFiles(dir, base = dir) {
  const out = [];
  for (const name of await readdir(dir)) {
    const p = resolve(dir, name);
    if ((await stat(p)).isDirectory()) out.push(...await listFiles(p, base));
    else out.push(relative(base, p));
  }
  return out.sort();
}

await rm(dist, { recursive: true, force: true });
const common = resolve(root, 'build/common');
await rm(common, { recursive: true, force: true });
await mkdir(resolve(common, 'core'), { recursive: true });
await mkdir(resolve(common, 'icons'), { recursive: true });

for (const [entry, out] of [['src/bg.imba', 'bg.js'], ['src/popup.imba', 'popup.js'], ['src/player.imba', 'player.js'], ['src/options.imba', 'options.js'], ['src/content.imba', 'content.js']]) {
  await bundle(entry, resolve(common, out));
}
for (const name of ['popup.html', 'player.html', 'options.html', 'theme.css']) {
  await cp(resolve(root, 'public', name), resolve(common, name));
}
await cp(corePath, resolve(common, 'core/melodica_core.wasm'));
await cp(resolve(root, 'LICENSE'), resolve(common, 'LICENSE'));
for (const size of [48, 128]) await writeFile(resolve(common, `icons/icon-${size}.png`), iconPng(size));

// Guard: no inline scripts or event handler attributes in the pages (MV3 CSP).
for (const name of ['popup.html', 'player.html', 'options.html']) {
  const html = await readFile(resolve(common, name), 'utf8');
  if (/<script(?![^>]*\ssrc=)[^>]*>/.test(html) || /\son[a-z]+=/i.test(html)) throw new Error(`${name}: inline script`);
}
// Guard: no eval/new Function in the bundles, no innerHTML in our sources
// (the Imba runtime keeps an innerHTML path for <template> content and SSR
// hydration that nothing here calls).
for (const name of ['bg.js', 'popup.js', 'player.js', 'options.js', 'content.js']) {
  const js = await readFile(resolve(common, name), 'utf8');
  for (const bad of [/\beval\(/, /new Function\(/]) {
    if (bad.test(js)) throw new Error(`${name}: forbidden construct ${bad}`);
  }
}
for (const name of await readdir(resolve(root, 'src'))) {
  const src = await readFile(resolve(root, 'src', name), 'utf8');
  for (const bad of [/\beval\(/, /new Function\(/, /innerHTML/, /outerHTML/, /insertAdjacentHTML/]) {
    if (bad.test(src)) throw new Error(`src/${name}: forbidden construct ${bad}`);
  }
}

const manifest = JSON.parse(await readFile(resolve(root, 'public/manifest.json'), 'utf8'));
manifest.version = version.replace(/-.*$/, '');
manifest.version_name = version;
// Self-hosted update feeds on spacegho.st/extensions (written by extensions-site's sync).
// Chrome ignores update_url for an unpacked load (the CI smoke), honours it for a .crx
// installed by policy; Firefox reads gecko.update_url for a self-hosted .xpi.
const STORE = 'https://spacegho.st/extensions/dl/melodica-extension';
const chrome = structuredClone(manifest);
delete chrome.browser_specific_settings;
delete chrome.background.scripts;
chrome.update_url = `${STORE}/update.xml`;
// The store copy: the Chrome Web Store rejects a manifest with update_url (the store is the
// updater), and Edge Add-ons takes the same package.
const cws = structuredClone(chrome);
delete cws.update_url;
const firefox = structuredClone(manifest);
delete firefox.version_name;
firefox.browser_specific_settings.gecko.update_url = `${STORE}/updates.json`;

for (const [name, m] of [['chrome', chrome], ['cws', cws], ['firefox', firefox]]) {
  const dir = resolve(dist, name);
  await cp(common, dir, { recursive: true });
  await writeFile(resolve(dir, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
}
await writeFile(resolve(dist, 'VERSION'), version + '\n');

// Node build of the core wrapper for the unit test.
await mkdir(resolve(root, 'build/node'), { recursive: true });
await bundle('src/core.imba', resolve(root, 'build/node/core.js'), 'node');
// ...and of the Pandora client, for scripts/real-pandora-probe.mjs (no-account probe against the real tuner).
await bundle('src/pandora.imba', resolve(root, 'build/node/pandora.js'), 'node');

const files = await listFiles(resolve(dist, 'chrome'));
console.log(`built melodica-extension ${version}: ${files.join(', ')}`);
