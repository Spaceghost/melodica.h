// Derive dist/safari (the Safari Web Extension for iPhone and iPad) from dist/chrome.
// Run after scripts/build.mjs; ios/melodica/melodica.xcodeproj copies dist/safari into the
// extension's Resources on every Xcode build (ios/README.md), so a release only re-runs this.
//
// What changes for Safari on iOS:
//   - background: a non-persistent background page (`scripts` + `persistent: false`);
//     iOS refuses a persistent one and has no offscreen documents. bg.js has no top-level
//     import/export, so it loads as a classic script (no `type: module`).
//   - permissions: drop `offscreen` and `identity` (Safari has neither; the GitHub sign-in
//     falls back to a tab, see safari-auth.js) and `commands` (no keyboard shortcuts on iOS).
//   - drop `update_url` and `version_name` (iOS updates come with the app), keep
//     browser_specific_settings only for `safari`.
//   - add safari-auth.js: catches `#melodica_token=` on the sign-in return page.
//   - when the build has an engine host (offscreen.js), load it in player.html: on Safari the
//     player tab is where the <audio> element lives.
//
//   node scripts/safari.mjs
import { readFile, writeFile, rm, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const from = resolve(root, 'dist/chrome');
const to = resolve(root, 'dist/safari');
if (!existsSync(resolve(from, 'manifest.json'))) {
  console.error('missing dist/chrome; run scripts/build.mjs first');
  process.exit(1);
}
await rm(to, { recursive: true, force: true });
await cp(from, to, { recursive: true });

const m = JSON.parse(await readFile(resolve(from, 'manifest.json'), 'utf8'));
delete m.update_url;
delete m.version_name;
delete m.commands;
delete m.browser_specific_settings;
m.background = { scripts: ['bg.js'], persistent: false };
m.permissions = (m.permissions || []).filter((p) => !['offscreen', 'identity'].includes(p));
m.content_scripts = [
  ...(m.content_scripts || []),
  { matches: ['https://spacegho.st/melodica/app/*'], js: ['safari-auth.js'], run_at: 'document_start' },
];
m.browser_specific_settings = { safari: { strict_min_version: '17.0' } };
await cp(resolve(root, 'ios/extension/safari-auth.js'), resolve(to, 'safari-auth.js'));

if (existsSync(resolve(to, 'offscreen.js'))) {
  const page = resolve(to, 'player.html');
  const html = await readFile(page, 'utf8');
  if (!html.includes('offscreen.js')) {
    await writeFile(page, html.replace('<script type="module" src="player.js"></script>',
      '<script type="module" src="offscreen.js"></script>\n<script type="module" src="player.js"></script>'));
  }
  await rm(resolve(to, 'offscreen.html'), { force: true });
}
await writeFile(resolve(to, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
console.log(`dist/safari: ${m.version} background=${JSON.stringify(m.background)} permissions=${m.permissions.join(',')}`);
