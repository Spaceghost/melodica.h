# Extension release publication

Tagging a stable version runs the existing build, Mozilla unlisted signing, Chromium,
Brave, Firefox and iOS workflows. `publish.yml` automatically finishes the self-hosted
release after successful desktop CI, and runs again when the iOS workflow finishes.
An hourly catch-up also repairs interrupted publication. No manual site sync is part
of the normal release cycle.

Release-event validation and publication both run on `fedora-release`, using
default-branch publisher code. They do not require GitHub-hosted runner minutes or
wait for the hourly catch-up. Proposed changes on pushes and pull requests are
validated separately on hosted runners, away from the release runner's logins.

The dedicated `fedora-release` runner uses Fedora's existing Wrangler and GitHub
logins. No Cloudflare credential is copied into GitHub secrets. Wrangler handles
refreshing its local login. The runner is a user systemd service with linger enabled,
so it starts after reboot and does not require a terminal to remain open.

## One publisher

`node scripts/release/publish.mjs v0.8.8` performs the cycle:

1. Download the release in one batch, reuse the local cache, and validate checksums,
   exact package versions, Mozilla signature files and all three browser proofs.
2. Upload changed assets to both R2 buckets in batches grouped by content type.
   Files upload concurrently; unchanged files are skipped. Publish the browser feeds
   and verify their versions and the packages they reference.
3. Reread each live release manifest, preserve other projects, and replace only the
   Melodica extension entry. Check eight public package downloads, both manifests,
   both feeds, and both pages at 390 and 1280 pixels.
4. Update the three repository handoffs and refresh `melodica.h/apps/melodica-extension`
   through its existing pull script. Private shared UI and the private reference parser
   are rejected from the public snapshot. These updates wait for other repository
   work to become quiet and never force-push.

The live player and Worker code are not deployed by this publisher. Version data
comes from `releases.json` in `spaceghost-extensions` and `melodica-downloads`.
Firefox uses `dl/melodica-extension/updates.json`; Chromium uses
`dl/melodica-extension/update.xml` in the extension bucket.

The publisher always reads registry metadata from current default-branch source in
isolated caches. It preserves the existing platform classifiers and browser store
selection. It does not publish a public Mozilla listing or submit to other stores.

## Repair and evidence

If Mozilla accepted a signing submission but the build lost its connection before
downloading the XPI, dispatch **ci** from the default branch with `release_tag` set
to the existing stable tag. The workflow checks out that exact tag, recovers its
existing Mozilla signature, compares all manifest JSON values and every other
payload byte against the build, and
runs all three desktop browser gates before creating the release. It submits to
Mozilla only when the version lookup definitively returns 404. Do not move the
tag or increment the extension version to retry a download. Once recovery CI
succeeds, dispatch the publisher below for the same tag.

The GitHub **Publish self-hosted release** workflow accepts an existing tag for
repair, without rebuilding the extension, retagging it or submitting it to Mozilla
again. Leave the tag empty for the latest release. `force_files` re-uploads the
already-verified files; changing an installable under an existing tag is rejected.

Each run uploads its report, generated manifests, feeds and mobile/desktop
screenshots as an Actions artifact, and adds a job summary. Old delayed workflow
events cannot roll back a newer published version. Drafts, unsigned Firefox files,
bad checksums and failed browser proofs stop publication before any upload.

For a local preview, add `--dry-run`. This reads the live manifests and writes the
planned output locally, without publishing or committing. Browser verification
dependencies are installed with `npm ci --prefix scripts/release`; CI also installs
the pinned Chromium version automatically.

`node scripts/release/install-runner.mjs` installs or checks the dedicated runner.
Its official GitHub archive is checksum-verified and its registration credential is
passed directly to the runner configuration process. The user service is
`melodica-release-runner.service`.
