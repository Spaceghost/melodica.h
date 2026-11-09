import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PROJECT, makeEntry, mergeManifest, uploadPlan, makeFeeds } from './model.mjs';

export async function publishObjects({ release, files, sums, registries, r2, output, dry = false, forceFiles = false, verifyFeeds }) {
  const stores = [];
  for (const registry of registries) {
    const current = await r2.get(registry.bucket, 'releases.json');
    const entry = makeEntry({ ...registry, release, files, sums });
    mergeManifest(current, registry.kind, entry);
    const changed = uploadPlan(current, registry.kind, entry);
    const plan = forceFiles ? entry.assets.filter(a => a.key) : changed;
    stores.push({ ...registry, entry, plan, current });
  }
  const result = { uploads: 0, skipped: 0, stores: [] };
  for (const store of stores) {
    const groups = new Map();
    for (const asset of store.plan) {
      const type = registries[0].platform.contentTypeFor(asset.name);
      if (!groups.has(type)) groups.set(type, []);
      groups.get(type).push({ key: asset.key, file: files.get(asset.name).path });
    }
    console.log(`${store.bucket}: ${store.plan.length} uploads; ${store.entry.assets.filter(a => a.key).length - store.plan.length} unchanged files`);
    if (!dry) for (const [type, entries] of groups) await r2.bulk(store.bucket, entries, type);
    result.uploads += store.plan.length;
    result.skipped += store.entry.assets.filter(a => a.key).length - store.plan.length;
  }
  // Recheck after the uploads, before moving any public update pointer.
  for (const store of stores) mergeManifest(await r2.get(store.bucket, 'releases.json'), store.kind, store.entry);
  const extension = stores.find(s => s.kind === 'extensions');
  const xpi = extension.entry.assets.find(a => a.name.endsWith('.xpi'));
  const feeds = makeFeeds(extension.config, release.tag_name, xpi.sha256);
  for (const [name, text] of Object.entries(feeds)) {
    const file = join(output, name);
    await writeFile(file, text);
    if (!dry) await r2.put(extension.bucket, `dl/${PROJECT}/${name}`, file, extension.platform.contentTypeFor(name));
  }
  if (!dry) await verifyFeeds();
  for (const store of stores) {
    // The other projects may have changed while files were uploading.
    const latest = await r2.get(store.bucket, 'releases.json');
    const manifest = mergeManifest(latest, store.kind, store.entry);
    const path = join(output, `${store.kind}-releases.json`);
    await writeFile(path, JSON.stringify(manifest, null, 2) + '\n');
    if (!dry) await r2.put(store.bucket, 'releases.json', path, 'application/json; charset=utf-8');
    result.stores.push({ bucket: store.bucket, prefix: store.kind === 'extensions' ? '/extensions/' : '/melodica/',
      tag: store.entry.release.tag, assets: store.entry.assets.length,
      otherProjectsPreserved: latest[store.kind].filter(p => p.id !== PROJECT).length });
  }
  return result;
}
