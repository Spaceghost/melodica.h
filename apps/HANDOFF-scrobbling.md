# Handoff: scrobbling and listen:// in the forked apps (2026-11-08)

Goal: every fork in apps.tsv (except melodica-web and melodica-extension) scrobbles to a
ListenBrainz-compatible server with spacegho.st (`https://spacegho.st/scrobble`) as the
preset, keeps its existing scrobbling, and opens `listen://` links
(melodica-scrobble docs/LISTEN-URI.md, reference parser src/listen-uri.js at 2973082).

Working clones: `~/workspaces/melodica-scrobble-clients-2026-11-08/<dir>` on alienware
(shared spec: `SPEC.txt` there; fake ListenBrainz server: `tools/fake_lb.py`).
Build/test containers on bak: `melodica-clients` (Python, C, mingw), `melodica-dotnet`,
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
| pandoroid | 3fcabfa (master) | green | done | in progress (wip/scrobble) |
| epimetheus | 616ac22 (dev), CI fix 134a855 | 134a855 Release green | done | in progress (wip/scrobble) |
| pithos | cadd46f (master) | CI green; CodeQL failing (also failing before, at 685c964) | covered by the Python family (pydora) | done: 79dceb3, CI green (desktop x-scheme-handler) |
| pydora | 8a1248f (master) | green | done, read back (Python family) | done: c64a407, CI green (CLI argument only) |
| pianobar | 7735f87 (master) | green | not reported yet | in progress (wip/scrobble) |
| pianobar-windows | 41c1044 (develop) | release workflow failing (also failing at a02c887 and dc29f54); not yet investigated | not reported yet | not started |
| umbra-piano | none needed | - | - | none: it has no Pandora playback; XivPiano scrobbles and takes links |

Unverified across the board: no app has been run interactively on its real platform with
scrobbling on (no device, emulator, Windows, macOS or in-game run). macOS is not built by
any CI.

## Left to do

1. Finish listen:// in each app: a port of src/listen-uri.js that matches
   tests/listen-uri.test.mjs exactly, OS registration, and CI green. Then fast-forward
   main from the work, not from wip/scrobble blindly.
2. Live submits for the Python and C families, if their reports don't show them.
3. pianobar-windows: find out why the release workflow is red.
4. Tell the melodica-scrobble owner to erase the test account `u_scrobbletest01`, with its
   listens, tokens, now playing and outbox rows. Listens are marked artist "Test Artist",
   track "melodica-client-test ...".
5. Refresh the snapshots after each app lands: `apps/pull.sh <dir> && git push`.
6. Keep the vendored private reference parser (`listen-uri-reference.mjs`) out of the
   forks: melodica.h is public, and apps/pull.sh copies the forks into it.

Next command:

    cd ~/workspaces/melodica-scrobble-clients-2026-11-08 && for d in */; do git -C $d status -sb | head -1; done
