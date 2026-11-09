# Handoff (melodica-extension)

Updated 2026-11-09 for 0.8.5. Rewrite this after every release.

## Live

| Version | Commit | What |
| --- | --- | --- |
| 0.8.7 | 5b22d59 | Shared Scrobbles UI pinned by content hash 5d0e0d0e496df10f, with a staleness check in CI. latest.json gets 403 from GitHub runners, and the check then warns. Map "Play in melodica" goes through play-seed. Deployment toast in the player tab and a deployment line in the popup. |
| 0.8.6 | 8ffb7c8 | listen:// links: player-tab prompt (never autoplays), omnibox `listen`, Firefox web+listen, iOS listen://, "Copy listen link". `queue` (Up next) in the bridge state and the player tab. |
| 0.8.5 | 288c0eb | Only 403 scrobbling_off turns scrobbling off. The queue is kept and flushed. The popup shows a failure line. play-seed. station_name and submission_client_version on listens. No single-side accents. |
| 0.8.4 | 9c4f9dc | Resume on this device, Sign in with GitHub, album art as Pandora gives it. |

Each release has 55 assets. The extensions feeds and the melodica site carry it, and melodica.h has the snapshot.

## Live e2e (tests/live-e2e.sh, Chromium on bak, 2026-11-09)

Run with Pandora replaced by melodica-tuner, /oauth/ faked, and /scrobble/ going to the real spacegho.st as the throwaway account u_e2eext00001 (bearer from the scrobble agent's access_token).

Proven:
- background playback with 0 extension pages;
- playing_now posted 0.5 to 1.1 s after play, with art_url, station_name and the client version;
- now playing on spacegho.st within 0.9 to 2.9 s, with art and art_cached;
- thumbs up and down.

Not proven live:
- a single at half the track: the tuner's songs stayed 10 s; the single logic is unit-tested;
- Brave and Firefox live;
- real GitHub sign-in;
- crew views.

The CI smokes (fake spacegho.st) cover detection, remote control, resume after a worker kill, and the feeds.

When finished, tell the scrobble agent so it erases u_e2eext00001. Do not erase it yourself.

## Queue

1. The pending contract is `defineElements` (optional). The mountX functions still work.

## Rules

- Never build or run on the workstation. Use the bak Incus container `melodica-ext` through scripts/remote-sync.sh.
- Kill tuners before a smoke: `ssh bak "incus exec melodica-ext -- sh -c 'pkill -f [m]elodica-tuner; true'"`.
- Run one smoke at a time.
- GitHub Actions is the proof. Report only what was observed.
