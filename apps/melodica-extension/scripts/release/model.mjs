import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const PROJECT = 'melodica-extension';
export const MAX_UPLOAD = 300 * 1024 * 1024;
export const digest = (data) => createHash('sha256').update(data).digest('hex');

export function versionOf(tag) {
  assert.match(tag, /^v\d+\.\d+\.\d+$/, 'A stable version tag is required');
  assert.equal(tag, tag.trim(), 'A stable version tag is required');
  return tag.slice(1);
}

export function compareTags(a, b) {
  const aa = versionOf(a).split('.').map(Number);
  const bb = versionOf(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return Math.sign(aa[i] - bb[i]);
  return 0;
}

export function parseSums(text) {
  const sums = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([0-9a-f]{64})\s+\*?([^/\\]+)$/i);
    if (m) {
      assert.ok(!sums.has(m[2]), `Duplicate checksum: ${m[2]}`);
      sums.set(m[2], m[1].toLowerCase());
    }
  }
  return sums;
}

export function safeName(name) {
  assert.match(name, /^[\w.()+ -]+$/, 'Unsupported release filename');
  assert.ok(name !== '.' && name !== '..' && !/[\r\n]/.test(name));
  assert.ok(!name.startsWith('-'), 'Release filenames cannot be command options');
  return name;
}

export function verifyRelease(release, files, config) {
  const version = versionOf(release.tag_name);
  assert.equal(release.draft, false, 'Draft releases cannot be published');
  assert.equal(release.prerelease, false, 'Only stable releases are published');
  const sumsFile = files.get('SHA256SUMS');
  assert.ok(sumsFile, 'SHA256SUMS is required');
  const sums = parseSums(sumsFile.body.toString('utf8'));
  for (const asset of release.assets) {
    safeName(asset.name);
    const file = files.get(asset.name);
    assert.ok(file, `Missing release asset: ${asset.name}`);
    assert.equal(file.body.length, asset.size, `${asset.name}: file size`);
    if (sums.has(asset.name)) assert.equal(digest(file.body), sums.get(asset.name), `${asset.name}: checksum mismatch`);
  }
  for (const suffix of ['-chrome.zip', '-firefox.zip', '.xpi', '.crx']) {
    const name = `${PROJECT}-${version}${suffix}`;
    assert.ok(sums.has(name), `${name}: a published checksum is required`);
    assert.ok(files.has(name), `${name}: missing installable`);
  }
  const xpi = files.get(`${PROJECT}-${version}.xpi`);
  assert.equal(xpi.signed, true, 'The Firefox release must be signed by Mozilla');
  assert.equal(xpi.manifest?.version, version, 'Firefox package version');
  assert.equal(xpi.manifest?.browser_specific_settings?.gecko?.id, config.gecko_id, 'Firefox extension ID');
  assert.equal(xpi.manifest?.browser_specific_settings?.gecko?.update_url,
    `https://spacegho.st/extensions/dl/${PROJECT}/updates.json`, 'Firefox update feed');
  const chrome = files.get(`${PROJECT}-${version}-chrome.zip`);
  assert.equal(chrome.manifest?.version, version, 'Chrome package version');
  assert.equal(chrome.manifest?.update_url,
    `https://spacegho.st/extensions/dl/${PROJECT}/update.xml`, 'Chromium update feed');
  for (const name of ['smoke-extension.json', 'smoke-brave.json', 'smoke-firefox.json']) {
    assert.ok(sums.has(name), `${name}: a published checksum is required`);
    assert.equal(JSON.parse(files.get(name)?.body.toString('utf8') || '{}').ok, true, `${name}: browser proof must pass`);
  }
  return sums;
}

