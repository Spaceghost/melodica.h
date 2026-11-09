export function renderScrobbleUiPin(manifest) {
  if (!manifest || !/^[0-9a-f]{40}$/.test(manifest.commit || '') || !/^[0-9a-f]{16}$/.test(manifest.hash || '')) {
    throw new Error('latest.json: bad commit or hash');
  }
  const hashes = manifest.sha256 || {};
  const files = [
    ['scrobble-ui.js', hashes['scrobble-ui.js']],
    ['scrobble-ui.css', hashes['scrobble-ui.css']],
    // Accept the canonical file-key form and the explicit alias used by some manifests.
    ['room-media.js', manifest.media_sha256 || hashes['room-media.js']],
  ];
  for (const [name, digest] of files) {
    if (!/^[0-9a-f]{64}$/.test(digest || '')) throw new Error(`latest.json: no sha256 for ${name}`);
  }
  return [
    `commit ${manifest.commit}`,
    `hash ${manifest.hash}`,
    ...files.map(([name, digest]) => `${digest}  ${name}`),
    '',
  ].join('\n');
}
