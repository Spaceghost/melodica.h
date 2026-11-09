import { readFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const stable = tag => typeof tag === 'string' && tag === tag.trim() && /^v\d+\.\d+\.\d+$/.test(tag);
export function publicationEvent(name, event) {
  if (name === 'workflow_dispatch') {
    const tag = event.inputs?.tag || '';
    if (tag && !stable(tag)) throw new Error('Publication requires a stable version tag');
    return { publish: true, tag, force: event.inputs?.force_files === true || event.inputs?.force_files === 'true' };
  }
  if (name === 'schedule') return { publish: true, tag: '', force: false };
  if (name === 'release' && !event.release?.draft && !event.release?.prerelease && stable(event.release?.tag_name)) {
    return { publish: true, tag: event.release.tag_name, force: false };
  }
  if (name === 'workflow_run') {
    const run = event.workflow_run;
    if (run?.event !== 'push' || run.head_repository?.full_name?.toLowerCase() !== 'spaceghost/melodica-extension' || !stable(run.head_branch)) return { publish: false };
    if (run.name === 'ci' && run.conclusion !== 'success') return { publish: false };
    if (!['ci', 'ios'].includes(run.name)) return { publish: false };
    return { publish: true, tag: run.head_branch, force: false };
  }
  return { publish: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = publicationEvent(process.env.GITHUB_EVENT_NAME, JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')));
  appendFileSync(process.env.GITHUB_OUTPUT, `publish=${result.publish}\ntag=${result.tag || ''}\nforce=${result.force || false}\n`);
}
