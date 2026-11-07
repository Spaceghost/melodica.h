# apps/

Every Pandora client rebuilt on melodica.h, vendored here as a `git subtree` so the
whole family is readable in one public tree. Each directory is a squashed snapshot of
the client's working branch; the client's own repository stays the place where it is
developed, built and released.

| directory | client | from | branch | upstream |
| --- | --- | --- | --- | --- |
| `melodica-web/` | Melodica Web (WebAssembly, in-browser) | Spaceghost/melodica-web | master | — |
| `pithos/` | Pithos (GTK, Linux Flatpak) | Spaceghost/pithos | master | pithos/pithos |
| `elpis/` | Elpis (Windows desktop) | Spaceghost/elpis-melodica | master | adammhaile/Elpis |
| `epimetheus/` | Epimetheus (Flutter, Android + web) | Spaceghost/epimetheus | dev | EpimetheusMusicPlayer/Epimetheus |
| `pandoroid/` | Pandoroid (Android) | Spaceghost/pandoroid | master | dylanPowers/pandoroid |
| `xivpiano/` | XivPiano (FFXIV Dalamud plugin) | Spaceghost/xivpiano-melodica | integration/melodica | Spaceghost/xivpiano-dalamud |
| `umbra-piano/` | Umbra for XivPiano (snapshot) | Spaceghost/umbra-piano | main | una-xiv/umbra |
| `pianobar/` | pianobar (Linux console) | Spaceghost/pianobar | master | PromyLOPh/pianobar |
| `pianobar-windows/` | pianobar for Windows (console) | Spaceghost/pianobar-windows | develop | thedmd/pianobar-windows |
| `pydora/` | pydora (Python library + terminal player) | Spaceghost/pydora | master | mcrute/pydora |

Downloads, installers and the CI "installs, opens and logs in" evidence for every
client are at <https://spacegho.st/melodica/>. The test server those CI jobs log in to
is [Spaceghost/melodica-tuner](https://github.com/Spaceghost/melodica-tuner).

## Refreshing a snapshot

```sh
apps/pull.sh            # re-snapshot every client from its branch
apps/pull.sh pithos     # one client
```

`pull.sh` replaces `apps/<dir>` with the full tree of the branch listed in `apps/apps.tsv`
and records the source commit in the commit message (`Source-Commit:`). It needs read
access to the client repositories and keeps working after a branch has been rebased.
Edit in the client repository, not here; this tree is a read-only mirror.

## Tracking upstreams and rebasing

Every client except Melodica Web is a fork of an upstream project, and our melodica.h
commits sit on top of upstream history. `apps/upstream.sh` keeps one work clone per app
(in `../melodica-apps-work`, or `$MELODICA_APPS_WORK`) with remotes `origin` (our fork)
and `upstream`, and drives the rebase:

```sh
apps/upstream.sh status            # ours/theirs commit counts against each upstream
apps/upstream.sh rebase pithos     # tag pre-rebase/<stamp>, rebase our branch onto upstream
# resolve conflicts in the work clone if any: git add …; git rebase --continue
apps/upstream.sh push pithos       # push --force-with-lease, push the safety tag, re-snapshot apps/pithos
```

The tag `pre-rebase/<stamp>` is pushed with the branch, so the previous history can always
be recovered with `git reset --hard pre-rebase/<stamp>`. Only `fetch` and `push` touch a
remote. Note: Epimetheus upstream rewrote its history in `dev-new-architecture`; our fork
descends from upstream `dev`, which is what `apps.tsv` tracks.
