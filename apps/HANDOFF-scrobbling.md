# Handoff: scrobbling and listen:// in the forked apps (2026-11-08)

Goal: every fork in apps.tsv (except melodica-web and melodica-extension) scrobbles to a
ListenBrainz-compatible server with spacegho.st (`https://spacegho.st/scrobble`) as the
preset, keeps its existing scrobbling, and opens `listen://` links
(melodica-scrobble docs/LISTEN-URI.md, reference parser src/listen-uri.js at 2973082).

Working clones: `~/workspaces/melodica-scrobble-clients-2026-11-08/<dir>` on alienware
(shared spec: `SPEC.txt` there; fake ListenBrainz server: `tools/fake_lb.py`).
Build/test containers (moved to the incus remote `fedora:` on 2026-11-08; the bak copies are stopped backups, do not restart them): `melodica-clients` (Python, C, mingw), `melodica-dotnet`,
`melodica-mobile`.

Decisions:
- No Pandora track tokens or ids are sent. The melodica-scrobble owner asked clients to
  stop, because the service does not store Pandora identifiers.
- Links never start playback. Artist and genre links select a seed station and station
  links select a station; the user presses Play. Every other link opens its
  https://spacegho.st/listen/ form in the browser.
- No scrobble.spacegho.st: every app takes a base URL with a path.

## Status

`wip/scrobble` in each fork holds an untested snapshot of the listen:// work that was in
progress when this was written. The main branch holds only what was pushed after testing.

| App | Scrobbling commit (branch) | CI | Live submit | listen:// |
| --- | --- | --- | --- | --- |
| xivpiano | 19b81f6 (integration/melodica) | green | done, read back | done: c145454, CI green (chat command + IPC) |
| elpis | 9ff388c (master) | green (Windows build + Linux checks) | covered by the C# family (xivpiano) | done: 786ae13, CI green (HKCU registry) |
| pandoroid | 3fcabfa (master) | green | done | done: c76ce85, CI green incl. emulator link smoke (intent filters) |
| epimetheus | 616ac22 (dev), CI fix 134a855 | 42573142304 green (web, APK, web + Android smoke) | done | done: 4284a19 (CFBundleURLSchemes + intent filter; macOS/iOS never built; no station creation from links) |
| pithos | cadd46f (master) | CI green; CodeQL failing (also failing before, at 685c964) | covered by the Python family (pydora) | done: 79dceb3, CI green (desktop x-scheme-handler) |
| pydora | 8a1248f (master) | green | done, read back (Python family) | done: c64a407, CI green (CLI argument only) |
| pianobar | e850ac0, 7735f87 (master) | green | done, read back (C family) | done: f3c04fd, CI green (.desktop wrapper); NFC only partial (6 value diffs vs reference on decomposed input) |
| pianobar-windows | 426404422 (develop) | smoke green (run 42573270253) | covered by the C family; no single listen on the runner | done: 981b47a + 542b52c, release workflow green (HKCU registry) |
| umbra-piano | none needed | - | - | none: it has no Pandora playback; XivPiano scrobbles and takes links |

Unverified across the board: no app has been run interactively on its real platform with
scrobbling on (no device, emulator, Windows, macOS or in-game run). macOS is not built by
any CI.

## Left to do

1. Done: scrobbling and listen:// are on every app's branch with CI green. The
   `wip/scrobble` branches are stale handoff snapshots; delete them when convenient.
2. pianobar: finish NFC normalisation in src/listen_uri.c (a decomposed e + U+0301
   is not composed); accept/reject already matches the reference.
3. Never run on the real platform: macOS/iOS (epimetheus, no CI), Windows clicks
   (elpis, pianobar-windows), in-game (xivpiano), phones (pandoroid, epimetheus).
4. Done: the test account `u_scrobbletest01` was erased by the melodica-scrobble owner
   (5 listens, 1 token, the account; 0 test listens remain) and its token file deleted.
5. Refresh the snapshots after each app lands: `apps/pull.sh <dir> && git push`.
6. Keep the vendored private reference parser (`listen-uri-reference.mjs`) out of the
   forks: melodica.h is public, and apps/pull.sh copies the forks into it.

Next command:

    cd ~/workspaces/melodica-scrobble-clients-2026-11-08 && for d in */; do git -C $d status -sb | head -1; done
