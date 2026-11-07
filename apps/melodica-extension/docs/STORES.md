# Store publishing

How melodica-extension reaches Firefox, Chrome, Brave and Edge, what CI does on each
`v*` tag, and the one-time steps only Jack can do (store registrations and credentials).
Self-hosting at <https://spacegho.st/extensions/> stays the fallback for every browser.

| Browser | Primary route | Fallback (self-hosted) |
| --- | --- | --- |
| Firefox 128+ | the release `.xpi`, **signed by Mozilla** (AMO, unlisted channel) from the store page | the same file; unsigned only if signing fails (see "If Mozilla rejects a version") |
| Chrome | Chrome Web Store, unlisted item (link only) | `.crx` drag-install on Linux, unpacked zip, or enterprise policy |
| Brave | the same Chrome Web Store item (Brave installs from the CWS unchanged) | same as Chrome |
| Edge | Microsoft Edge Add-ons, hidden product (link only); or the CWS item after "Allow extensions from other stores" in `edge://extensions` | same as Chrome |

## What CI does on a tag

`.github/workflows/ci.yml`, in order:

1. `build`: builds, tests, lints and packages. With the secrets `AMO_JWT_ISSUER` and
   `AMO_JWT_SECRET` it runs `web-ext sign --channel unlisted` on `dist/firefox` and replaces
   `melodica-extension-<ver>.xpi` with the file Mozilla signed (`META-INF/mozilla.rsa`
   inside); `release/SIGNED` makes the release notes say "Signed by Mozilla". Without them the
   `.xpi` is the unsigned Firefox zip and the notes say so.
2. `smoke` and `smoke-brave`: the browser proofs (README).
3. `release`: the GitHub release with every asset, including
   `melodica-extension-<ver>-cws.zip`, the Chrome build **without `update_url`** (the Chrome
   Web Store rejects manifests that carry one; Edge Add-ons takes the same package).
   `-chrome.zip` and the `.crx` keep `update_url` for the self-hosted feed.
4. `publish-cws`: with the five `CWS_*` secrets, uploads `-cws.zip` to the existing Chrome
   Web Store item and submits it for review (`chrome-webstore-upload-cli@4.0.2`, Chrome Web
   Store API v2). Without them it logs one "skipped" line and succeeds.
5. `publish-edge`: with the three `EDGE_*` secrets, uploads the same zip to the Edge Add-ons
   product's draft submission and publishes it (`scripts/edge-publish.sh`, Add-ons REST API
   v1.1: `Authorization: ApiKey …`, `X-ClientID: …`). Without them it logs one "skipped" line.

Both store jobs fail loudly on any API error (HTTP status and body in the log; the credentials
are never printed). Neither job can create a listing or change its visibility: the stores
only expose those in their dashboards, so the one-time setup below is manual. After the
release, run the store sync (`node scripts/sync.mjs melodica-extension` in extensions-site
and melodica-site) so <https://spacegho.st/extensions/> serves the new files and feeds.

What a green `publish-*` job proves: the upload was accepted and the version was submitted.
Store review happens afterwards in the dashboards; CI does not wait for it or read its result.

## One-time steps for Jack

### Firefox (done)

`AMO_JWT_ISSUER` / `AMO_JWT_SECRET` from <https://addons.mozilla.org/developers/addon/api/key/>
are set. v0.1.4 (run 42348057877) was the first signed release: `web-ext sign` reported
"Waiting for validation… Waiting for approval… Signed xpi downloaded" after about five
minutes, and the released `.xpi` contains `META-INF/mozilla.rsa`, `mozilla.sf`, `manifest.mf`,
`cose.sig`, `cose.manifest`. The add-on id is `melodica-extension@spacegho.st`; it is unlisted
(no addons.mozilla.org page), updates come from
`https://spacegho.st/extensions/dl/melodica-extension/updates.json`.

`web-ext lint` prints the notice `MISSING_DATA_COLLECTION_PERMISSIONS`: Mozilla requires
`browser_specific_settings.gecko.data_collection_permissions` for extensions first submitted
after 2025-11-03 and has announced it for all extensions; AMO did not enforce it for this id
on 2026-11-07. If a future signing run is refused for it, the fix is in the manifest template
(`public/manifest.json`): `"data_collection_permissions": {"required": ["authenticationInfo"]}`
(the Pandora login is transmitted to pandora.com, or to the endpoint set on the options
page) with `strict_min_version` raised to `140.0`, which that key requires. Once added it
must stay in every later version.

### Chrome Web Store (Chrome, Brave; also Edge)

1. Register as a Chrome Web Store developer at <https://chrome.google.com/webstore/devconsole>
   (Google account, one-time US$5 fee, email verification).
2. **New item** → upload `melodica-extension-<ver>-cws.zip` from the latest release (not
   `-chrome.zip`: the dashboard rejects a manifest with `update_url`).
