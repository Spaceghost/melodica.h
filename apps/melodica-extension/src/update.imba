# Update awareness, independent of the browser's own update machinery: which
# version the self-hosted store currently serves, compared with the running
# one, and what the banner in the pages should say. The feeds are the ones
# extensions-site writes: `updates.json` (Firefox's format, read by the Firefox
# build) and `releases.json` (the store manifest, read by the Chromium build).

export const STORE_URL = 'https://spacegho.st/melodica/extension/'
export const FEED_BASE = 'https://spacegho.st/extensions'
export const EXTENSION_ID = 'melodica-extension'
export const GECKO_ID = 'melodica-extension@spacegho.st'

# Dotted numeric versions ("0.2.0", "0.10.1"; a trailing "-tag" is ignored):
# -1, 0 or 1. Anything that is not a version compares as 0.0.0.
export def compareVersions a, b
	const pa = parts(a)
	const pb = parts(b)
	const n = Math.max(pa.length, pb.length)
	let i = 0
	while i < n
		const x = pa[i] or 0
		const y = pb[i] or 0
		return -1 if x < y
		return 1 if x > y
		i += 1
	0

def parts v
	const m = String(v or '').trim().match(/^v?(\d+(?:\.\d+)*)/)
	return [] unless m
	m[1].split('.').map(do(s) Number(s))

export def isVersion v
	/^v?\d+(\.\d+)*(-.*)?$/.test(String(v or '').trim())

# The feed URL for this build: the Firefox build reads updates.json, the
# Chromium build the store manifest.
export def feedUrl manifest, base = FEED_BASE
	manifest and manifest.browser_specific_settings ? "{base}/dl/{EXTENSION_ID}/updates.json" : "{base}/releases.json"

# The newest version a feed names, or null. Accepts both shapes:
#   updates.json  {addons: {<gecko id>: {updates: [{version, update_link, update_hash}]}}}
#   releases.json {extensions: [{id, release: {tag}, feeds: {firefox: {version}, chrome: {version}}}]}
export def latestVersion feed
	return null unless feed and typeof feed === 'object'
	let best = null
	const consider = do(v)
		return unless isVersion(v)
		const clean = String(v).trim().replace(/^v/, '').replace(/-.*$/, '')
		best = clean if best === null or compareVersions(clean, best) > 0
	if feed.addons and feed.addons[GECKO_ID] and Array.isArray(feed.addons[GECKO_ID].updates)
		for u in feed.addons[GECKO_ID].updates
			consider(u and u.version)
	if Array.isArray(feed.extensions)
		const ext = feed.extensions.find(do(e) e and e.id === EXTENSION_ID)
		if ext
			consider(ext.feeds and ext.feeds.firefox and ext.feeds.firefox.version)
			consider(ext.feeds and ext.feeds.chrome and ext.feeds.chrome.version)
			consider(ext.release and ext.release.tag) if best === null
	best

# What the pages show: null when up to date (or unknown), else the banner.
# `available` is the version runtime.onUpdateAvailable announced (Chromium has
# the new package and a reload installs it); `latest` is what the store serves.
export def bannerState current, latest, available = null
	const newest = [latest, available].filter(do(v) isVersion(v)).sort(do(a, b) compareVersions(b, a))[0] or null
	return null unless newest and compareVersions(newest, current) > 0
	{
		version: newest
		text: "melodica {newest} is available"
		url: STORE_URL
		reload: !!(available and compareVersions(available, current) > 0)
	}
