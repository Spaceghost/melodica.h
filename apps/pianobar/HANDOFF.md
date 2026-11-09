# Handoff: Unicode listen links

- Branch `wip/fedora-unicode-links`, based on master f3c04fd. Replaces partial character substitutions with utf8proc NFC normalization after the existing decoded-input checks. Input length and rejection rules keep their existing order.
- Adds utf8proc to application/test link flags, CI dependencies and README requirements. New public test vectors cover Latin composition, Greek, Hangul, canonical singletons and combining-mark ordering; the decoded-length boundary is also checked.
- On Fedora, Debian Incus container `melodica-clients`, isolated directory `/work/pianobar-nfc-root`: `make test` and `sh ci/listenbrainz-e2e.sh 38581` passed. The full application also builds with its exact public vendor submodule 86be2937e1275fb4d4477fdf087570b6de4eff57 (`pianobar-nfc-full-build.log` inside the container). The old parser fails all five new normalization cases. A separate local comparison found zero differences in 1,826 URI/route cases across all three scheme forms. The private reference parser and comparison script remain outside this public repository.
- Evidence: `~/workspaces/crew-e2e-fedora/pianobar-nfc-{tests,before,e2e}.log` and `pianobar-nfc-diff.json`. PR https://github.com/Spaceghost/pianobar/pull/1 is ready. Next: inspect full-build CI, merge after a fresh remote author/time check, release, then refresh the public apps snapshot. No production test account was created.

- PR CI 42596774288 stopped before building: Ubuntu latest advanced to 26.04, where the unused GNU Pth package is absent. Removed that unused dependency (the client uses POSIX pthreads), pinned build CI to Ubuntu 24.04, and gave release jobs an Ubuntu 24.04 fallback because the only registered bak runner is offline. Release runtime dependencies now include utf8proc.

- NFC fix merged to master 2e973ba after PR build 42596906154 passed. Tag 2026.11.09 builds successfully (42597214234); its runtime install stopped because the package name was wrong. The successful build job confirms Ubuntu 24.04 installs `libutf8proc3` 2.9.0, so the smoke runtime dependency is corrected to that exact name. Rerun the existing tag through the release workflow on master; never retag. No release has been published yet.

## Published 2026.11.09

- Release https://github.com/Spaceghost/pianobar/releases/tag/2026.11.09 published by successful workflow 42597456642, using the unchanged tag source 2e973ba with the corrected runtime dependency in the master workflow. Both downloaded tarball checksums passed.
- The exact released Linux tarball was unpacked and run on Ubuntu 24.04: all 177 shared libraries resolved; login, station list and decoded playback against melodica-tuner passed (5,296,128 PCM bytes, no sound card). Production Pandora playback and physical audio output were not tested. Evidence: `~/workspaces/crew-e2e-fedora/pianobar-release-2026.11.09/`.
- Next: refresh `melodica.h/apps/pianobar`, update the shared fork handoff, and mirror the release in the Melodica site after Fedora Cloudflare login. The private parser remains excluded from all published source.
