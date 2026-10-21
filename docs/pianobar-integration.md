# Pianobar integration

The complete pinned pianobar application builds and runs with melodica v1.0.0's
C libpiano replacement on Fedora 44 and FFmpeg 8. No application source changes
or FFmpeg compatibility patch were required.

## Reproduce

From a melodica checkout, run:

```sh
sh scripts/pianobar-integration.sh
```

The script requires GCC, GNU make, Git, Python 3, pkg-config, binutils, `unshare`,
and development packages for FFmpeg, libao, libcurl, libgcrypt and json-c. Its
offline checks require permission to create a network namespace. It archives
the pinned reference into a fresh workspace and never builds inside that
reference checkout. `WORK_DIR`, `EVIDENCE_DIR` and `PIANOBAR_REFERENCE` can select
other directories; an evidence directory must be empty to preserve earlier runs.

The application keeps its HTTP transport, UI, settings and audio player. The
build overrides only the libpiano include directory and linked objects:

```sh
make -C /path/to/melodica.h libpiano
make -B -C /path/to/pianobar pianobar CC=gcc DYNLINK=0 \
  LIBPIANO_INCLUDE=/path/to/melodica.h/include \
  LIBPIANO_OBJ=/path/to/melodica.h/build/compat/libpiano.a \
  CFLAGS='-O2 -std=c99 -D_DEFAULT_SOURCE -DMELODICA_PIANO_LEGACY_GCRYPT'
```

For an installed archive, use `LIBPIANO_OBJ=` and
`LDFLAGS="$(pkg-config --static --libs piano)"`, with `LIBPIANO_INCLUDE` set to
`$(pkg-config --variable=includedir piano)`. Select the implementation during
melodica installation with `PIANO_IMPL=c|odin|zig|nelua|codin`. The full-application
run documented here uses C; installed API clients separately cover all five.
Unchanged pianobar still initializes libgcrypt itself, so it retains that
application dependency even when the selected C protocol archive needs none.

## Retained checks

[The Fedora run](evidence/pianobar-integration-2026-10-21/checks.json) records:

- All nine application objects compile and link, including `player.o`; source
  hashes remain unchanged. Seven dependency files select melodica's `piano.h`.
- Link maps and symbol records identify the replacement archive; bundled
  libpiano objects are absent.
- With an empty configuration directory, a blank email line exits successfully
  after displaying the application banner. No login is attempted. Upstream's
  command-line arguments do not provide a help/version exit, and EOF alone
  waits for further input.
- The exact `player.o` linked into the application decodes a generated one-second
  440 Hz WAV through FFmpeg and libao's null driver. Its 44,100 mono 16-bit samples
  match all 88,200 input PCM bytes exactly. Test wrappers select the null driver
  and record PCM; the player and decoder are unchanged.

Both runtime checks run without network access. They use no Pandora credentials
and open no host audio device. Live Pandora authentication, station playback
and the user's actual audio hardware remain untested.

[Provenance](evidence/pianobar-integration-2026-10-21/provenance.json),
[build output](evidence/pianobar-integration-2026-10-21/application-build.log),
and [artifact hashes](evidence/pianobar-integration-2026-10-21/artifacts.sha256)
are retained alongside the checks. The executable remains at the worker path
recorded in provenance; generated binaries are outside the source repository.
