import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { loadRegistry } from './io.mjs';

test('both catalogs use their precompiled JavaScript and leave the development source out of the cache', async t => {
  const cache = await mkdtemp(join(tmpdir(), 'melodica-platform-'));
  t.after(() => rm(cache, {recursive: true, force: true}));
  const origin = join(cache, 'origin');
  execFileSync('git', ['init', '-q', '-b', 'master', origin]);
  const write = async (path, text) => {
    const file = join(origin, path);
    await mkdir(dirname(file), {recursive: true});
    await writeFile(file, text);
  };
  const project = {id:'melodica-extension'};
  const config = 'account_id = "0123456789abcdef"\nbucket_name = "downloads"\n';
  await write('wrangler.toml', config);
  await write('site/wrangler.toml', config);
  await write('data/extensions.json', JSON.stringify({extensions:[project]}));
  await write('site/data/projects.json', JSON.stringify({projects:[project]}));
  await write('src/platform.js', 'export const classify = () => "chrome";');
  await write('site/src/platform.js', 'export const classify = name => name.endsWith(".xpi") ? "firefox" : "other";');
  await write('site/src/platform.imba', 'The publisher must never read this development source.');
  execFileSync('git', ['add', '.'], {cwd:origin});
  execFileSync('git', ['-c','user.name=Test','-c','user.email=test@example.com','commit','-qm','catalogs'], {cwd:origin});
  for (const repo of ['extensions-site','melodica-web']) {
    execFileSync('git', ['clone','-q','--no-checkout',origin,join(cache,'sources',repo)]);
  }
  const extensions = await loadRegistry(cache, 'extensions');
  const projects = await loadRegistry(cache, 'projects');
  assert.equal(extensions.platform.classify('build.zip'), 'chrome');
  assert.equal(projects.platform.classify('build.xpi'), 'firefox');
  assert.equal(extensions.sha, projects.sha);
  assert.deepEqual(projects.config, project);
});
