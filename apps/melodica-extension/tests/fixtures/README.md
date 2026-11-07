# Test fixtures

`melodica-web-dist/` is the built `dist/` of
[melodica-web](https://github.com/Spaceghost/melodica-web) release v0.2.0
(`melodica-web-0.2.0.tar.gz`, SHA256 verified against the release's
`SHA256SUMS` when it was copied here on 2026-11-06). The bridge smoke test
serves it on a local https origin that Chromium is told is `spacegho.st`, so
the extension's content script runs against the real page exactly as shipped.
MIT (see `LICENSE` and `LICENSE.libpiano` inside); the page itself is not
modified. It is a fixture, not the source of truth: update it from the latest
melodica-web release when the page gains bridge support.
