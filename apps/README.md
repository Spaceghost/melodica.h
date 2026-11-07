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
apps/pull.sh            # pull every client's branch (squashed)
apps/pull.sh pithos     # one client
```

`pull.sh` runs `git subtree pull --squash` against the GitHub repository; it needs
read access to the client repositories. Changes made here can be sent back with
`git subtree push --prefix=apps/<dir> <repo> <branch>`, but prefer committing in the
client repository and pulling.
