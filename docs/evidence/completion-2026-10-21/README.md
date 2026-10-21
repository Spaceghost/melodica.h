# Completion evidence — 2026-10-21

Canonical command: `make check`, exit **0**, on Fedora 44 x86_64 in
`bak:melodica-complete-20261020`, workspace `/work/melodica`.
The compiled source commit is
[`d9d22ed2670f70bc35130528c9281bebae1670c1`](https://github.com/Spaceghost/melodica.h/commit/d9d22ed2670f70bc35130528c9281bebae1670c1).
The following commit adds documentation and these retained outputs.

| Record | Result / contents |
|---|---|
| [Canonical log](canonical-check.log) | Full command sequence: safety, portability, consumer, 50 harness tests, three comparison leagues and installation |
| [Serializer standings](serializer/standings.txt), [correctness](serializer-correctness/status.json) | All five lanes pass 1,591 cases / 125,022 checks and the unchanged 90% mean / 80% worst gate |
| [C/reference status](api-c/status.txt), [native status](api-native/status.json), [native standings](api-native/standings.txt) | All 14 differential suites match; native layouts pass 313 checks per implementation; six-way API and playlist measurements |
| [Consumer status](consumer/status.txt), [installation output](install/c.txt) | Eight unchanged historical application objects compile; all five installed public clients agree |

## Reading the records

`serializer`, `api-c` and `api-native` contain raw opposite-order timing passes,
validated summaries, source/artifact hashes and environment records. Each process
reports its five-round median. API throughput counts complete fixture suites;
playlist throughput counts parse/build/free requests. The shared serializer
workloads are unchanged.

`serializer-correctness` retains independent build, conformance, symbol, size and
dependency logs. `api-native` also retains actual compiled native layout results,
public-symbol lists and dynamic dependencies. Native protocol variants use json-c
and libgcrypt; C implements both operations internally. Archive sizes exclude
separately linked runtime libraries.

`sanitizers` and the canonical log record ASan/UBSan/leak checks, 102 allocation
failure positions, 55 json-c accessor values and 255 non-NUL request-byte variants.
The `consumer` and `install` directories preserve their commands and outputs.
Synthetic all-100 benchmark scores printed by Python regression tests in the
canonical log are test fixtures; the measured serializer rankings are exclusively
in `serializer/standings.txt`.

## Development attempts and scope

`attempts` retains the failed serializer attempts 1–6 and successful candidate 7.
Their rankings are historical. The fresh canonical run in `serializer` is the
completion result. The API timing harness was corrected before the canonical run
to prevent glibc inline `putchar` from printing during fixture timing.

Validation is offline against untouched pianobar revision
`ad5ec908de10479ecee7d7c0e1030d12146f8f16`; live Pandora service access is outside
this contract. Direct successful low-level `ADD_FEEDBACK` has no defined upstream
success contract and returns a safe error. See the
[completeness ledger](../../libpiano-completeness.md) for ownership and boundary details.

GitHub runner execution and exact worker cleanup records accompany the release
evidence archive; these local reports do not assert that a GitHub job ran.