export function makeEntry({ kind, release, files, sums, config, platform }) {
  const assets = [];
  for (const asset of release.assets) {
    if (kind === 'extensions' && !platform.mirrored(asset.name)) continue;
    const file = files.get(asset.name);
    const entry = {
      name: asset.name, size: asset.size, sha256: digest(file.body),
      sha256_published: sums.has(asset.name), platform: platform.classify(asset.name),
      key: asset.size > MAX_UPLOAD ? null : `dl/${PROJECT}/${release.tag_name}/${asset.name}`,
      github_url: asset.browser_download_url,
    };
    if (entry.platform.id === 'smoke') {
      let report;
      try { report = JSON.parse(file.body.toString('utf8').replace(/^\uFEFF/, '')); } catch { /* retained as evidence */ }
      if (report && typeof report.ok === 'boolean') {
        entry.report = {
          ok: report.ok, platform: String(report.platform || ''), browser: String(report.browser || ''),
          summary: String(report.summary || ''), when: String(report.when || release.published_at || ''),
          steps: Array.isArray(report.steps) ? report.steps.filter(x => typeof x === 'string' || (x && x.ok)).slice(0, kind === 'extensions' ? 16 : 12).map(x => typeof x === 'string' ? x : String(x.name)) : [],
        };
      } else entry.platform = { id: 'evidence', label: 'CI evidence' };
    }
    if (kind === 'extensions' && /\.(xpi|zip)$/i.test(asset.name)) {
      if (file.manifest) entry.version = String(file.manifest.version || '');
      if (/\.xpi$/i.test(asset.name)) entry.signed = file.signed ? 'amo' : 'unsigned';
    }
    assets.push(entry);
  }
  const entry = {
    ...(kind === 'projects' ? { ...config, appReady: false } : { id: PROJECT }),
    release: { tag: release.tag_name, name: release.name || release.tag_name,
      url: release.html_url, published_at: release.published_at, prerelease: false },
    assets,
  };
  if (kind === 'extensions') entry.feeds = {
    firefox: { url: `https://spacegho.st/extensions/dl/${PROJECT}/updates.json`, version: versionOf(release.tag_name) },
    chrome: { url: `https://spacegho.st/extensions/dl/${PROJECT}/update.xml`, version: versionOf(release.tag_name) },
  };
  return entry;
}

export function mergeManifest(current, kind, entry) {
  assert.ok(Array.isArray(current?.[kind]), `The ${kind} manifest is unavailable`);
  const previous = current[kind].find(p => p.id === PROJECT);
  if (previous?.release?.tag && compareTags(previous.release.tag, entry.release.tag) > 0) {
    throw new Error(`Refusing to replace newer release ${previous.release.tag} with ${entry.release.tag}`);
  }
  let replaced = false;
  const entries = current[kind].map(p => {
    if (p.id !== PROJECT) return p;
    replaced = true;
    return entry;
  });
  if (!replaced) entries.push(entry);
  return { ...current, generated: new Date().toISOString(), [kind]: entries };
}

export function uploadPlan(current, kind, entry) {
  const previous = current[kind]?.find(p => p.id === PROJECT);
  const old = new Map(previous?.release?.tag === entry.release.tag ? previous.assets.map(a => [a.name, a]) : []);
  for (const asset of entry.assets) {
    if (/\.(?:xpi|crx)$|-(?:chrome|firefox)\.zip$/i.test(asset.name) && old.get(asset.name)?.sha256 && old.get(asset.name).sha256 !== asset.sha256) {
      throw new Error(`A published installable cannot change under the same tag: ${asset.name}`);
    }
  }
  return entry.assets.filter(a => a.key && (old.get(a.name)?.sha256 !== a.sha256 || old.get(a.name)?.size !== a.size));
}

export function makeFeeds(config, tag, xpiSha) {
  const version = versionOf(tag);
  const base = `https://spacegho.st/extensions/dl/${PROJECT}`;
  return {
    'updates.json': JSON.stringify({ addons: { [config.gecko_id]: { updates: [{ version,
      update_link: `${base}/${tag}/${PROJECT}-${version}.xpi`, update_hash: `sha256:${xpiSha}` }] } } }, null, 2) + '\n',
    'update.xml': `<?xml version="1.0" encoding="UTF-8"?>\n<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">\n  <app appid="${config.chrome_id}">\n    <updatecheck codebase="${base}/${tag}/${PROJECT}-${version}.crx" version="${version}"/>\n  </app>\n</gupdate>\n`,
  };
}
