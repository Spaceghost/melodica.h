import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from './io.mjs';

const START = '<!-- extension-publication:start -->';
const END = '<!-- extension-publication:end -->';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function updateRecord(original, block) {
  const section = `${START}\n${block.trim()}\n${END}`;
  const start = original.indexOf(START);
  if (start !== -1) {
    const end = original.indexOf(END, start);
    if (end === -1) throw new Error('Unclosed release record');
    return original.slice(0, start) + section + original.slice(end + END.length);
  }
  const first = original.indexOf('\n');
  if (first === -1) return `${original || '# Release handoff'}\n\n${section}\n`;
  return original.slice(0, first + 1) + '\n' + section + '\n' + original.slice(first + 1);
}

export function assertPublicSnapshot(paths) {
  for (const path of paths) {
    if (!path.startsWith('apps/melodica-extension/')) throw new Error(`Unexpected snapshot change: ${path}`);
    if (/\/(?:vendor\/scrobble-ui|ui)\//.test(path) || /\/(?:listen-uri-reference[^/]*|scrobble-ui(?:-[a-f0-9]{6,})?\.(?:m?js|css|imba))$/.test(path)) {
      throw new Error(`Private shared code cannot enter the public snapshot: ${path}`);
    }
  }
}

async function quietCheckout(dir, branch, owned = []) {
  const deadline = Date.now() + 20 * 60_000;
  for (;;) {
    run('git', ['fetch', '--depth=1', 'origin', branch], { cwd: dir });
    const sha = run('git', ['rev-parse', 'FETCH_HEAD'], { cwd: dir }).trim();
    const timestamp = Number(run('git', ['show', '-s', '--format=%ct', sha], { cwd: dir }).trim()) * 1000;
    if (owned.includes(sha) || Date.now() - timestamp >= 15 * 60_000) {
      // This is a new disposable clone owned by this publication job.
      run('git', ['checkout', '-B', 'release-record', sha], { cwd: dir });
      return sha;
    }
    if (Date.now() >= deadline) throw new Error('Release metadata is waiting for ongoing repository work; the scheduled publication will retry');
    console.log(`${branch}: waiting for ongoing repository changes before recording the release`);
    await sleep(30_000);
  }
}

async function recordRepo(root, repo, branch, content, tag, owned) {
  const dir = join(root, repo);
  run('gh', ['repo', 'clone', `Spaceghost/${repo}`, dir, '--', '--depth=1']);
  run('git', ['config', 'user.name', 'Melodica Release'], { cwd: dir });
  run('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'], { cwd: dir });
  run('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  for (let attempt = 0; attempt < 3; attempt++) {
    await quietCheckout(dir, branch, owned);
    const path = join(dir, 'HANDOFF.md');
    const previous = await readFile(path, 'utf8').catch(() => '# Release handoff\n');
    const next = updateRecord(previous, content);
    if (previous === next) return run('git', ['rev-parse', 'HEAD'], { cwd: dir }).trim();
    await writeFile(path, next);
    run('git', ['add', 'HANDOFF.md'], { cwd: dir });
    run('git', ['commit', '-m', `Record automated extension release ${tag} [skip ci]`], { cwd: dir });
    const result = run('git', ['push', 'origin', `HEAD:${branch}`], { cwd: dir, allowFailure: true });
    if (result.status === 0) return run('git', ['rev-parse', 'HEAD'], { cwd: dir }).trim();
    if (!/non-fast-forward|fetch first|rejected/.test(result.stderr || '')) throw new Error(`${repo}: release record could not be pushed`);
    // Discard only this job's generated commit before retrying from the new head.
    run('git', ['reset', '--hard', 'HEAD~1'], { cwd: dir });
  }
  throw new Error(`${repo}: release record is still changing; the scheduled publication will retry`);
}

export async function recordRelease(report, cache, previousOwned = {}, onRecord = async () => {}) {
  const root = await mkdtemp(join(cache, 'records-'));
  const url = report.run || 'the self-hosted publication workflow';
  const content = `## Extension catalog publication\n\n- ${report.tag} is published at https://spacegho.st/extensions/#melodica-extension and https://spacegho.st/melodica/extension/.\n- Mozilla unlisted signing is preserved. Both browser update feeds and eight public installable downloads passed checksum verification.\n- Both catalogs passed browser checks at 390 and 1280 pixels; the Melodica catalog contains only its browser extension and keeps the player bar pinned.\n- The Worker release manifests were updated in R2; all other Melodica projects were preserved. No player or Worker code was deployed by this publication.\n- Evidence: ${url}.`;
  const owned = { ...previousOwned };
  try {
    for (const repo of ['extensions-site', 'melodica-web', 'melodica-extension']) {
      owned[repo] = await recordRepo(root, repo, 'master', content, report.tag,
        [previousOwned[repo], repo === 'melodica-extension' ? process.env.GITHUB_SHA : null].filter(Boolean));
      await onRecord({ ...owned });
    }
    const dir = join(root, 'melodica.h');
    run('gh', ['repo', 'clone', 'Spaceghost/melodica.h', dir, '--', '--depth=1', '--filter=blob:none', '--no-checkout']);
    run('git', ['sparse-checkout', 'set', '--no-cone', '/apps/pull.sh', '/apps/apps.tsv', '/apps/melodica-extension/'], { cwd: dir });
    run('git', ['config', 'user.name', 'Melodica Release'], { cwd: dir });
    run('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'], { cwd: dir });
    run('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
    const base = await quietCheckout(dir, 'main', [previousOwned['melodica.h']].filter(Boolean));
    run('sh', ['apps/pull.sh', 'melodica-extension'], { cwd: dir });
    const paths = run('git', ['diff', '--name-only', base, 'HEAD'], { cwd: dir }).trim().split('\n').filter(Boolean);
    assertPublicSnapshot(paths);
    if (paths.length) run('git', ['push', 'origin', 'HEAD:main'], { cwd: dir });
    owned['melodica.h'] = run('git', ['rev-parse', 'HEAD'], { cwd: dir }).trim();
    await onRecord({ ...owned });
    return owned;
  } finally { await rm(root, { recursive: true, force: true }); }
}
