# Changelog

## 1.0.0 — 2026-10-21

### Historical libpiano compatibility

- Complete all 23 normal request and response kinds in C, Odin, Zig, Nelua and
  Codin, preserving the public C ABI and historical ownership rules.
- Match the untouched pinned pianobar reference in 14 differential suites,
  including request bytes, encryption, parser coercions, layouts and error text.
- Implement Codin through its pinned parser and a general C99 lowering backend;
  retain the compiler compatibility patch and source/artifact provenance.
- Cover C allocation failures, JSON accessors, all non-NUL request bytes and
  sanitizer checks. Compile unchanged historical pianobar application sources.

### Packaging and comparisons

- Install any of the five protocol archives with public headers, pkg-config
  metadata, an offline client example and the original libpiano license.
- Compare the five serializers, six full API implementations and six scaled
  playlist parsers with retained samples, hashes, flags and dependency records.
- Provide `make check` and Fedora/Debian worker setup, with isolated one-job
  Incus runners and readable CI evidence when artifact uploads are unavailable.

The [completeness ledger](docs/libpiano-completeness.md) defines the tested
contract and links the retained results. Live Pandora access is outside the
offline compatibility contract. The upstream undefined direct `ADD_FEEDBACK`
success response returns a safe error.

## 0.2.0

Portable serializers and the initial C libpiano implementation, before the
complete five-language protocol and comparison work.
