# Melodica optimization race — 18 November 2026

All five independent protocol implementations were optimized and compared with frozen pre-optimization versions on Fedora 44 Incus on Bak. The original October workspaces survived; their implementation inputs match the current pre-change source. No compiler flags were changed.

## Results

| Implementation | Playlist, 256 songs | Playlist, 4,096 songs | Search, 4,096 artists + songs | API suite geometric mean |
|---|---:|---:|---:|---:|
| C | 1.409× | 1.358× | 1.209× | 1.004× |
| Odin | 1.025× | 1.001× | 10.560× | 1.003× |
| Zig | 1.013× | 2.747× | 10.961× | 1.005× |
| Nelua | 1.034× | 2.767× | 10.864× | 0.998× |
| Codin | 1.006× | 1.011× | 10.300× | 1.001× |

Ratios compare each implementation with itself. A result near 1× is inconclusive at this sample size. These are implementation/workload results, not a universal ranking of languages. Odin and Codin already used tail pointers for playlists; their gains come from search list construction.

## Changes kept

1. C: hoist lookup-key length and reject unequal first bytes before decoding unescaped object keys. Escaped-key comparison and last-duplicate-wins behavior remain.
2. Odin and Codin: retain search-list tails; fetch artist, audio map and encoding values once; avoid duplicate boolean lookups.
3. Zig: retain playlist and search-list tails; avoid duplicate boolean lookups.
4. Nelua: retain playlist and search-list tails; avoid duplicate boolean lookups.

No new parser, shared C protocol adapter or compiler patch was introduced. Exported generic list functions and public ABI remain unchanged. Portable serializers were unchanged; their archived code hashes serve as controls rather than being credited with protocol gains.

## Memory and call trees

Peak useful heap plus allocator overhead, 256-song playlist; Massif diagnostic driver, 12 parse/build/free iterations:

| Implementation | Before KiB | After KiB |
|---|---:|---:|
| C | 737.3 | 737.3 |
| Odin | 1641.6 | 1641.6 |
| Zig | 1641.7 | 1641.7 |
| Nelua | 1641.6 | 1641.6 |
| Codin | 1641.6 | 1641.6 |

The changes target lookup and list-construction work, not the allocation model. Heap includes fixture JSON, parsed representation and owned output; stacks and mapped libraries are excluded. GNU time records whole-process RSS for each scaled run. These figures do not describe full-player audio playback memory.

The raw archive contains before/after Callgrind profiles and inclusive call trees for every language, Massif heaps, RSS, every process result, CPU/compiler/dependency metadata and driver hashes. Callgrind reports simulated instruction counts, not hardware time. Recursive inclusive percentages overlap.

## Method and scope

Six paired process passes use a seeded language shuffle and alternate before/after order. Both phases run on one identical CPU affinity. Each process reports the median of five timed rounds after an identical warmup. Workloads include four playlist scales, three search scales and eleven complete API fixture suites. Assertions and ownership cleanup are included in the measured work. The 4,096-item workloads are separately labelled synthetic scaling experiments.

C uses its independent parser/crypto; the other languages use json-c/libgcrypt. All baseline and candidate archive SHA-256 values, sizes and source fingerprints are recorded. The historical before/after archives were built with the same pinned toolchains and flags; the race relinks the same fresh driver against both. The baseline native source is byte-identical to the current pre-change native source. Source integration uses current main rather than restoring obsolete Git history. No frequency lock or exclusive host reservation was used. Paired min/max ratios are retained so noise is visible.

## Reproduce

```sh
python3 scripts/optimization-race.py /path/to/workspace
```

The workspace must contain frozen `before/` and `after/` roots, their `build/<lane>/libpiano.a` archives, canonical API harness objects in `build/libpiano-evidence/`, and the identical `bench/race.c`. Use Fedora with the pinned toolchains, GCC, Valgrind, GNU time, json-c and libgcrypt. Allocate task scratch and tool caches using the host storage policy. Output goes to `workspace/evidence/`. A failed benchmark aborts before the final summary is produced.

- [Complete summary, all samples/identities/commands](evidence/optimization-race-2026-11-18/summary.json)
- [Raw profiles and process outputs](evidence/optimization-race-2026-11-18/raw-profiles.tar.gz)
- [Interactive comparison on spacegho.st](https://spacegho.st/use/melodica.h/)

Application changes are independently built in `Spaceghost/melodica-web` and `Spaceghost/spaceghost-scrobble`; a library update alone does not replace an installed pianobar executable.
