# Why not the stores

melodica-extension is not on the Chrome Web Store, Microsoft Edge Add-ons or the
addons.mozilla.org listings, and will not be. The only distribution is the self-hosted
store at <https://spacegho.st/melodica/extension/>: the release `.xpi`,
`.crx` and unpacked zips from GitHub, mirrored with their checksums and update feeds.

melodica is distributed only from spacegho.st/extensions; access is decided by
spacegho.st per Pandora login, which the stores cannot express. "Unlisted" and
"hidden" hide a listing from search, not from anyone with the link, and a reviewer would
be handed a player that refuses them. We also will not ship a store build that behaves
differently from the self-hosted one (a build without the access check, or with a different one)
so that a store would accept it. One build, one behaviour, openly documented (README,
"Access").

What was removed on 2026-11-07 (v0.2.0): the `publish-cws` and `publish-edge` jobs,
`scripts/edge-publish.sh`, the `-cws.zip` package (the Chrome build without
`update_url`), the `CWS_*` / `EDGE_*` secrets they read, and the `cws_id` / `edge_id`
store buttons on the store page. No listing was ever created; nothing is left to take down.

## Firefox: signed by Mozilla, listed nowhere

The one store interaction that stays is the **signature**. Release Firefox refuses an
unsigned add-on, and the only signer is addons.mozilla.org. Its *unlisted* channel signs a
file without creating a listing: there is no AMO page, nothing is searchable, the signed
`.xpi` is served from spacegho.st, and updates come from
`https://spacegho.st/extensions/dl/melodica-extension/updates.json` (the
`gecko.update_url` in the manifest), not from Mozilla. The access check is in the signed file
exactly as in every other build.

### What CI does on a tag

`.github/workflows/ci.yml`, `build` job: with the repository secrets `AMO_JWT_ISSUER` and
`AMO_JWT_SECRET` (from <https://addons.mozilla.org/developers/addon/api/key/>) it runs
`web-ext sign --channel unlisted` on `dist/firefox` and replaces
`melodica-extension-<ver>.xpi` with the file Mozilla signed (`META-INF/mozilla.rsa`,
`mozilla.sf`, `manifest.mf`, `cose.sig`, `cose.manifest` inside); `release/SIGNED` makes
the release notes say "Signed by Mozilla". Without the secrets the `.xpi` is the unsigned
Firefox zip and the notes say so. Branch builds are never signed (every one is version
0.0.0 to AMO, which takes a version once). v0.1.4 (run 42348057877) was the first signed
release; the add-on id is `melodica-extension@spacegho.st`.

`web-ext lint` prints the notice `MISSING_DATA_COLLECTION_PERMISSIONS`: Mozilla requires
`browser_specific_settings.gecko.data_collection_permissions` for extensions first submitted
after 2025-11-03 and has announced it for all extensions; AMO did not enforce it for this id
on 2026-11-07. If a future signing run is refused for it, the fix is in the manifest template
(`public/manifest.json`): `"data_collection_permissions": {"required": ["authenticationInfo"]}`
(the Pandora login is transmitted to pandora.com, or to the endpoint set on the options
page; the login email is sent to spacegho.st for the access check) with `strict_min_version` raised to
`140.0`, which that key requires. Once added it must stay in every later version.

### If Mozilla rejects a version

Signing failed for no tag so far. If `web-ext sign` refuses a later version, the step's log
shows the validator's message verbatim; fix the cause and tag the next patch version
(Mozilla never signs the same version twice). Until a signed file exists for a version,
the release's `.xpi` is unsigned and these are the honest install routes, also shown on the
store page:

1. **Firefox Developer Edition, Nightly or ESR**: `about:config` →
   `xpinstall.signatures.required` = `false`, then open the `.xpi`.
2. **ESR with an enterprise policy**: `ExtensionSettings` with
   `"melodica-extension@spacegho.st": {"installation_mode": "force_installed",
   "install_url": "https://spacegho.st/extensions/dl/melodica-extension/latest/melodica-extension-<ver>.xpi"}`
   and `"*": {"install_sources": ["https://spacegho.st/extensions/*"]}`; signatures are
   disabled by policy only on ESR (`xpinstall.signatures.required` via `Preferences`).
3. **Any Firefox, temporarily**: `about:debugging#/runtime/this-firefox` → Load Temporary
   Add-on → the `.xpi` or `manifest.json` of the unzipped `-firefox.zip`; gone when Firefox
   quits.

Release Firefox proper has no route to an unsigned add-on.

## Chrome, Edge, Brave: self-hosted only

The `.crx` is a CRX3 signed with the repository's key (`CRX_PRIVATE_KEY`; extension id
`obbahflgghfemmpmjppeibnemibgblbd`) and carries `update_url`
`https://spacegho.st/extensions/dl/melodica-extension/update.xml`. Linux: drag it onto
`chrome://extensions` (`brave://extensions`, `edge://extensions`) with Developer mode on.
Windows and macOS block off-store `.crx` installs except by enterprise policy
(`ExtensionInstallSources` + `ExtensionInstallForcelist` with that `update.xml`; Brave
honours the same Chromium policies); otherwise load `-chrome.zip` unpacked. The store page
spells out each route. After a release, complete the full cycle below.

## Required release completion

A GitHub release alone does not finish a release. Keep Mozilla's unlisted signing and the existing self-hosted distribution, as Jack confirmed on 2026-11-09.

1. Require the build and Chromium, Brave and Firefox checks to pass. Inspect the tagged XPI for Mozilla signature files and its exact version; verify published packages against SHA256SUMS. Record any iOS simulator or device limitations separately.
2. Check Fedora Cloudflare access with `npx -y wrangler@4.135.0 whoami`. If unauthenticated, leave publication pending and request `npx -y wrangler@4.135.0 login`. With access, run `node scripts/sync.mjs melodica-extension` from `~/Projects/extensions-site`, then the same command from `~/Projects/melodica-web/site`. The former updates browser downloads and Firefox/Chromium feeds; the latter updates the Melodica install page. The retired melodica-site repository must never be deployed.
3. Run `node scripts/check-release-sites.mjs <version>` from melodica-extension. It fails until both public catalogs, both feeds and eight public package downloads match the GitHub release. Verify both public manifests advertise the new tag. Check the Firefox feed's version, update URL and SHA-256 against the signed XPI, and the Chromium feed's version and CRX URL. Download public installables and compare their hashes. Check `/extensions/` and `/melodica/extension/` at mobile and desktop widths: the Melodica page contains only Melodica browser extensions and links to the full browser-extension catalog. Neither catalog lists native apps. Verify the pinned player and uninterrupted navigation in the Melodica shell.
4. Refresh `melodica.h` with `apps/pull.sh melodica-extension`, preserving exclusions for private code. Update HANDOFF.md with the exact tag, CI runs, deployed feed versions, public download checksums and remaining limits. Mark the release complete only after both catalogs and update feeds are verified.