3. **Store listing**: name "melodica for Pandora", category Entertainment, language English.
   Description, icon (`icons/icon-128.png` from the zip) and at least one 1280×800 or 640×400
   screenshot are required (the smoke screenshots on the release are 1280×800 PNGs:
   `smoke-extension-stations.png`, `smoke-extension-playing.png`).
4. **Distribution** → Visibility: **Unlisted** (only the link reaches it; not searchable).
   Leave payments "free", all regions.
5. **Privacy practices**, text drafted below; copy it in.
6. Submit for review. The item id is the 32-letter string in the dashboard URL and in the
   listing URL `https://chromewebstore.google.com/detail/<id>`; the publisher id is on the
   dashboard **Account** page (and in the dashboard URL after `/devconsole/`).
7. OAuth client + refresh token: follow <https://github.com/fregante/chrome-webstore-upload-keys>
   (Google Cloud project → enable "Chrome Web Store API" → OAuth consent screen, add yourself
   as a test user → OAuth client of type Desktop → run the guide's one-off command to obtain
   the refresh token).
8. Repository secrets (Settings → Secrets and variables → Actions):
   `CWS_EXTENSION_ID`, `CWS_PUBLISHER_ID`, `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN`.
9. Put the item id in extensions-site `data/extensions.json` as `cws_id` and redeploy
   (`npx wrangler deploy`): the store page then shows "Add to Chrome / Brave".

Each later tag uploads and submits the new version automatically; the first upload of every
version after that still goes through Google's review (usually hours to a few days).

#### Privacy practices (draft to paste)

**Single purpose**: Plays Pandora stations from the browser toolbar by talking to Pandora's
JSON API directly, and relays requests for the web player at spacegho.st/melodica/app/ so
that page needs no relay server.

**Permission justifications**

- `storage`: keeps the settings (API endpoint, audio quality) and, only when the user ticks
  "remember password", the Pandora login, in the extension's own storage.
- `host_permissions` `https://tuner.pandora.com/*`, `https://*.pandora.com/*`: Pandora's JSON
  API (login, stations, playlists, feedback) and the audio streams it returns.
- `optional_host_permissions` `https://*/*`, `http://*/*`: requested only if the user enters a
  different API endpoint on the options page and clicks "Grant access" (for a self-hosted
  test server); never requested otherwise.
- Content script on `https://spacegho.st/melodica/app/*`: the bridge for the melodica web
  player; it answers only that page's `postMessage`s and forwards them to the endpoint.
- Remote code: none. All code is in the package; the WebAssembly module is bundled
  (`'wasm-unsafe-eval'` in the CSP is for that module).

**Data use disclosure**: Authentication information (the Pandora username and password) is
sent only to pandora.com (or to the endpoint the user configures) to sign in; it is stored
only in the extension's storage on the user's device, and only when "remember password" is
on. No data is sold, used for unrelated purposes, or used for creditworthiness or lending.
No analytics, no telemetry, no server of the developer's receives anything. Website content
(the melodica web page's requests) is relayed to the configured endpoint and not stored.

Privacy policy URL: `https://spacegho.st/extensions/#melodica-extension` (the "What it does
with your data" section).

### Microsoft Edge Add-ons (Edge)

1. Register at <https://partner.microsoft.com/dashboard/microsoftedge/> (Microsoft account;
   the Edge program is free).
2. **Create new extension** → upload the same `melodica-extension-<ver>-cws.zip`.
3. **Availability** → Visibility: **Hidden** (reachable only by link). Markets: all.
4. **Properties**: category Entertainment, privacy policy URL as above, the same
   single-purpose text; **Store listings**: description, logo, screenshots (as for CWS).
5. Submit. The **Product ID** (a GUID) is on the extension overview page and in the dashboard
   URL between `microsoftedge/` and `/packages`; the listing is
   `https://microsoftedge.microsoft.com/addons/detail/<store id>` (the store id shown on the
   same overview page once certified; it differs from the product GUID).
6. **Publish API** (left menu) → "Enable" the new experience → **Create API credentials**:
   this shows the **Client ID** and one **API key** (with an expiry date; renew there and
   rotate the secret when it expires).
7. Repository secrets: `EDGE_PRODUCT_ID` (the GUID), `EDGE_CLIENT_ID`, `EDGE_API_KEY`.
8. Put the store id in extensions-site `data/extensions.json` as `edge_id` and redeploy.

Edge can also install the Chrome Web Store item: `edge://extensions` → "Allow extensions from
other stores" → the CWS link. Brave installs from the Chrome Web Store directly.

## If Mozilla rejects a version

Signing failed for no tag so far; the first attempt (v0.1.4) succeeded. If `web-ext sign`
refuses a later version, the step's log shows the validator's message verbatim; fix the
cause and tag the next patch version (Mozilla never signs the same version twice). Until a
signed file exists for a version, the release's `.xpi` is unsigned and these are the honest
install routes, also shown on the store page:

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
