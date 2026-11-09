# Background (MV3 service worker in Chrome, background page in Firefox): owns
# the Pandora session, does every request to Pandora, owns the playback state
# and relays for the popup, the player page and the bridge content script.
# State that must survive the worker being stopped lives in storage.session
# (storage.local as fallback).
#
# Playback runs without any tab. The engine (engine.imba) lives in an offscreen
# document in Chromium (offscreen.imba; created here on the first play command,
# kept alive by Chrome while audio plays) and in this background page itself in
# Firefox, which has no offscreen API (the gecko manifest marks the background
# persistent). Either way this file holds `player`, the single source of truth,
# persists it in storage.session, broadcasts every change as `player-state`,
# and takes the commands; the popup, the player tab, the options page and the
# web player over the bridge are views of it.

import { Core } from './core.imba'
import { Pandora, PandoraError, QUALITIES } from './pandora.imba'
import { browser, loadSettings, normalizeEndpoint, fromBase64, toBase64, SETTINGS_DEFAULTS } from './shared.imba'
import { seal, unseal, wipe, vaultAvailable, sealAs, unsealAs, wipeAs } from './vault.imba'
import { parseListenUri } from './listen-uri.js'
import { SCROBBLE_NOTICE, LEADERBOARD_URL, MELODICA_PAGES, recentFrom, listenOf, prependListen, isSpot, trackMetadata, thresholdSeconds, playingNow, single, enqueue, outcome, genomeTraits, failureText, deploymentText, SEED_KINDS, seedStation, seedPick } from './scrobble.imba'
import { normalizeAccountBase, randomString, pkceChallenge, authorizeUrl, parseRedirect, tokenForm, storedTokens, accessFresh, policyFrom, spotsFlag, accountLabel, jwtClaims, CLIENT_ID, TAB_CLIENT_ID, TAB_REDIRECT, POLICY_DEFAULT } from './account.imba'
import { feedUrl, latestVersion, bannerState, compareVersions, STORE_URL } from './update.imba'
import { Engine, dropAudioCopies } from './engine.imba'
import { validatePlayback } from './playback-transfer.js'
import { PlaybackCopy } from './playback-copy.js'
import { RoomEngine, validRoomCommand } from './room-engine.js'
import { publicRoomMember, publicRoomSummary } from './room-state.js'

const METHOD = /^[a-z]+\.[A-Za-z]+$/
const PLAYER_URL = browser.runtime.getURL('player.html')
const session = browser.storage.session or browser.storage.local
const playbackCopy = new PlaybackCopy(do(token)
	return null unless globalThis.caches
	const cache = await globalThis.caches.open('melodica-audio')
	await cache.match("https://melodica.invalid/audio/{encodeURIComponent(token)}"))
# Safari (iPhone, iPad): no offscreen API, and a background page Safari unloads when
# idle (dist/safari's manifest says `persistent: false`, scripts/safari.mjs), so the
# engine lives in the player tab instead: dist/safari's player.html also loads
# offscreen.js, and the background opens that tab on the first play command.
const TAB_ENGINE = !browser.offscreen and (browser.runtime.getManifest().background or {}).persistent === false
# Safari has no identity API either: its spacegho.st sign-in runs in a tab that comes
# back to the web app page, where a content script hands over the redirect address.
const SIGNIN_PENDING_FOR = 10 * 60 * 1000
let engineWaiters = []
const SESSION_KEYS = {session: null, stations: [], player: null, log: [], melodica: null, meta: null, room: null}
const PLAYER_IDLE = {status: 'idle', station: null, track: null, position: 0, duration: 0, volume: 80, quality: 'high', queueLength: 0, queue: [], error: '', history: [], changedAt: 0}
const PLAYER_ACTIONS = new Set(['play', 'resume', 'pause', 'toggle', 'next', 'love', 'ban', 'tired', 'sleep', 'stop', 'volume', 'quality'])
const LOG_MAX = 200
# The spacegho.st account's policy is asked again at least this often while the
# extension is in use (every boot, every page open past this age).
const ACCOUNT_MAX_AGE = 60 * 60 * 1000

let booting = null
let state = null
let logLines = []
# Playback: the last state the engine reported (persisted in storage.session),
# plus the engine itself when it runs in this document (Firefox).
let player = Object.assign({}, PLAYER_IDLE)
let room = {id: null, state: null, audio: {state: 'idle'}, changed: 0}
let roomEngineReady = no
let roomRestore = null
# The song this device's engine played last (sealed in storage.local `lastPlay`):
# {station, track, position, duration, quality, queue, savedAt}.
let lastPlay = null
let lastSealedAt = 0
let engine = null
let localRoomEngine = null
let offscreenReady = null
let offscreenClosing = null
# Tabs whose page subscribed over the bridge (docs/BRIDGE.md layer 2). Content
# scripts do not receive runtime.sendMessage broadcasts, so state goes to each
# by tabs.sendMessage; the set is kept in storage.session so a restarted service
# worker still knows them.
let subscribers = null
# The optional spacegho.st account (docs/ACCOUNT.md): {signedIn, label, email, sub,
# spots, checkedAt, error}. Without one the policy is the default. Tokens
# live in storage.local `account` ({access, refresh, accessExp, idToken}).
let account = {signedIn: no, label: '', email: '', sub: '', spots: yes, checkedAt: 0, error: ''}
let accountChecking = null
let accountBooted = no
# melodica access: the spacegho.st answer for the Pandora login email, asked at
# https://spacegho.st/oauth/melodica/access before auth.userLogin, then again at
# boot and hourly (docs/ACCOUNT.md).
const ACCESS_MAX_AGE = 60 * 60 * 1000
const ACCESS_RETRY = 5 * 60 * 1000
const ACCESS_DENIED = 'melodica access is by allow-list. Your request has been sent.'
const ACCESS_UNAVAILABLE = 'The melodica access check is unavailable right now. Try again in a moment.'
let access = {email: '', allowed: no, spots: yes, checkedAt: 0, message: '', error: ''}
# docs/ACCOUNT.md: after the Pandora login, /oauth/melodica/login-ok returns a verified
# melodica access token (12 h); with it (or the spacegho.st account's token)
# /oauth/melodica/me names the user and /oauth/melodica/username changes the name.
# Kept in session storage; never logged; no email is kept here.
const MELODICA_IDLE = {token: '', exp: 0, username: '', chosen: no, suggested: '', notice: '', later: no, github: ''}
const MELODICA_TOKEN_FOR = 11 * 60 * 60 * 1000
let melodica = Object.assign({}, MELODICA_IDLE)
# The current Pandora session's id and start (docs/BRIDGE.md 4.1): minted at each login.
let sessionMeta = null
let melodicaAsking = null
let accessChecking = null
let accessBooted = no
# Updates: the store feed is read at most every UPDATE_EVERY (on boot, then
# whenever a page asks and the last look is older); on Chromium the browser is
# also asked to run its own update check, and an update it has fetched
# (runtime.onUpdateAvailable) is installed by runtime.reload() as soon as
# nothing is playing. Firefox updates add-ons itself from gecko.update_url.
const UPDATE_EVERY = 6 * 60 * 60 * 1000
let update = {current: browser.runtime.getManifest().version, latest: null, available: null, checkedAt: 0, error: '', feed: ''}
let updateChecking = null
let scrobbleBooted = no
let stationsBooted = no
let updateBooted = no

# The background log: console.debug plus a ring of the last LOG_MAX lines kept
# in session storage, which the options page's "Copy diagnostics" reads (the
# background console is hard to reach in Firefox). Lines carry no tokens: the
# client logs method names, sizes, codes and the clock offset only.
def note line
	const text = "{new Date().toISOString()} {line}"
	console.debug("melodica {line}")
	logLines.push(text)
	logLines.splice(0, logLines.length - LOG_MAX) if logLines.length > LOG_MAX
	session.set({log: logLines}).catch(do(e) null)

def boot
	const settings = await loadSettings()
	const url = browser.runtime.getURL('core/melodica_core.wasm')
	const bytes = await (await fetch(url)).arrayBuffer()
	const core = await Core.load(bytes)
	throw new Error('melodica core: key setup failed') unless core.init()
	const client = new Pandora(core, {endpoint: settings.endpoint, log: note, userAgent: await clientUserAgent(settings.endpoint)})
	const saved = await session.get(SESSION_KEYS)
	if saved.room and typeof saved.room === 'object' and /^[A-Za-z0-9_-]{16,64}$/.test(String(saved.room.id or ''))
		room = {id: String(saved.room.id), state: publicRoom(saved.room.state), audio: publicRoomAudio(saved.room.audio), changed: Number.isSafeInteger(saved.room.changed) ? saved.room.changed : 0}
	logLines = Array.isArray(saved.log) ? saved.log : []
	const manifest = browser.runtime.getManifest()
	note("boot melodica-extension {manifest.version_name or manifest.version} core {core.version} ({bytes.byteLength} bytes) endpoint {settings.endpoint} session-storage={browser.storage.session ? 'yes' : 'no (storage.local)'}")
	note("ua {navigator.userAgent}")
	try
		const perms = await browser.permissions.getAll()
		note("permissions {(perms.permissions or []).join(' ')}; origins {(perms.origins or []).join(' ') or '(none)'}")
	catch e
		note("permissions.getAll failed: {e and e.message or e}")
	note("restored session for {client.user.email}") if client.restore(saved.session)
	melodica = Object.assign({}, MELODICA_IDLE, saved.melodica) if saved.melodica and typeof saved.melodica === 'object'
	let meta = saved.meta and typeof saved.meta === 'object' ? saved.meta : null
	# A plaintext password left by versions before 0.6.0: seal it, then erase it.
	const old = (await browser.storage.local.get({password: ''})).password
	if old
		if settings.remember and settings.email and vaultAvailable()
			try
				await seal({credential: {email: settings.email, password: old}, session: null, meta: null})
				note('remember: the plaintext password was sealed')
			catch e
				note("remember: sealing failed ({e and e.message or e}); forgotten")
		await browser.storage.local.remove('password')
	# "Remember me": resume the sealed Pandora session (the browser was closed); the
	# sealed password is used only when Pandora answers 1001.
	if settings.remember
		const v = await unseal()
		if v
			if !client.loggedIn and v.session and client.restore(v.session)
				meta = v.meta or meta
				note("resumed the remembered session for {client.user.email}")
			client.credentials = v.credential if v.credential and v.credential.email and v.credential.password
			const sameUser = client.loggedIn and v.session and v.session.user and String(v.session.user.id) === String(client.user.id)
			const sameSid = !(meta and meta.sid and v.meta and v.meta.sid) or meta.sid === v.meta.sid
			if sameUser and sameSid and Array.isArray(v.stations)
				saved.stations = v.stations.filter(do(s) s and typeof s.token === 'string').slice(0, 500)
				await session.set({stations: saved.stations})
				note("restored {saved.stations.length} stations from the remembered session")
	sessionMeta = meta
	sessionMeta = {sid: newSid(), createdAt: Date.now()} if client.loggedIn and !(sessionMeta and sessionMeta.sid)
	client.onLogin = do sessionStarted()
	const sc = await browser.storage.local.get({scrobbling: null, scrobbleNoticeSeen: no})
	scrobble.on = sc.scrobbling if typeof sc.scrobbling === 'boolean'
	scrobble.noticeSeen = !!sc.scrobbleNoticeSeen
	if saved.player and typeof saved.player === 'object'
		player = Object.assign({}, PLAYER_IDLE, saved.player)
		# A worker restart mid-song in Chromium keeps the offscreen document and its
		# audio; it reports again on the next command. Anything else is at best paused.
		player.status = 'paused' if player.status === 'playing' and !browser.offscreen and !TAB_ENGINE
		# Chromium: "playing" with no offscreen document left means it was torn down.
		if player.status === 'playing' and browser.offscreen and browser.runtime.getContexts
			try
				player.status = 'paused' unless (await browser.runtime.getContexts({contextTypes: ['OFFSCREEN_DOCUMENT']})).length
			catch e
				null
	player.volume = Number(settings.volume) or player.volume
	player.quality = settings.quality
	# After a browser restart (or anything that emptied the session) the last song is
	# shown paused at its position; Resume plays it from there.
	lastPlay = await unsealAs('lastPlay')
	lastPlay = null unless lastPlay and lastPlay.track and lastPlay.station
	if lastPlay and !player.track
		player = Object.assign({}, player, {status: 'paused', station: lastPlay.station, track: lastPlay.track, position: Number(lastPlay.position) or 0, duration: Number(lastPlay.duration) or 0, error: '', changedAt: Date.now()})
		note("last song restored, paused at {Math.round(player.position)} s")
	{core, client, settings, saved}

# The User-Agent for the endpoint: the client's own when the extension holds a
# host permission for that origin (Pandora's, or an optional one the user
# granted), none (the browser's) when the endpoint is reached through CORS,
# where a custom User-Agent would fail the preflight. See pandora.imba USER_AGENT.
def clientUserAgent endpoint
	let origin = ''
	try
		origin = new URL(endpoint).origin
	catch e
		return null
	let granted = no
	try
		granted = await browser.permissions.contains({origins: ["{origin}/*"]})
	catch e
		granted = no
	note("endpoint {origin}: host permission {granted ? 'granted, requests carry the client User-Agent' : 'not granted, CORS request with the browser User-Agent'}")
	granted ? "melodica-extension/{browser.runtime.getManifest().version} (+https://github.com/Spaceghost/melodica-extension)" : null

def ensure
	unless booting
		booting = boot()
		booting.catch(do(e) booting = null)
	state = await booting
	unless accountBooted
		accountBooted = yes
		checkAccount(yes).catch(do(e) null)
	unless accessBooted
		accessBooted = yes
		const kept = (await browser.storage.local.get({access: null})).access
		access = Object.assign({}, access, kept) if kept and typeof kept === 'object'
		checkAccess(yes).catch(do(e) null)
	unless updateBooted
		updateBooted = yes
		checkUpdate(yes).catch(do(e) null)
	unless scrobbleBooted
		scrobbleBooted = yes
		# Listens that waited (offline, a server error) go out at once.
		if state.client.loggedIn
			scrobbleSettings(yes).catch(do(e) null).then(do flushListens()).catch(do(e) null)
	unless stationsBooted
		stationsBooted = yes
		restoreStations(state).catch(do(e) note("stations after restore failed: {(e and e.message) or e}"))
	state

# A session restored at boot (worker restart or "remember me" after a cold start)
# may come without its station list; load it so no client has to ask.
def restoreStations st
	return unless st.client.loggedIn and !(st.saved.stations and st.saved.stations.length)
	const stations = await st.client.stations()
	await remember('stations', stations)
	note("stations loaded after restore ({stations.length})")
	playerChanged(player)

# --- Updates ---------------------------------------------------------------

def updateState
	Object.assign({}, update, {banner: bannerState(update.current, update.latest, update.available), store: STORE_URL, canReload: !!(browser.runtime.reload)})

def checkUpdate force = no
	return await updateChecking if updateChecking
	return updateState() if !force and update.checkedAt and Date.now() - update.checkedAt < UPDATE_EVERY
	updateChecking = runUpdateCheck()
	try
		await updateChecking
	catch e
		note("update check failed: {e and e.message or e}")
	finally
		updateChecking = null
	updateState()

def runUpdateCheck
	const manifest = browser.runtime.getManifest()
	const url = feedUrl(manifest)
	update.feed = url
	update.checkedAt = Date.now()
	# Chromium: ask the browser to look at update_url now (no-op for an unpacked load).
	if browser.runtime.requestUpdateCheck
		try
			const r = await browser.runtime.requestUpdateCheck()
			const status = Array.isArray(r) ? r[0] : (r and r.status)
			const details = Array.isArray(r) ? r[1] : (r and r.details)
			note("requestUpdateCheck: {status}{details and details.version ? ' ' + details.version : ''}")
			update.available = details.version if status === 'update_available' and details and details.version
		catch e
			note("requestUpdateCheck failed: {e and e.message or e}")
	try
		const res = await fetch(url, {credentials: 'omit', cache: 'no-store'})
		throw new Error("HTTP {res.status}") unless res.ok
		update.latest = latestVersion(await res.json())
		update.error = ''
		note("update feed {url}: latest {update.latest or 'unknown'}, running {update.current}")
	catch e
		update.error = "could not read {url} ({e and e.message or e})"
		note("update feed: {update.error}")
	broadcast({type: 'update', update: updateState()})
	update

# Install an update the browser has fetched, unless something is playing; the
# engine's next "no track" report retries.
def maybeReload why
	return unless update.available
	if player.track and player.status !== 'stopped'
		note("update {update.available} fetched; reload deferred, playing")
		return no
	note("update {update.available} fetched; reloading ({why})")
	browser.runtime.reload()
	yes

if browser.runtime.onUpdateAvailable
	browser.runtime.onUpdateAvailable.addListener do(details)
		update.available = details and details.version or update.available or 'new'
		note("onUpdateAvailable {update.available}")
		broadcast({type: 'update', update: updateState()})
		maybeReload('onUpdateAvailable')

# --- The spacegho.st account (optional) ------------------------------------

def accountBase
	normalizeAccountBase((await browser.storage.local.get({accountBase: ''})).accountBase)

def accountView
	Object.assign({}, account)

def setAccount patch
	const joined = patch.signedIn === yes and !account.signedIn
	const changed = patch.signedIn !== undefined and !!patch.signedIn !== !!account.signedIn
	account = Object.assign({}, account, patch, {checkedAt: Date.now()})
	# Signing in with GitHub can rename the user (the GitHub login): ask again.
	refreshMe(no).catch(do(e) null) if joined and state and state.client.loggedIn
	sessionChanged() if changed and state
	broadcast({type: 'account', account: accountView()})
	playerChanged(player)
	account

def storedAccount
	(await browser.storage.local.get({account: null})).account

def form url, fields
	const res = await fetch(url, {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}, body: tokenForm(fields), credentials: 'omit', cache: 'no-store'})
	let body = null
	try
		body = await res.json()
	catch e
		body = null
	{status: res.status, body}

# Refresh tokens rotate: every refresh returns a new one and the old one stops working.
def refreshAccount tokens
	const base = await accountBase()
	const r = await form("{base}/oauth/token", {grant_type: 'refresh_token', refresh_token: tokens.refresh, client_id: tokens.clientId or CLIENT_ID})
	const next = r.status === 200 ? storedTokens(r.body) : null
	unless next
		if r.status === 400 or r.status === 401
			note("account: refresh refused ({r.body and r.body.error or r.status}); signed out")
			await browser.storage.local.remove('account')
			return null
		throw new Error("token refresh HTTP {r.status}")
	next.clientId = tokens.clientId or CLIENT_ID
	await browser.storage.local.set({account: next})
	note('account: tokens refreshed')
	next

def accountGet path, tokens
	const base = await accountBase()
	const res = await fetch("{base}{path}", {headers: {authorization: "Bearer {tokens.access}"}, credentials: 'omit', cache: 'no-store'})
	let body = null
	try
		body = await res.json()
	catch e
		body = null
	{status: res.status, body}

# Ask the policy for the stored account (refreshing first when the access token is
# stale, and once more on a 401). Any failure means the default policy.
def checkAccount force = no
	return await accountChecking if accountChecking
	return account if !force and account.checkedAt and Date.now() - account.checkedAt < ACCOUNT_MAX_AGE
	accountChecking = runAccountCheck()
	try
		await accountChecking
	catch e
		note("account check failed: {e and e.message or e}")
		setAccount({spots: POLICY_DEFAULT.spots, error: String(e and e.message or e)})
	finally
		accountChecking = null
	account

def runAccountCheck
	let tokens = await storedAccount()
	unless tokens and tokens.refresh
		return setAccount({signedIn: no, label: '', email: '', sub: '', spots: POLICY_DEFAULT.spots, error: ''})
	tokens = await refreshAccount(tokens) unless accessFresh(tokens)
	return setAccount({signedIn: no, label: '', email: '', sub: '', spots: POLICY_DEFAULT.spots, error: 'signed out by spacegho.st; sign in again'}) unless tokens
	let pol = await accountGet('/oauth/melodica/policy', tokens)
	if pol.status === 401
		tokens = await refreshAccount(tokens)
		return setAccount({signedIn: no, label: '', email: '', sub: '', spots: POLICY_DEFAULT.spots, error: 'signed out by spacegho.st; sign in again'}) unless tokens
		pol = await accountGet('/oauth/melodica/policy', tokens)
	const policy = policyFrom(pol.status, pol.body)
	let info = null
	try
		const ui = await accountGet('/oauth/userinfo', tokens)
		info = ui.status === 200 ? ui.body : null
	catch e
		info = null
	const claims = jwtClaims(tokens.access) or {}
	note("account: policy HTTP {pol.status}")
	setAccount({signedIn: yes, label: accountLabel(policy, info or jwtClaims(tokens.idToken)), email: info and info.email or '', sub: String(claims.sub or ''), spots: policy.spots, error: pol.status === 200 ? '' : "policy HTTP {pol.status}"})

# Step one of a sign-in: a PKCE verifier and state kept in session storage, and the
# authorize URL. `launchWebAuthFlow` (or a Safari tab, or a test) opens it.
def accountBegin tab = no
	const base = await accountBase()
	const verifier = randomString(32)
	const st = randomString(16)
	const clientId = tab ? TAB_CLIENT_ID : CLIENT_ID
	const redirectUri = tab ? TAB_REDIRECT : browser.identity.getRedirectURL('oauth')
	await session.set({accountPending: {verifier, state: st, clientId, redirectUri, base, at: Date.now()}})
	{url: authorizeUrl(base, {clientId, redirectUri, challenge: await pkceChallenge(verifier), state: st}), redirectUri}

# Step two: the redirect address that came back; exchange the code, then ask the policy.
def accountFinish url
	const got = (await session.get({accountPending: null})).accountPending
	throw new PandoraError('No spacegho.st sign-in is pending.', null, 0, 'account') unless got and Date.now() - got.at < SIGNIN_PENDING_FOR
	const back = parseRedirect(url, {state: got.state, issuer: got.base})
	throw new PandoraError("spacegho.st sign-in did not finish: {back.error}", null, 0, 'account') if back.error
	await session.set({accountPending: null})
	const r = await form("{got.base}/oauth/token", {grant_type: 'authorization_code', code: back.code, redirect_uri: got.redirectUri, client_id: got.clientId, code_verifier: got.verifier})
	const tokens = r.status === 200 ? storedTokens(r.body) : null
	throw new PandoraError("spacegho.st did not accept the sign-in ({r.body and r.body.error or 'HTTP ' + r.status}).", null, 0, 'account') unless tokens
	tokens.clientId = got.clientId
	await browser.storage.local.remove('accountSignoutPending')
	await browser.storage.local.set({account: tokens})
	note('account: signed in')
	await checkAccount(yes)

# "Sign in with spacegho.st": the browser's identity window (its own cookie jar on
# some browsers, so the sign-in page offers GitHub and email there), or a tab on Safari.
def accountSignin
	unless browser.identity and browser.identity.launchWebAuthFlow
		const t = await accountBegin(yes)
		note('account: sign-in tab')
		await browser.tabs.create({url: t.url})
		return account
	const started = await accountBegin(no)
	note('account: launchWebAuthFlow')
	let back
	try
		back = await browser.identity.launchWebAuthFlow({url: started.url, interactive: yes})
	catch e
		throw new PandoraError("spacegho.st sign-in did not finish: {e and e.message or e}", null, 0, 'account')
	await accountFinish(back)

# Safari: the content script on the web app page forwards the redirect address.
def accountCode msg, sender
	const from = String(sender and (sender.url or (sender.tab and sender.tab.url)) or '')
	throw new PandoraError('The sign-in did not come back to the web app page.', null, 0, 'account') unless from.startsWith(TAB_REDIRECT)
	await accountFinish(String(msg.url or from))

# ---- session sharing with the web app (melodica-web docs/BRIDGE.md, section 4)

const BRIDGE_ORIGIN = 'https://spacegho.st'
const BRIDGE_PATH = '/melodica/app/'
const REVOKED_MAX = 8

# Session messages come only from this extension's content script in the top frame
# of https://spacegho.st/melodica/app/ (exact origin).
def bridgeSender sender
	let ok = no
	try
		const u = new URL(String(sender and sender.url or ''))
		ok = sender.id === browser.runtime.id and sender.frameId === 0 and !!sender.tab and u.origin === BRIDGE_ORIGIN and u.pathname.startsWith(BRIDGE_PATH)
		ok = no if sender.origin and sender.origin !== BRIDGE_ORIGIN
	catch e
		ok = no
	throw new PandoraError('not allowed', null, 0, 'bridge') unless ok

# The tabs whose page asked for the session (they get the unsolicited pushes).
def sessionTabs add = null, keep = yes
	let list = (await session.get({sessionTabs: []})).sessionTabs or []
	if add !== null and keep and !list.includes(add)
		list = list.concat([add])
		await session.set({sessionTabs: list})
	list

def revokedSids
	const got = (await browser.storage.local.get({revokedSids: []})).revokedSids
	Array.isArray(got) ? got : []

def addRevoked sid
	return unless sid
	const list = (await revokedSids()).filter(do(x) x !== sid).concat([sid]).slice(-REVOKED_MAX)
	await browser.storage.local.set({revokedSids: list})

def sessionView
	const c = state.client
	const u = c.user
	const s = c.loggedIn and sessionMeta ? {sid: sessionMeta.sid, email: u.email, partner: {authToken: c.partner.authToken, id: c.partner.id}, user: {authToken: u.authToken, id: u.id}, syncOffset: Number(state.core.syncOffset) or 0, createdAt: sessionMeta.createdAt} : null
	const cred = c.loggedIn and state.settings.remember and c.credentials and c.credentials.email and c.credentials.password ? {email: c.credentials.email, password: c.credentials.password} : null
	const tokenNow = s and melodica.token and melodica.exp > Date.now() ? melodica.token : null
	{session: s, access: tokenNow, credential: cred, account: {signedIn: !!account.signedIn, username: (account.signedIn and melodica.username) or null, github: melodica.github or null}, revoked: await revokedSids()}

# Push the session to every page that asked for it (no page: nothing is sent).
def sessionChanged
	try
		const tabs = await sessionTabs()
		return unless tabs.length
		const message = {type: 'session-state', view: await sessionView()}
		for tabId in tabs
			browser.tabs.sendMessage(tabId, message).catch do(e)
				const left = (await sessionTabs()).filter(do(x) x !== tabId)
				await session.set({sessionTabs: left})
	catch e
		note("session push failed: {e and e.message or e}")

def validSession s
	s and typeof s === 'object' and typeof s.sid === 'string' and s.sid.length >= 16 and typeof s.email === 'string' and s.email and s.partner and typeof s.partner.authToken === 'string' and Number.isFinite(Number(s.partner.id)) and s.user and typeof s.user.authToken === 'string' and typeof s.user.id === 'string' and Number.isInteger(Number(s.syncOffset))

# The page offers its Pandora session (BRIDGE.md 4.3): taken only when the extension
# has none; checked with one call; a credential is used only on 1001.
def sessionOffer msg
	const s = msg.session
	return 'invalid' unless validSession(s)
	return 'revoked' if (await revokedSids()).includes(s.sid)
	const client = state.client
	if client.loggedIn
		sessionChanged()
		return 'kept'
	const email = s.email.trim()
	const allowed = await accessAsk(email)
	await setAccess(email, allowed)
	return 'invalid' unless allowed.allowed
	const cred = msg.credential and typeof msg.credential.email === 'string' and typeof msg.credential.password === 'string' and msg.credential.password ? {email: msg.credential.email.trim(), password: msg.credential.password} : null
	client.restore({partner: {authToken: s.partner.authToken, id: Number(s.partner.id)}, user: {authToken: s.user.authToken, id: s.user.id, email, subscriber: no}, syncOffset: Number(s.syncOffset)})
	sessionMeta = {sid: s.sid, createdAt: Number(s.createdAt) or Date.now()}
	client.credentials = cred
	let stations = null
	try
		# A live same-device engine already has this session and its playlist. The
		# normal offer still verifies sessions; this transfer avoids a duplicate
		# Pandora station-list request after the access service allowed the account.
		const playback = validatePlayback(msg.playback, s.sid, state.settings.endpoint)
		if playback and Array.isArray(msg.stations)
			stations = msg.stations.filter(do(x) x and typeof (x.id or x.token) === 'string').slice(0, 500).map(do(x) {token: x.token or x.id, name: String(x.name or ''), isQuickMix: !!x.isQuickMix, allowDelete: !!x.allowDelete})
		else
			stations = await client.stations()
	catch e
		note("session offer: refused ({e and e.message or e})")
		client.logout()
		client.credentials = null
		sessionMeta = null
		await persist()
		return 'invalid'
	const keep = !!cred and vaultAvailable()
	await browser.storage.local.set({email, remember: keep})
	Object.assign(state.settings, {email, remember: keep})
	await wipe() unless keep
	await persist()
	await remember('stations', stations)
	note('session offer: signed in from the web app')
	playerChanged(player)
	sessionChanged()
	melodicaLogin(email, yes).catch(do(e) note("login-ok failed: {e and e.message or e}"))
	'signed-in'

def sessionLogout sid
	return unless sid
	await addRevoked(sid)
	if sessionMeta and sessionMeta.sid === sid and state.client.loggedIn
		note('session: signed out from the web app')
		await forgetPandora('signed out on the web app')
	else
		sessionChanged()

# The page is signed in to spacegho.st and the extension is not: sign in without a
# prompt (prompt=none). login_required (no spacegho.st browser session) does nothing.
let silentTried = no
def silentAccountFor acct
	return unless acct and acct.signedIn === yes and !account.signedIn and !silentTried
	return unless browser.identity and browser.identity.launchWebAuthFlow
	silentTried = yes
	accountSilent().catch(do(e) note("account: silent sign-in did not finish ({e and e.message or e})"))

def accountSilent
	const base = await accountBase()
	const verifier = randomString(32)
	const st = randomString(16)
	const redirectUri = browser.identity.getRedirectURL('oauth')
	await session.set({accountPending: {verifier, state: st, clientId: CLIENT_ID, redirectUri, base, at: Date.now()}})
	const url = authorizeUrl(base, {clientId: CLIENT_ID, redirectUri, challenge: await pkceChallenge(verifier), state: st, prompt: 'none'})
	note('account: silent sign-in')
	const back = await browser.identity.launchWebAuthFlow({url, interactive: no})
	await accountFinish(back)

def accountSignout fromPage = no
	const was = !!account.signedIn
	const tokens = await storedAccount()
	if room.id
		try
			await restoreRoomSession() unless roomEngineReady
			await leaveRoom()
		catch e
			note("room leave during account signout failed: {e and e.message or e}")
	await browser.storage.local.remove('account')
	if tokens and tokens.refresh
		try
			await form("{await accountBase()}/oauth/revoke", {token: tokens.refresh, client_id: tokens.clientId or CLIENT_ID})
		catch e
			note("account: revoke failed: {e and e.message or e}")
	note('account: signed out')
	const out = setAccount({signedIn: no, label: '', email: '', sub: '', spots: POLICY_DEFAULT.spots, error: ''})
	await browser.storage.local.remove('recentRooms')
	# Signing out of spacegho.st here signs the web app out too (BRIDGE.md 4.4).
	if was and !fromPage
		# No page has asked yet: tell the next one, right after its first session-get.
		if (await sessionTabs()).length
			pushSessionTabs({type: 'session-account-signout'})
		else
			await browser.storage.local.set({accountSignoutPending: yes})
	out

def pushSessionTabs message
	for tabId in await sessionTabs()
		browser.tabs.sendMessage(tabId, message).catch(do(e) null)

# Playlist items for the engine, per the access answer and the account's policy.
def spotsOn
	!((access.allowed and access.spots === no) or (account.signedIn and account.spots === no))

def playable items
	(items or []).filter(do(x) x.kind !== 'spot' or spotsOn())

# --- melodica access ---------------------------------------------------------

def accessView
	{allowed: !!access.allowed, message: access.allowed ? '' : String(access.message or ''), checkedAt: access.checkedAt, error: String(access.error or '')}

# A fresh spacegho.st access token when signed in (sent as the bearer), else ''.
def accountBearer
	let tokens = await storedAccount()
	return '' unless tokens and tokens.refresh
	try
		tokens = await refreshAccount(tokens) unless accessFresh(tokens)
	catch e
		return ''
	tokens ? String(tokens.access or '') : ''

def accessAsk email
	const base = await accountBase()
	const headers = {'content-type': 'application/json'}
	const bearer = await accountBearer()
	headers.authorization = "Bearer {bearer}" if bearer
	let res = null
	let body = null
	try
		res = await fetch("{base}/oauth/melodica/access", {method: 'POST', headers, body: JSON.stringify({email, client: 'extension'}), credentials: 'omit', cache: 'no-store'})
	catch e
		note("access check: unreachable ({e and e.message or e})")
		throw new PandoraError(ACCESS_UNAVAILABLE, null, 0, 'access')
	try
		body = await res.json()
	catch e
		body = null
	const known = res.status === 200 and body and typeof body.allowed === 'boolean'
	note("access check: HTTP {res.status}{known ? (body.allowed ? ', allowed' : ', not allowed') : ''}")
	throw new PandoraError('Enter the email address of your Pandora account.', null, 0, 'access') if res.status === 400
	throw new PandoraError(ACCESS_UNAVAILABLE, null, 0, 'access') unless known
	{allowed: body.allowed, spots: spotsFlag(body), message: body.allowed ? '' : String(body.message or ACCESS_DENIED)}

def setAccess email, r
	access = {email, allowed: !!r.allowed, spots: r.spots === no ? no : yes, checkedAt: Date.now(), message: r.message or '', error: ''}
	await browser.storage.local.set({access: {email, allowed: access.allowed, spots: access.spots, checkedAt: access.checkedAt, message: access.message}})
	broadcast({type: 'access', access: accessView()})
	playerChanged(player)
	access

# Boot and hourly: ask again for the login email. No longer allowed: stop the
# music and sign out of Pandora; the login card shows the answer's message.
def checkAccess force = no
	return await accessChecking if accessChecking
	return access if !force and access.checkedAt and Date.now() - access.checkedAt < ACCESS_MAX_AGE
	accessChecking = runAccessCheck()
	try
		await accessChecking
	catch e
		# Unreachable: keep the last answer and ask again in a few minutes.
		access.error = String(e and e.message or e)
		access.checkedAt = Date.now() - ACCESS_MAX_AGE + ACCESS_RETRY
		note("access re-check failed: {access.error}")
	finally
		accessChecking = null
	access

def runAccessCheck
	const client = state and state.client
	return access unless client and client.loggedIn
	const email = (client.user and client.user.email) or access.email or state.settings.email or ''
	return access unless email
	const r = await accessAsk(email)
	await setAccess(email, r)
	await denyAccess() unless r.allowed
	access

def denyAccess
	note('access: not allowed; signing out of Pandora')
	await forgetPandora('melodica access withdrawn')

# ---- Spaceghost Scrobbles (spacegho.st/scrobble; melodica-web docs/BRIDGE.md: the side
# whose audio plays submits, so with the extension present only the extension does).
# On by default; the account's own setting (/scrobble/api/me/settings) can turn it off.
# playing_now at the start of a play; one single once it has played
# half its length or 4 minutes (tracks of 30 s or less never count). Singles that
# cannot be sent wait in storage.local (scrobbleQueue) and go out later.

const SCROBBLE_MAX_AGE = 60 * 60 * 1000
const SCROBBLE_RETRY = 60 * 1000
let scrobble = {on: null, checkedAt: 0, noticeSeen: null, play: null, lastFlush: 0, fail: null, waiting: 0, deployed: '', deployedAt: 0}
const SCROBBLE_OFF_RECHECK = 5 * 60 * 1000
const GENOME_WAIT = 4000

def scrobbleView
	const loggedIn = !!(state and state.client.loggedIn)
	{on: scrobble.on !== no, known: loggedIn and scrobble.checkedAt > 0, notice: loggedIn and scrobble.on !== no and scrobble.noticeSeen === no ? SCROBBLE_NOTICE : '', failing: loggedIn and scrobble.on !== no ? failureText(scrobble.fail, scrobble.waiting) : '', deployed: loggedIn and scrobble.deployed and Date.now() - scrobble.deployedAt < 10 * 60 * 1000 ? scrobble.deployed : '', leaderboard: LEADERBOARD_URL, history: MELODICA_PAGES.listens}

def noticeSeen
	if scrobble.noticeSeen === null
		scrobble.noticeSeen = !!(await browser.storage.local.get({scrobbleNoticeSeen: no})).scrobbleNoticeSeen
	scrobble.noticeSeen

# The account's scrobbling switch (GET), or set it (POST {scrobbling}).
def scrobbleSettings force = no, set = null
	return scrobble unless state and state.client.loggedIn
	return scrobble if set === null and !force and scrobble.checkedAt and Date.now() - scrobble.checkedAt < (scrobble.on === no ? SCROBBLE_OFF_RECHECK : SCROBBLE_MAX_AGE)
	const init = set === null ? {} : {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({scrobbling: !!set})}
	const r = await melodicaCall('/scrobble/api/me/settings', init)
	note("scrobbling settings: HTTP {r.status}")
	if r.status === 200 and r.body and typeof r.body.scrobbling === 'boolean'
		const was = scrobble.on
		scrobble.on = r.body.scrobbling
		scrobble.checkedAt = Date.now()
		flushListens().catch(do(e) null) if scrobble.on and was === no
		await browser.storage.local.set({scrobbling: scrobble.on})
		await browser.storage.local.set({scrobbleQueue: []}) unless scrobble.on
		playerChanged(player)
	elif set !== null
		throw new PandoraError(r.body and (r.body.message or r.body.error_description) or "Scrobbles answered HTTP {r.status}.", null, 0, 'scrobble')
	scrobble

def postListen body
	const r = await melodicaCall('/scrobble/api/me/listens', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)})
	const res = outcome(r.status, r.body)
	const error = r.body and typeof r.body.error === 'string' ? r.body.error.slice(0, 40) : ''
	note("scrobble {body.listen_type}: HTTP {r.status}{error ? ' ' + error : ''} -> {res}")
	failed(res === 'ok' or res === 'off' ? null : {status: r.status, error, at: Date.now()})
	if res === 'ok' and body.listen_type === 'single'
		const text = deploymentText(r.body and r.body.deployment)
		if text
			scrobble.deployed = text
			scrobble.deployedAt = Date.now()
			playerChanged(player)
	res

# The popup shows the last failure and the queue length until a submission goes.
def failed fail
	const before = scrobble.fail ? "{scrobble.fail.status} {scrobble.fail.error}" : ''
	scrobble.fail = fail
	const after = fail ? "{fail.status} {fail.error}" : ''
	playerChanged(player) if before !== after

def queueOf
	const q = (await browser.storage.local.get({scrobbleQueue: []})).scrobbleQueue
	scrobble.waiting = Array.isArray(q) ? q.length : 0
	Array.isArray(q) ? q : []

def saveQueue q
	scrobble.waiting = q.length
	await browser.storage.local.set({scrobbleQueue: q})

# One submission. A single that cannot go now waits in the queue; a playing_now that
# cannot go is dropped. Before the first-run notice was seen, singles wait too.
def submitListen body
	return unless scrobble.on !== no and state and state.client.loggedIn
	unless await noticeSeen()
		await saveQueue(enqueue(await queueOf(), body)) if body.listen_type === 'single'
		return
	let res = 'retry'
	try
		res = await postListen(body)
	catch e
		res = 'retry'
		failed({status: 0, error: '', at: Date.now()})
	if res === 'off'
		# The account's switch is off: nothing more is sent; what waits is kept for when
		# it is on again (checked every few minutes).
		scrobble.on = no
		scrobble.checkedAt = Date.now()
		await browser.storage.local.set({scrobbling: no})
		playerChanged(player)
	elif res === 'retry' or res === 'auth'
		await saveQueue(enqueue(await queueOf(), body)) if body.listen_type === 'single'
		playerChanged(player)
	elif res === 'ok'
		addRecent(body)
		flushListens().catch(do(e) null)

# Send what waits in the queue, oldest first; stop at the first one that cannot go.
let flushing = no
def flushListens
	return if flushing or scrobble.on === no or !(await noticeSeen())
	flushing = yes
	scrobble.lastFlush = Date.now()
	try
		let q = await queueOf()
		while q.length
			const res = await postListen(q[0])
			break if res === 'retry' or res === 'auth'
			if res === 'off'
				scrobble.on = no
				scrobble.checkedAt = Date.now()
				await browser.storage.local.set({scrobbling: no})
				break
			addRecent(q[0]) if res === 'ok'
			q = q.slice(1)
			await saveQueue(q)
		await saveQueue(q)
		playerChanged(player)
	catch e
		null
	finally
		flushing = no

# The user's recent listens (GET /scrobble/api/me/listens), for the popup and the
# player tab; a single this browser just sent is added at once.
let recent = {listens: [], at: 0, crew: no}
def recentView
	{listens: recent.listens, at: recent.at, crew: recent.crew, pages: MELODICA_PAGES}

def scrobbleRecent force = no
	return recentView() unless state and state.client.loggedIn
	return recentView() if !force and recent.at and Date.now() - recent.at < 30 * 1000
	# /scrobble/api/me carries the recent listens and crew_viewer (GitHub sign-in: the Map).
	const r = await melodicaCall('/scrobble/api/me')
	if r.status === 200 and r.body
		recent.listens = recentFrom({listens: r.body.recent})
		recent.crew = r.body.crew_viewer === true
		recent.at = Date.now()
	recentView()

def addRecent body
	return unless body and body.listen_type === 'single'
	const p = body.payload[0]
	recent.listens = prependListen(recent.listens, listenOf(p.track_metadata, p.listened_at))
	broadcast({type: 'scrobble-recent', recent: recentView()})

def extensionPage sender
	const own = browser.runtime.getURL('')
	!!(sender and sender.id === browser.runtime.id and typeof sender.url === 'string' and sender.url.startsWith(own))

# Genome traits per track (track.explainTrack, asked once per track; failures give
# none and are not asked again).
const genomeCache = new Map
def genomeFor t
	if t.genome !== undefined
		genomeCache.set(t.trackToken, t.genome)
		return t.genome
	return genomeCache.get(t.trackToken) if genomeCache.has(t.trackToken)
	let traits = null
	try
		# A hung explainTrack must not hold the listen back.
		traits = genomeTraits(await Promise.race([state.client.explain(t.trackToken), new Promise(do(ok) setTimeout((do ok(null)), GENOME_WAIT))]))
	catch e
		traits = null
	genomeCache.delete(genomeCache.keys().next().value) if genomeCache.size >= 200
	genomeCache.set(t.trackToken, traits)
	t.genome = traits
	note("genome: {traits ? traits.length : 0} traits")
	traits

# The client version and the station name go with every listen (Scrobbles docs/CLIENTS.md).
def listenExtra p
	{version: browser.runtime.getManifest().version, station: p and p.station and p.station.name or ''}

# Every player state: a new song starts a play (playing_now); the play's single goes
# once it has played long enough.
def scrobbleTick p
	return unless state and state.client.loggedIn
	if scrobble.on === no
		scrobbleSettings().catch(do(e) null)
		return
	const t = p and p.track
	return unless t and !isSpot(t) and t.trackToken
	if !scrobble.play or scrobble.play.key !== t.trackToken
		return unless p.status === 'playing'
		scrobble.play = {key: t.trackToken, startedAt: Math.floor(Date.now() / 1000) - Math.floor(Number(p.position) or 0), sent: no, played: 0, lastPosition: Number(p.position) or 0, lastStatus: p.status}
		const meta = trackMetadata(t, p.duration, null, listenExtra(p))
		scrobbleSettings().catch(do(e) null)
		submitListen(playingNow(meta)).catch(do(e) null) if meta
		genomeFor(t).catch(do(e) null) if meta
		flushListens().catch(do(e) null) if Date.now() - scrobble.lastFlush > SCROBBLE_RETRY
		return
	const position = Number(p.position) or 0
	const previousPosition = Number(scrobble.play.lastPosition) or 0
	if scrobble.play.lastStatus === 'playing' and position >= previousPosition
		scrobble.play.played = Math.min(Number(p.duration) or 86400, (Number(scrobble.play.played) or 0) + Math.min(10, position - previousPosition))
	scrobble.play.lastPosition = position
	scrobble.play.lastStatus = p.status
	flushListens().catch(do(e) null) if scrobble.waiting and Date.now() - scrobble.lastFlush > SCROBBLE_RETRY
	return if scrobble.play.sent
	return unless p.status === 'playing'
	const meta = trackMetadata(t, p.duration, null, listenExtra(p))
	const th = meta and thresholdSeconds((meta.additional_info.duration_ms or 0) / 1000)
	return unless th and Number(p.position) >= th
	scrobble.play.sent = yes
	const startedAt = scrobble.play.startedAt
	const extra = listenExtra(p)
	genomeFor(t).catch(do(e) null).then(do(traits)
		submitListen(single(trackMetadata(t, p.duration, traits, extra), startedAt))).catch(do(e) null)

# Conquest thumbs (Scrobbles docs/CLIENTS.md): every Pandora thumb of a song is also
# sent for crew viewers. Fire and forget; 403/404/429 and failures are ignored.
def gameThumb direction, t
	return unless t and !isSpot(t) and t.artist and recent.crew
	const body = {direction, artist_name: String(t.artist)}
	body.track_name = String(t.title) if t.title
	melodicaCall('/scrobble/api/game/thumb', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)}).then(do(r)
		note("thumb {direction}: HTTP {r.status}{r.body and typeof r.body.thumbs_left === 'number' ? ", {r.body.thumbs_left} left" : ''}")).catch(do(e) null)

# A Conquest terrain station: created on Pandora from its seeds (song first, else the
# artist); the first seed that resolves creates it, the rest are added as variety.
def seedToken seed
	const artist = String(seed and seed.artist_name or '').trim()
	const title = String(seed and seed.track_name or '').trim()
	return null unless artist
	const results = await state.client.search(title ? "{artist} {title}" : artist)
	const song = title and results.find(do(r) r.kind === 'song' and r.token)
	return song.token if song
	const a = results.find(do(r) r.kind === 'artist' and r.token)
	a ? a.token : null

def createTerrainStation st
	const seeds = (st and Array.isArray(st.seeds) ? st.seeds : []).slice(0, 10)
	throw new Error('This region has no seeds yet.') unless seeds.length
	let station = null
	for seed in seeds
		const token = await seedToken(seed).catch(do(e) null)
		continue unless token
		if !station
			station = await state.client.createStation(token)
		else
			await state.client.addMusic(station.token, token).catch(do(e) null)
	throw new Error('Pandora found none of the seeds.') unless station
	const name = String(st.name or '').trim().slice(0, 64)
	if name and station.name !== name
		await state.client.renameStation(station.token, name).then((do station.name = name), (do(e) null))
	const stations = await state.client.stations()
	await remember('stations', stations)
	playerChanged(player)
	station

# Play a seed from a spacegho.st/melodica/ page (the Conquest map's Play, docs/BRIDGE.md
# play-seed): a station of that artist or genre already in the list is reused, else
# Pandora's best match of that kind becomes a new station; then it plays.
def playSeed kind, name, sender
	throw new PandoraError('kind must be artist or genre.', null, 0, 'client') unless SEED_KINDS.includes(kind)
	throw new PandoraError('Leave the room before starting a private Pandora station.', null, 0, 'room') if room.id and !roomIsDj()
	const text = String(name or '').trim().slice(0, 128)
	throw new PandoraError('name is required.', null, 0, 'client') unless text
	throw new PandoraError('Not signed in.', null, 0, 'auth') unless state.client.loggedIn
	let stations = state.saved.stations or []
	let station = seedStation(stations, text)
	let created = no
	unless station
		const pick = seedPick(await state.client.search(text), kind, text)
		throw new PandoraError("Pandora found nothing for {text}.", null, 0, 'client') unless pick
		const made = await state.client.createStation(pick.token)
		stations = await state.client.stations()
		await remember('stations', stations)
		station = stations.find(do(s) s.token === made.token) or made
		created = yes
	note("play-seed {kind}: {created ? 'new station' : 'existing station'}")
	await playerCommand({action: 'play', station: {token: station.token, name: station.name or ''}}, sender)
	{station: {token: station.token, name: station.name or ''}, created, state: playerView()}

# A message from this extension's content script in a top-frame tab of
# https://spacegho.st/melodica/ (any page there, the map included).
def melodicaPageSender sender
	try
		const u = new URL(String(sender and sender.url or ''))
		return sender.id === browser.runtime.id and sender.frameId === 0 and !!sender.tab and u.origin === BRIDGE_ORIGIN and u.pathname.startsWith('/melodica/') and !(sender.origin and sender.origin !== BRIDGE_ORIGIN)
	catch e
		return no

# Chrome leaves an already-open tab without its content scripts when the user
# re-enables this extension. Reinstall the bridge when an eligible tab becomes
# active, and when its navigation completes. Existing static-script matches
# already grant the same origin; this adds no host access beyond those routes.
const bridgeInjectionTabs = new Set()

def approvedBridgeTab tab
	return no unless tab and typeof tab.url === 'string'
	try
		const u = new URL(tab.url)
		return u.origin === BRIDGE_ORIGIN and (u.pathname.startsWith('/melodica/') or u.pathname.startsWith('/listen/'))
	catch e
		return no

def injectBridgeIfMissing tabId, tab = null
	return unless browser.scripting and browser.scripting.executeScript and browser.tabs
	return if bridgeInjectionTabs.has(tabId)
	bridgeInjectionTabs.add(tabId)
	try
		tab = await browser.tabs.get(tabId) unless tab
		return unless approvedBridgeTab(tab)
		try
			const existing = await browser.tabs.sendMessage(tabId, {type: 'bridge-ping'})
			return if existing and existing.ok
		catch e
			# An invalidated content script has no receiver.
			null
		await browser.scripting.executeScript({target: {tabId}, files: ['content.js']})
		note("bridge reinjected into open tab {tabId}")
	catch e
		note("bridge reinjection skipped for tab {tabId}: {e and e.message or e}")
	finally
		bridgeInjectionTabs.delete(tabId)

def scanBridgeTabs
	return unless browser.scripting and browser.tabs
	try
		const tabs = await browser.tabs.query({url: ["{BRIDGE_ORIGIN}/melodica/*", "{BRIDGE_ORIGIN}/listen/*"]})
		for tab in tabs
			injectBridgeIfMissing(tab.id, tab)
	catch e
		note("bridge tab scan failed: {e and e.message or e}")

if browser.scripting and browser.tabs
	scanBridgeTabs()
	browser.tabs.onActivated.addListener do(info)
		injectBridgeIfMissing(info.tabId)
	browser.tabs.onUpdated.addListener do(tabId, change, tab)
		injectBridgeIfMissing(tabId, tab) if change and change.status === 'complete'

# ---- the melodica username (docs/ACCOUNT.md, Usernames)

const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{1,22}[a-z0-9]$/
const USERNAME_FORMAT = 'Use 3 to 24 letters, digits, - or _, starting and ending with a letter or digit.'

def userView
	{username: melodica.username, chosen: !!melodica.chosen, suggested: melodica.suggested, notice: melodica.notice, prompt: !!melodica.username and !melodica.chosen and !melodica.later}

def setMelodica patch
	melodica = Object.assign({}, melodica, patch)
	await session.set({melodica}).catch(do(e) null)
	playerChanged(player)

# POST /oauth/melodica/login-ok with the Pandora session just accepted; spacegho.st
# checks it with Pandora and returns the verified melodica token and the username.
def melodicaLogin email, prompt = no
	return await melodicaAsking if melodicaAsking
	melodicaAsking = runMelodicaLogin(email, prompt)
	try
		return await melodicaAsking
	finally
		melodicaAsking = null

def runMelodicaLogin email, prompt
	const client = state and state.client
	return no unless client and client.loggedIn and client.user and client.partner and email
	const base = await accountBase()
	const headers = {'content-type': 'application/json'}
	const bearer = await accountBearer()
	headers.authorization = "Bearer {bearer}" if bearer
	const body = {email, client: 'extension', pandora: {userAuthToken: client.user.authToken, userId: client.user.id, partnerId: String(client.partner.id), syncTimeOffset: Number(state.core.syncOffset) or 0}}
	const res = await fetch("{base}/oauth/melodica/login-ok", {method: 'POST', headers, body: JSON.stringify(body), credentials: 'omit', cache: 'no-store'})
	let out = null
	try
		out = await res.json()
	catch e
		out = null
	note("login-ok: HTTP {res.status}")
	return no unless res.status === 200 and out and typeof out.token === 'string' and out.token
	const patch = {token: out.token, exp: Date.now() + MELODICA_TOKEN_FOR}
	if typeof out.username === 'string' and out.username
		patch.username = out.username
		patch.chosen = out.username_chosen === yes
	patch.later = no if prompt
	await setMelodica(patch)
	sessionChanged()
	await refreshMe(no)
	scrobbleSettings(yes).catch(do(e) null)
	yes

# The bearer for /me and /username: the spacegho.st account's token when signed in,
# else the melodica token from login-ok (asked again once it is old).
def melodicaBearers
	const out = []
	const own = await accountBearer()
	out.push({kind: 'account', token: own}) if own
	if !(melodica.token and melodica.exp > Date.now()) and state and state.client.loggedIn
		const email = state.client.user and state.client.user.email or ''
		try
			await melodicaLogin(email) if email
		catch e
			null
	out.push({kind: 'melodica', token: melodica.token}) if melodica.token and melodica.exp > Date.now()
	out

def melodicaCall path, init = {}
	const base = await accountBase()
	for b in await melodicaBearers()
		let res = null
		try
			res = await fetch("{base}{path}", Object.assign({}, init, {headers: Object.assign({authorization: "Bearer {b.token}"}, init.headers or {}), credentials: 'omit', cache: 'no-store'}))
		catch e
			return {status: 0, body: null}
		let body = null
		try
			body = await res.json()
		catch e
			body = null
		body = null unless body and typeof body === 'object'
		const gone = (res.status === 401 and body and body.error === 'invalid_token') or (res.status === 404 and body and body.error === 'unknown_user')
		if gone and b.kind === 'melodica'
			await setMelodica({token: '', exp: 0})
		continue if gone and b.kind === 'account'
		return {status: res.status, body}
	{status: 401, body: {error: 'invalid_token'}}

def roomApiRoute raw, roomId
	return null unless typeof raw === 'string' and raw.length <= 512
	let u = null
	try
		u = new URL(raw, 'https://room.invalid/')
	catch e
		return null
	return null unless u.origin === 'https://room.invalid' and !u.hash
	const path = u.pathname.replace(/^\/+/, '')
	return {path, search: u.search} if path === 'rooms'
	const match = /^rooms\/([A-Za-z0-9_-]{16,64})(?:\/(signal|audio|events|ice|invite-link|sfu\/(?:publish\/start|publish\/offer|listen\/start|listen\/answer|close)))?$/.exec(path)
	return null unless match
	return null if roomId and roomId !== match[1]
	return {path, search: u.search}

def validRoomApiBody route, body
	return yes if body === undefined
	return no unless body and typeof body === 'object' and !Array.isArray(body)
	return no if JSON.stringify(body).length > 100000
	const suffix = route.path.split('/').slice(2).join('/')
	if route.path === 'rooms'
		return Object.keys(body).every(do(k) ['name', 'kind', 'mode', 'spots'].includes(k)) and typeof body.name === 'string' and body.name.length <= 80 and ['public', 'private'].includes(body.kind) and ['solo', 'rotation'].includes(body.mode) and Number.isInteger(body.spots) and body.spots >= 1 and body.spots <= 5
	if suffix === ''
		return validRoomCommand(body) ? yes : no
	if suffix === 'signal'
		return Object.keys(body).every(do(k) ['to', 'play_id', 'data'].includes(k)) and typeof body.to === 'string' and body.to.length <= 256 and typeof body.play_id === 'string' and body.play_id.length <= 128 and body.data and typeof body.data === 'object' and Object.keys(body.data).every(do(k) ['request', 'description', 'candidate'].includes(k))
	if suffix === 'audio'
		return Object.keys(body).every(do(k) ['type', 'play_id', 'stream_id', 'init', 'mime_type', 'offset_ms', 'data', 'request_id'].includes(k)) and body.type === 'media' and typeof body.play_id === 'string' and body.play_id.length <= 128 and typeof body.stream_id === 'string' and body.stream_id.length <= 128 and typeof body.mime_type === 'string' and body.mime_type.length <= 256 and Number.isFinite(body.offset_ms) and body.offset_ms >= 0 and typeof body.data === 'string' and body.data.length <= 60000
	if suffix.startsWith('sfu/')
		if suffix === 'sfu/publish/start' or suffix === 'sfu/listen/start'
			return Object.keys(body).length === 1 and typeof body.playId === 'string' and body.playId.length <= 128
		if suffix === 'sfu/publish/offer' or suffix === 'sfu/listen/answer'
			return Object.keys(body).every(do(k) ['playId', 'sessionId', 'mid', 'sessionDescription'].includes(k)) and typeof body.playId === 'string' and typeof body.sessionId === 'string' and (suffix === 'sfu/listen/answer' or typeof body.mid === 'string') and body.sessionDescription and ['offer', 'answer'].includes(body.sessionDescription.type) and typeof body.sessionDescription.sdp === 'string' and body.sessionDescription.sdp.length <= 80000
		if suffix === 'sfu/close'
			return Object.keys(body).every(do(k) ['sessionId', 'playId'].includes(k)) and typeof body.sessionId === 'string' and typeof body.playId === 'string'
		return no
	if suffix === 'invite-link'
		return Object.keys(body).length === 0
	no

def roomApi msg, sender, trustedLocalEngine = no
	const senderOffscreen = sender and sender.id === browser.runtime.id and sender.url === browser.runtime.getURL('offscreen.html')
	const senderTabEngine = TAB_ENGINE and sender and sender.id === browser.runtime.id and sender.url === PLAYER_URL
	const senderLocalEngine = trustedLocalEngine === yes and !browser.offscreen and !TAB_ENGINE and typeof document !== 'undefined'
	const senderPage = extensionPage(sender)
	const senderWebPage = melodicaPageSender(sender)
	const route = roomApiRoute(msg.path, msg.roomId)
	throw new PandoraError('not allowed', null, 0, 'room') unless route and (senderOffscreen or senderTabEngine or senderLocalEngine or senderPage or senderWebPage)
	const routeId = route.path.startsWith('rooms/') ? route.path.split('/')[1] : ''
	const suffix = route.path.split('/').slice(2).join('/')
	throw new PandoraError('not allowed', null, 0, 'room') if suffix and !senderOffscreen and !senderTabEngine and !senderLocalEngine and !(suffix === 'invite-link' and (senderPage or senderWebPage))
	const hasBody = msg.body !== undefined
	throw new PandoraError('not allowed', null, 0, 'room') if routeId and (room.id !== msg.roomId or room.id !== routeId)
	throw new PandoraError('not allowed', null, 0, 'room') unless validRoomApiBody(route, msg.body)
	let method = hasBody ? 'POST' : 'GET'
	if senderWebPage
		const webRead = method === 'GET' and (route.path === 'rooms' or (routeId and !suffix))
		const webCreate = method === 'POST' and route.path === 'rooms' and !route.search
		const webInvite = method === 'POST' and suffix === 'invite-link'
		throw new PandoraError('not allowed', null, 0, 'room') unless webRead or webCreate or webInvite
	throw new PandoraError('not allowed', null, 0, 'room') if routeId and hasBody and suffix === '' and !senderOffscreen and !senderTabEngine and !senderLocalEngine
	let path = '/scrobble/api/' + route.path + route.search
	if route.search
		const query = new URLSearchParams(route.search)
		const keys = Array.from(query.keys())
		const allowed = route.path === 'rooms' ? ['q', 'cursor', 'recent'] : (suffix === 'audio' ? ['play_id', 'after', 'since', 'wait'] : suffix === 'events' ? ['since', 'wait'] : [])
		const engineClient = senderOffscreen or senderTabEngine or senderLocalEngine
		allowed.push('clientId') if routeId and engineClient
		throw new PandoraError('not allowed', null, 0, 'room') unless allowed.length and keys.every(do(k) allowed.includes(k)) and new Set(keys).size === keys.length
		if query.has('clientId')
			throw new PandoraError('not allowed', null, 0, 'room') unless engineClient and /^[A-Za-z0-9_-]{16,64}$/.test(query.get('clientId')) and query.get('clientId') === await roomClientIdentity()
		if route.path === 'rooms'
			throw new PandoraError('not allowed', null, 0, 'room') if query.has('q') and query.get('q').length > 80
			throw new PandoraError('not allowed', null, 0, 'room') if query.has('cursor') and (query.get('cursor').length > 512 or /[\u0000-\u001f\u007f]/.test(query.get('cursor')))
			if query.has('recent')
				const ids = query.get('recent').split(',')
				throw new PandoraError('not allowed', null, 0, 'room') unless ids.length <= 12 and ids.every(do(id) /^[A-Za-z0-9_-]{16,64}$/.test(id))
		for key of ['after', 'since'] when query.has(key)
			const value = Number(query.get(key))
			throw new PandoraError('not allowed', null, 0, 'room') unless Number.isSafeInteger(value) and value >= -1
		if query.has('wait')
			const value = Number(query.get('wait'))
			throw new PandoraError('not allowed', null, 0, 'room') unless Number.isInteger(value) and value >= 0 and value <= 20000
		if query.has('play_id')
			const value = query.get('play_id')
			throw new PandoraError('not allowed', null, 0, 'room') unless value and value.length <= 128
	const result = await melodicaCall(path, hasBody ? {method, headers: {'content-type': 'application/json'}, body: JSON.stringify(msg.body)} : {method})
	const body = result.body or {}
	throw new PandoraError(String(body.message or body.error or 'Room request failed.'), String(body.error or 'room_error'), result.status, 'room') unless result.status >= 200 and result.status < 300
	{result: body, status: result.status}

def refreshMe prompt = no
	const r = await melodicaCall('/oauth/melodica/me')
	note("me: HTTP {r.status}")
	const b = r.body
	return no unless r.status === 200 and b and typeof b.username === 'string' and b.username
	const patch = {github: b.github and typeof b.github.login === 'string' ? b.github.login : '', username: b.username, chosen: b.username_chosen === yes, suggested: typeof b.suggested === 'string' ? b.suggested : '', notice: typeof b.notice === 'string' ? b.notice : ''}
	patch.later = no if prompt or patch.notice
	await setMelodica(patch)
	yes

def setUsername raw
	const name = raw.trim().toLowerCase()
	throw new PandoraError(USERNAME_FORMAT, null, 0, 'username') unless USERNAME_RE.test(name)
	const r = await melodicaCall('/oauth/melodica/username', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({username: name})})
	note("username: HTTP {r.status}")
	const b = r.body or {}
	if r.status === 200 and typeof b.username === 'string' and b.username
		await setMelodica({username: b.username, chosen: yes, notice: '', suggested: '', later: no})
		return userView()
	const text = typeof b.error_description === 'string' and b.error_description ? b.error_description : (r.status === 0 ? 'The username service is unavailable; try again.' : (r.status === 401 or r.status === 404 ? 'Your melodica session has ended; log in again.' : "The username was not saved (HTTP {r.status})."))
	throw new PandoraError(text, null, 0, 'username')

def persist
	const client = state.client
	await session.set({session: client.loggedIn ? client.snapshot() : null, meta: client.loggedIn ? sessionMeta : null})
	await sealRemembered()

# While "Remember me" is on, the session and login are sealed (vault.imba).
def sealRemembered
	return unless state.settings.remember and state.client.loggedIn
	const c = state.client.credentials
	try
		await seal({credential: (c and c.email and c.password ? {email: c.email, password: c.password} : null), session: state.client.snapshot(), meta: sessionMeta, stations: state.saved.stations or []})
	catch e
		note("remember: sealing failed ({e and e.message or e})")

def newSid
	const b = crypto.getRandomValues(new Uint8Array(18))
	btoa(String.fromCharCode(...b)).split('+').join('-').split('/').join('_')

# A new Pandora session (a sign-in, or the sign-in again after 1001).
def sessionStarted
	sessionMeta = {sid: newSid(), createdAt: Date.now()}
	persist().then((do sessionChanged()), (do(e) null))

# Sign out of Pandora everywhere: the session, the sealed login and its key; the sid
# goes on the revoked list (docs/BRIDGE.md 4.4).
def forgetPandora why
	const sid = sessionMeta and sessionMeta.sid
	if room.id
		try
			await restoreRoomSession() unless roomEngineReady
			await leaveRoom()
		catch e
			note("room leave during Pandora signout failed: {e and e.message or e}")
	await stopPlayback(why)
	state.client.logout()
	state.client.credentials = null
	sessionMeta = null
	await setMelodica(MELODICA_IDLE)
	await wipe()
	await forgetLastPlay()
	await browser.storage.local.set({remember: no})
	state.settings.remember = no
	await addRevoked(sid) if sid
	await persist()
	await remember('stations', [])
	playerChanged(player)
	sessionChanged()

def remember key, value
	state.saved[key] = value
	const patch = {}
	patch[key] = value
	await session.set(patch)
	await sealRemembered() if key === 'stations'

# Fan a notice out to every extension page that is open (none may be).
def broadcast message
	try
		await browser.runtime.sendMessage(message)
	catch e
		null

# A page (the bridge's `openLogin`) asks for the sign-in: the toolbar popup where
# the browser allows opening it, else the popup page in a tab.
def openLogin
	if browser.action and browser.action.openPopup
		try
			await browser.action.openPopup()
			note('login: opened the popup')
			return 'popup'
		catch e
			note("login: openPopup refused ({e and e.message or e}); opening a tab")
	await browser.tabs.create({url: browser.runtime.getURL('popup.html')})
	'tab'

# The player tab is optional: a full-size view of the same state. Opening it
# starts nothing; closing it stops nothing.
# listen:// links (docs/LISTEN-URI.md) open in the player tab: from a
# spacegho.st/listen/ page (that tab), the omnibox keyword `listen`, or Firefox's
# web+listen handler (the manifest points it at the player tab directly).
def listenTab uri, tabId = null
	const link = parseListenUri(String(uri or ''))
	return no unless link
	const url = "{PLAYER_URL}?listen={encodeURIComponent(link.uri)}"
	if tabId !== null
		await browser.tabs.update(tabId, {url})
	else
		await browser.tabs.create({url})
	yes

# Omnibox: "listen artist/Modest Mouse", a whole link, or just an artist's name.
def omniboxLink text
	const t = String(text or '').trim()
	return t if /^(listen|web\+listen):\/\//i.test(t) or t.toLowerCase().startsWith('https://spacegho.st/listen/')
	const path = t.split('/').map(do(p, i) i === 0 ? p : encodeURIComponent(p.trim())).join('/')
	return "listen://{path}" if parseListenUri("listen://{path}")
	"listen://artist/{encodeURIComponent(t)}"

if browser.omnibox and browser.omnibox.onInputEntered
	browser.omnibox.setDefaultSuggestion({description: 'Open a listen link in melodica (artist/<name>, genre/<name>, or a name)'}) if browser.omnibox.setDefaultSuggestion
	browser.omnibox.onInputEntered.addListener do(text, disposition)
		const tabs = disposition === 'currentTab' ? await browser.tabs.query({active: yes, currentWindow: yes}) : []
		listenTab(omniboxLink(text), tabs[0] ? tabs[0].id : null).catch(do(e) note("listen link failed: {(e and e.message) or e}"))

def openPlayer
	const tabs = await browser.tabs.query({url: PLAYER_URL + '*'})
	const tab = tabs[0]
	if tab
		await browser.tabs.update(tab.id, {active: yes})
		try
			await browser.windows.update(tab.windowId, {focused: yes})
		catch e
			null
		return {tabId: tab.id}
	const created = await browser.tabs.create({url: PLAYER_URL})
	{tabId: created.id}

# --- Playback -----------------------------------------------------------

# What every view gets: the engine's state plus the session bits a view needs.
def roomTrackMetadata t
	return null unless t and typeof t === 'object'
	const out = {}
	for key of ['track_name', 'artist_name', 'release_name'] when typeof t[key] === 'string'
		out[key] = t[key].slice(0, 512)
	const info = t.additional_info
	if info and typeof info === 'object'
		const extra = {}
		if Number.isSafeInteger(info.duration_ms) and info.duration_ms >= 1000 and info.duration_ms <= 3600000
			extra.duration_ms = info.duration_ms
		if typeof info.art_url === 'string' and /^https:\/\//i.test(info.art_url)
			extra.art_url = info.art_url.slice(0, 4096)
		out.additional_info = extra if Object.keys(extra).length
	out

def publicRoom snapshot
	return null unless snapshot and typeof snapshot === 'object'
	const out = {}
	for key of ['id', 'name', 'kind', 'mode', 'host', 'you', 'current_dj'] when typeof snapshot[key] === 'string'
		out[key] = snapshot[key].slice(0, 512)
	for key of ['created_at', 'closed_at', 'ready_at', 'server_time'] when typeof snapshot[key] === 'string' or Number.isFinite(snapshot[key])
		out[key] = snapshot[key]
	for key of ['seq', 'spots', 'skip_threshold'] when Number.isSafeInteger(snapshot[key])
		out[key] = Math.max(0, Math.min(1000000, snapshot[key]))
	out.skip_fraction = Number(snapshot.skip_fraction) if Number.isFinite(Number(snapshot.skip_fraction)) and Number(snapshot.skip_fraction) >= 0 and Number(snapshot.skip_fraction) <= 1
	out.scrobble = snapshot.scrobble === yes if typeof snapshot.scrobble === 'boolean'
	out.you_broadcasting = snapshot.you_broadcasting if typeof snapshot.you_broadcasting === 'boolean'
	out.members = (Array.isArray(snapshot.members) ? snapshot.members : []).slice(0, 100).map(publicRoomMember)
	out.djs = (Array.isArray(snapshot.djs) ? snapshot.djs : []).filter(do(v) typeof v === 'string').slice(0, 20)
	out.waiting = (Array.isArray(snapshot.waiting) ? snapshot.waiting : []).filter(do(v) typeof v === 'string').slice(0, 100)
	out.requests = (Array.isArray(snapshot.requests) ? snapshot.requests : []).slice(0, 100).map(do(r)
		const votes = {}
		for [key, value] of Object.entries(r.votes or {}) when typeof value === 'boolean'
			votes[key] = value
		{account: String(r.account or '').slice(0, 256), votes}
	)
	if snapshot.play and typeof snapshot.play === 'object'
		const play = {}
		for key of ['id', 'dj', 'reaction'] when typeof snapshot.play[key] === 'string'
			play[key] = snapshot.play[key].slice(0, 512)
		for key of ['paused_at', 'started_at', 'ended_at', 'server_time'] when typeof snapshot.play[key] === 'string' or Number.isFinite(snapshot.play[key])
			play[key] = snapshot.play[key]
		for key of ['likes', 'dislikes', 'skip_threshold', 'duration_ms', 'paused_ms', 'position_ms'] when Number.isSafeInteger(snapshot.play[key])
			play[key] = Math.max(0, Math.min(86400000, snapshot.play[key]))
		play.track_metadata = roomTrackMetadata(snapshot.play.track_metadata)
		out.play = play
	if Array.isArray(snapshot.past)
		out.past = snapshot.past.slice(0, 20).map(do(p)
			{id: String(p.id or '').slice(0, 128), track_metadata: roomTrackMetadata(p.track_metadata), scrobbled: !!p.scrobbled, pending: !!p.pending}
		)
	out

def publicRoomAudio value
	return {state: 'idle'} unless value and typeof value === 'object'
	const out = {}
	for key of ['state', 'message', 'play_id', 'transport'] when typeof value[key] === 'string'
		out[key] = value[key].slice(0, 256)
	for key of ['listened_ms', 'paused', 'volume', 'monitoring'] when typeof value[key] === 'number' or typeof value[key] === 'boolean'
		out[key] = value[key]
	out

def roomIsDj
	const mine = room.state and room.state.you
	return no unless room.id and mine and room.state.you_broadcasting !== no
	const dj = room.state.play ? room.state.play.dj : room.state.current_dj
	dj === mine

def roomBroadcastActive
	const mine = room.state and room.state.you
	!!(room.id and mine and room.state.play and room.state.play.dj === mine and room.state.you_broadcasting !== no)

def roomView
	{id: room.id, state: room.state, audio: room.audio, role: room.id ? (roomIsDj() ? 'dj' : 'listener') : null, locked: roomBroadcastActive()}

def applyRoomClock msg
	const positionMs = msg and msg.positionMs
	const serverTime = msg and msg.serverTime
	const playId = String(msg and msg.playId or '')
	return {applied: no} unless room.id and msg.roomId === room.id and room.state and room.state.play and room.state.play.id === playId
	return {applied: no} unless Number.isSafeInteger(positionMs) and positionMs >= 0 and positionMs <= 3600000 and Number.isSafeInteger(serverTime) and serverTime > 0
	return {applied: no} if Number.isSafeInteger(room.state.play.server_time) and serverTime <= room.state.play.server_time
	room.state.play.position_ms = positionMs
	room.state.play.server_time = serverTime
	persistRoom()
	const update = {type: 'room-clock', room: roomView(), state: playerView()}
	broadcast(update)
	pushRoomClock(update)
	{applied: yes}

def pushRoomClock message
	const set = await subscriberSet()
	for tabId in Array.from(set)
		browser.tabs.sendMessage(tabId, message).catch(do(e) null)

def persistRoom
	const saved = room.id ? {id: room.id, state: room.state, audio: room.audio, changed: room.changed} : null
	session.set({room: saved}).catch(do(e) null)

def rememberRoom snapshot
	return unless snapshot and typeof snapshot.id === 'string' and /^[A-Za-z0-9_-]{16,64}$/.test(snapshot.id) and account.sub
	const saved = await browser.storage.local.get({recentRooms: null})
	const previous = saved.recentRooms and saved.recentRooms.sub === account.sub and Array.isArray(saved.recentRooms.ids) ? saved.recentRooms.ids : []
	const ids = [snapshot.id].concat(previous.filter(do(id) id !== snapshot.id and /^[A-Za-z0-9_-]{16,64}$/.test(String(id or '')))).slice(0, 12)
	await browser.storage.local.set({recentRooms: {sub: account.sub, ids}})

def recentRoomsView
	return [] unless account.sub
	const saved = (await browser.storage.local.get({recentRooms: null})).recentRooms
	saved and saved.sub === account.sub and Array.isArray(saved.ids) ? saved.ids.filter(do(id) /^[A-Za-z0-9_-]{16,64}$/.test(String(id or ''))).slice(0, 12) : []

let roomClientReady = null
def roomClientIdentity
	if !roomClientReady
		const open = do()
			const saved = (await browser.storage.local.get({roomDeviceId: null})).roomDeviceId
			return saved if typeof saved === 'string' and /^[A-Za-z0-9_-]{16,64}$/.test(saved)
			const generated = newSid()
			await browser.storage.local.set({roomDeviceId: generated})
			generated
		roomClientReady = open()
	await roomClientReady

def restoreRoomSession
	return roomView() unless room.id
	return roomView() if roomEngineReady
	return await roomRestore if roomRestore
	const restore = do()
		const roomId = room.id
		await checkAccount(yes)
		unless account.signedIn
			note('room restore skipped: spacegho.st account is signed out')
			roomEngineReady = no
			return roomView()
		const before = room.changed
		const result = await engineCall('room-join', [{id: roomId, clientId: await roomClientIdentity(), sequence: room.changed, base: await accountBase(), scrobbling: scrobble.on !== no, sfuConfigured: yes, paused: !!(room.audio and room.audio.paused)}])
		if room.id === roomId
			roomEngineReady = yes
			if room.changed === before
				room.state = publicRoom(result and result.state)
				room.audio = publicRoomAudio(result and result.audio)
				persistRoom()
		playerChanged(player)
		roomView()
	roomRestore = restore()
	try
		return await roomRestore
	finally
		roomRestore = null

def playerView
	const view = Object.assign({}, player, {last: lastView(), stations: state and state.saved.stations or [], loggedIn: !!(state and state.client.loggedIn), account: {signedIn: account.signedIn, label: account.label}, user: userView(), scrobbling: scrobbleView(), access: {allowed: !!access.allowed, message: access.allowed ? '' : String(access.message or '')}, room: roomView()})
	view.volume = room.audio.volume if room.id and room.audio and Number.isFinite(room.audio.volume)
	if room.id and room.state and (room.state.play or !roomIsDj())
		const play = room.state and room.state.play
		const meta = play and play.track_metadata
		const durationMs = Number(meta and meta.additional_info and meta.additional_info.duration_ms) or Number(play and play.duration_ms) or 0
		let position = (Number(play and play.position_ms) or 0) / 1000
		if play and Number(play.server_time) > 0 and !play.paused_at
			position += Math.max(0, (Date.now() - Number(play.server_time)) / 1000)
		const paused = !!(play and play.paused_at) or !!(room.audio and room.audio.paused)
		const audible = ['listening', 'broadcasting'].includes(String(room.audio and room.audio.state or '')) and !paused
		const track = meta ? {title: meta.track_name or '', artist: meta.artist_name or '', album: meta.release_name or '', coverArt: meta.additional_info and meta.additional_info.art_url or '', duration: durationMs / 1000, kind: 'room'} : null
		Object.assign(view, {status: audible ? 'playing' : (paused ? 'paused' : (room.audio and room.audio.state === 'connecting' ? 'loading' : 'idle')), station: {name: "Room · {room.state and room.state.name or 'Listening room'}", token: ''}, track, position: Math.max(0, Math.min(durationMs / 1000, position)), duration: durationMs / 1000, volume: room.audio and Number.isFinite(room.audio.volume) ? room.audio.volume : player.volume, queueLength: 0, queue: [], error: room.audio and room.audio.message or '', last: null, stations: roomIsDj() ? (state and state.saved.stations or []) : [], pendingStation: roomIsDj() ? player.pendingStation : null})
	view

# Save the engine's "last playing" record (at most every 2 s; pause, stop and
# teardown come through at once).
def saveLastPlay r, urgent = no
	return unless r and r.track and r.station
	lastPlay = r
	return unless urgent or Date.now() - lastSealedAt >= 1500
	lastSealedAt = Date.now()
	sealAs('lastPlay', r).catch(do(e) note("last song not saved: {e and e.message or e}"))

def forgetLastPlay
	playbackCopy.clear()
	lastPlay = null
	await wipeAs('lastPlay')
	await dropAudioCopies()

# `last` in the player state (the bridge and the views): what Resume would play.
def lastView
	return null unless lastPlay and lastPlay.track
	const t = lastPlay.track
	{title: t.title, artist: t.artist, album: t.album, coverArt: t.coverArt, trackToken: t.trackToken, station: lastPlay.station, position: Number(lastPlay.position) or 0, duration: Number(lastPlay.duration) or 0, savedAt: lastPlay.savedAt}

def publicTrack song
	return null unless song
	const t = Object.assign({}, song)
	delete t.audioUrl
	t

# The engine reported: keep it, persist it, show it on the badge, tell the views.
def playerChanged next
	# The engine's states reach the background two ways (its reports and command
	# replies) and may arrive out of order: an older one never replaces a newer one.
	return if next and next !== player and next.changedAt and player.changedAt and next.changedAt < player.changedAt
	player = Object.assign({}, PLAYER_IDLE, next)
	session.set({player}).catch(do(e) null)
	badge()
	scrobbleTick(player)
	const message = {type: 'player-state', state: playerView()}
	broadcast(message)
	pushSubscribers(message)

def subscriberSet
	return subscribers if subscribers
	let saved = []
	try
		saved = (await browser.storage.session.get('subscribers')).subscribers or []
	catch e
		saved = []
	subscribers ||= new Set(saved)
	subscribers

def saveSubscribers
	try
		await browser.storage.session.set({subscribers: Array.from(subscribers)})
	catch e
		null

def subscribeTab tabId, on
	return unless typeof tabId === 'number'
	const set = await subscriberSet()
	if on
		set.add(tabId)
	else
		set.delete(tabId)
	await saveSubscribers()

let lastPushedStatus = ''
def pushSubscribers message
	const set = await subscriberSet()
	const st = message and message.state
	if st and st.status !== lastPushedStatus
		lastPushedStatus = st.status
		note("push {st.status} (changedAt {st.changedAt}) to {set.size} tab(s)")
	for tabId in Array.from(set)
		browser.tabs.sendMessage(tabId, message).catch do(e)
			# Only a tab that is gone (or has no content script) stops being a subscriber.
			const m = String(e and e.message or e)
			if /receiving end does not exist|no tab with id|could not establish connection|invalid tab/i.test(m)
				set.delete(tabId)
				saveSubscribers()
			else
				note("push to tab {tabId} failed: {m}")

def badge
	try
		const t = player.track
		if t and (player.status === 'playing' or player.status === 'loading')
			await browser.action.setBadgeText({text: '▶'})
			await browser.action.setBadgeBackgroundColor({color: '#d8b26a'})
			await browser.action.setTitle({title: "melodica: {t.title} – {t.artist}{player.station ? ' on ' + player.station.name : ''}"})
		elif t and player.status === 'paused'
			await browser.action.setBadgeText({text: '❚❚'})
			await browser.action.setTitle({title: "melodica (paused): {t.title} – {t.artist}"})
		else
			await browser.action.setBadgeText({text: ''})
			await browser.action.setTitle({title: 'melodica'})
	catch e
		null

def engineRoomControl action
	return no unless room.id
	try
		await restoreRoomSession() unless roomEngineReady
		if action === 'ended'
			await engineCall('room-end') if roomIsDj()
			return yes
		const mapped = action === 'play' ? 'resume' : (action === 'next' ? 'skip' : (action === 'toggle' ? (room.audio and room.audio.paused ? 'resume' : 'pause') : action))
		return yes unless ['pause', 'resume', 'skip'].includes(mapped)
		const result = await engineCall('room-audio', [room.id, mapped])
		if result and result.state
			room.state = publicRoom(result.state)
			room.audio = publicRoomAudio(result.audio)
			persistRoom()
			playerChanged(player)
		yes
	catch e
		note("room control {action} failed: {e and e.message or e}")
		# An error must never fall through to the private Pandora engine while a
		# room owns playback.
		yes

# The engine in this document (Firefox: the background page has a DOM).
def localEngine
	return engine if engine
	engine = new Engine({
		document: document
		roomControl: do(action) engineRoomControl(action)
		api: {
			playlist: do(station, quality)
				await ensure()
				const songs = await state.client.playlist(stationByToken(station.token) or station, quality)
				await persist()
				playable(songs)
			rate: do(trackToken, positive) state.client.rate(trackToken, positive)
			tired: do(trackToken) state.client.tired(trackToken)
			spotMetadata: do(placeholder, quality) spotsOn() ? state.client.spotMetadata(placeholder, quality) : null
			registerSpot: do(s) state.client.registerSpot(s.stationId, s.trackingTokens or [])
		}
		report: do(s) playerChanged(s)
		remember: do(r, urgent) saveLastPlay(r, urgent)
		log: note
	})
	engine.hydrate(Object.assign({}, player, {last: lastPlay}))
	localRoomEngine = new RoomEngine({
		engine
		send: localRoomSend
		loadMedia: do import(browser.runtime.getURL('room-media.js'))
	})
	engine

# Firefox's persistent background page owns both the Pandora Engine and RoomEngine.
# This closed adapter avoids routing trusted engine work through a page-supplied sender.
def localRoomSend msg
	switch msg and msg.type
		when 'room-token'
			const token = await accountBearer()
			throw new PandoraError('Sign in to spacegho.st before joining a room.', null, 0, 'auth') unless token
			return {token: token}
		when 'room-api'
			return await roomApi(msg, null, yes)
		when 'room-state'
			throw new PandoraError('not allowed', null, 0, 'room') unless msg.roomId and localRoomEngine and localRoomEngine.id === room.id and msg.roomId === room.id
			if Number.isSafeInteger(msg.changed) and msg.changed > room.changed
				room.changed = msg.changed
				room.state = publicRoom(msg.room)
				room.audio = publicRoomAudio(msg.audio)
				roomEngineReady = yes
				persistRoom()
				playerChanged(player)
			return {ok: yes}
		when 'room-clock'
			return applyRoomClock(msg)
		else
			throw new PandoraError('not allowed', null, 0, 'room')

# Chromium: the offscreen document, created on demand. Chrome closes an idle
# AUDIO_PLAYBACK document after a while; the next command recreates it and
# `engine-hello` brings it the saved state.
def ensureOffscreen
	await offscreenClosing if offscreenClosing
	return await offscreenReady if offscreenReady
	offscreenReady = TAB_ENGINE ? ensurePlayerEngine() : createOffscreen()
	try
		await offscreenReady
	finally
		offscreenReady = null

# WEB_RTC keeps an offscreen document alive while its room transport is idle
# between audio packets. Close it explicitly when neither a room nor private
# playback needs the engine; the next playback/room operation recreates it.
def closeIdleOffscreen
	return if TAB_ENGINE or !browser.offscreen or room.id or ['playing', 'loading'].includes(String(player.status or ''))
	await offscreenReady if offscreenReady
	return if room.id or ['playing', 'loading'].includes(String(player.status or ''))
	return await offscreenClosing if offscreenClosing
	offscreenClosing = browser.offscreen.closeDocument().catch(do(e) null)
	try
		await offscreenClosing
	finally
		offscreenClosing = null

# Safari: the player tab is the engine; open it (in the background) when it is not
# there and wait for its `engine-hello`.
def ensurePlayerEngine
	const tabs = await browser.tabs.query({url: PLAYER_URL + '*'})
	return if tabs.length
	note('opening the player tab (the playback engine on Safari)')
	const hello = new Promise do(resolve, reject)
		engineWaiters.push(resolve)
		setTimeout((do reject(new PandoraError('The player tab did not start.', null, 0, 'player'))), 20000)
	await browser.tabs.create({url: PLAYER_URL, active: no})
	await hello

def createOffscreen
	let exists = no
	try
		const contexts = await browser.runtime.getContexts({contextTypes: ['OFFSCREEN_DOCUMENT']})
		exists = contexts.length > 0
	catch e
		exists = no
	return if exists
	note('creating the offscreen playback document')
	try
		await browser.offscreen.createDocument({url: 'offscreen.html', reasons: ['AUDIO_PLAYBACK', 'WEB_RTC'], justification: 'Pandora playback and room WebRTC audio without a visible tab'})
	catch e
		# "Only a single offscreen document may be created": a race with another creator.
		throw e unless /single offscreen/i.test(String(e and e.message or e))

# Run one engine operation wherever the engine lives and return its state.
def engineCall op, args = []
	if typeof document !== 'undefined' and !browser.offscreen and !TAB_ENGINE
		const e = localEngine()
		switch op
			when 'export-playback' then return e.exportPlayback()
			when 'import-playback' then await e.importPlayback(args[0])
			when 'expire-link' then e.expireAudioLink(args[0])
			when 'play' then await e.play(args[0])
			when 'resume' then await e.resume()
			when 'pause' then e.pause()
			when 'toggle' then await e.toggle()
			when 'next' then await e.skip()
			when 'stop' then e.stop()
			when 'rate' then await e.rate(!!args[0])
			when 'tired' then await e.tired()
			when 'volume' then e.setVolume(args[0])
			when 'quality' then e.setQuality(args[0])
			when 'hydrate' then e.hydrate(args[0])
			when 'room-join' then return await localRoomEngine.join(args[0].id, args[0])
			when 'room-leave' then await localRoomEngine.leave(args[0] or {})
			when 'room-command' then return await localRoomEngine.command(args[1])
			when 'room-audio' then return await localRoomEngine.audioCommand(args[1], args[2])
			when 'room-select-station' then return await localRoomEngine.selectStation(args[0])
			when 'room-end' then return await localRoomEngine.endTurn()
			when 'room-scrobbling' then localRoomEngine.setScrobbling(args[0] !== no)
			when 'state' then null
			else throw new Error("unknown engine op {op}")
		return e.snapshot
	await ensureOffscreen()
	const r = await browser.runtime.sendMessage({type: 'engine', op, args})
	throw new PandoraError('The playback document did not answer.', null, 0, 'player') unless r
	throw new PandoraError(r.error or 'playback error', null, 0, 'player') unless r.ok
	playerChanged(r.state) if r.state
	if op.startsWith('room-') then r.result else (op === 'export-playback' ? r.playback : r.state)

def exportPlayback
	let p = null
	if player.track
		p = await engineCall('export-playback')
	elif lastPlay and lastPlay.track and lastPlay.station
		p = {v: 1, at: Date.now(), station: {id: lastPlay.station.token, name: lastPlay.station.name}, song: lastPlay.track, queue: lastPlay.queue or [], position: lastPlay.position, duration: lastPlay.duration, quality: lastPlay.quality, volume: player.volume, status: 'paused', played: yes}
	return null unless p and sessionMeta and state.client.loggedIn
	if p.song and p.song.genome === undefined and genomeCache.has(p.song.trackToken)
		p.song = Object.assign({}, p.song, {genome: genomeCache.get(p.song.trackToken)})
	if p.song and scrobble.play and scrobble.play.key === p.song.trackToken
		p.song = Object.assign({}, p.song, {melodicaPlay: {sid: sessionMeta.sid, trackToken: p.song.trackToken, startedAt: scrobble.play.startedAt, sent: !!scrobble.play.sent, played: Number(scrobble.play.played) or 0}})
	Object.assign({}, p, {sid: sessionMeta.sid})

def importPlayback p
	throw new PandoraError('Not signed in.', null, 0, 'auth') unless state.client.loggedIn and sessionMeta
	const valid = validatePlayback(p, sessionMeta.sid, state.settings.endpoint)
	throw new PandoraError('Invalid or stale playback transfer.', null, 0, 'client') unless valid
	# The established engine wins; another page cannot replace its song.
	return {kept: yes, state: playerView()} if player.track and (player.status === 'playing' or player.status === 'loading')
	const play = valid.song.melodicaPlay
	delete valid.song.melodicaPlay
	if play and play.sid === sessionMeta.sid and play.trackToken === valid.song.trackToken and Number.isFinite(Number(play.startedAt))
		const before = scrobble.play and scrobble.play.key === play.trackToken ? scrobble.play : null
		scrobble.play = {key: play.trackToken, startedAt: before ? Math.min(Number(before.startedAt), Number(play.startedAt)) : Number(play.startedAt), sent: !!play.sent or !!(before and before.sent), played: Math.max(Number(play.played) or 0, Number(before and before.played) or 0), lastPosition: Number(valid.position) or 0, lastStatus: valid.status}
	await engineCall('import-playback', [valid])
	{kept: no, state: playerView()}

def exportPlaybackCopy msg
	throw new PandoraError('Not signed in.', null, 0, 'auth') unless state.client.loggedIn and sessionMeta
	const sid = sessionMeta.sid
	const token = String(msg.trackToken or '')
	const current = do token and ((player.track and player.track.trackToken === token) or (lastPlay and lastPlay.track and lastPlay.track.trackToken === token))
	throw new PandoraError('Only the current or resumable song can be copied.', null, 0, 'client') unless current()
	const copy = await playbackCopy.chunk(token, msg.offset === undefined ? 0 : msg.offset, msg.limit)
	throw new PandoraError('The playback session changed.', null, 0, 'auth') unless sessionMeta and sessionMeta.sid === sid and current()
	{copy: copy ? Object.assign({sid}, copy) : null}

# A live room owns the shared transport. In particular, the DJ's Pandora engine is
# the room microphone, so generic private-player actions cannot interrupt it.
def roomPlayerCommand msg, sender
	throw new PandoraError('not allowed', null, 0, 'room') unless roomCaller(sender)
	const action = String(msg.action or '')
	const roomId = room.id
	const playId = room.state and room.state.play and room.state.play.id
	let out = null
	switch action
		when 'pause' then out = await roomAudioCommand({roomId, action: 'pause'}, sender)
		when 'resume' then out = await roomAudioCommand({roomId, action: 'resume'}, sender)
		when 'toggle' then out = await roomAudioCommand({roomId, action: room.audio and room.audio.paused ? 'resume' : 'pause'}, sender)
		when 'next', 'tired', 'sleep' then out = await roomAudioCommand({roomId, action: 'skip'}, sender)
		when 'volume' then out = await roomAudioCommand({roomId, action: 'volume', value: msg.value}, sender)
		when 'love', 'ban'
			throw new PandoraError('There is no active room track to react to.', null, 0, 'room') unless playId
			out = await roomCommand({roomId, command: {action: 'react', play_id: playId, reaction: action === 'love' ? 'like' : 'dislike'}}, sender)
		when 'play'
			throw new PandoraError('Leave the room before choosing a private Pandora station.', null, 0, 'room') if msg.station or msg.stationToken
			out = await roomAudioCommand({roomId, action: 'resume'}, sender)
		when 'stop'
			throw new PandoraError('Leave the room to stop playback.', null, 0, 'room')
		when 'quality'
			throw new PandoraError('Leave the room before changing Pandora audio quality.', null, 0, 'room')
		else
			throw new PandoraError('This player action is unavailable while a room is active.', null, 0, 'room')
	{state: playerView(), room: out and out.room or roomView()}

# A command from a view (popup, player tab, options, the web page, a keyboard shortcut).
def playerCommand msg, sender
	const action = String(msg.action or '')
	throw new PandoraError("Unknown player action {action}.", null, 0, 'client') unless PLAYER_ACTIONS.has(action)
	if room.id
		await restoreRoomSession() unless roomEngineReady
		if roomBroadcastActive()
			if action === 'play' and (msg.station or msg.stationToken)
				throw new PandoraError('not allowed', null, 0, 'room') unless roomCaller(sender)
				throw new PandoraError('Not signed in.', null, 0, 'auth') unless state.client.loggedIn
				const st = stationByToken(msg.stationToken or msg.station.token) or msg.station or {token: msg.stationToken, name: ''}
				await engineCall('room-select-station', [st])
				return {state: playerView()}
			return await roomPlayerCommand(msg, sender)
		elif !roomIsDj()
			return await roomPlayerCommand(msg, sender)
	switch action
		when 'play'
			if msg.station or msg.stationToken
				throw new PandoraError('Not signed in.', null, 0, 'auth') unless state.client.loggedIn
				const st = stationByToken(msg.stationToken or msg.station.token) or msg.station or {token: msg.stationToken, name: ''}
				await engineCall('play', [{token: st.token, name: st.name or ''}])
			else
				await engineCall('resume')
		when 'resume' then await engineCall('resume')
		when 'pause' then await engineCall('pause')
		when 'toggle'
			# An idle offscreen document can disappear between displaying Playing
			# and this click. A recreated engine hydrates Paused; preserve the
			# click's intent instead of toggling that newly hydrated state to Play.
			const wasPlaying = player.status === 'playing' or player.status === 'loading'
			await engineCall(wasPlaying ? 'pause' : 'resume')
		when 'next' then await engineCall('next')
		when 'love'
			const t = player.track
			await engineCall('rate', [yes])
			gameThumb('up', t)
		when 'ban'
			const t = player.track
			await engineCall('rate', [no])
			gameThumb('down', t)
		when 'tired' then await engineCall('tired')
		when 'sleep' then await engineCall('tired')
		when 'stop' then await engineCall('stop')
		when 'volume'
			const v = Math.max(0, Math.min(100, Number(msg.value) or 0))
			await browser.storage.local.set({volume: v})
			state.settings.volume = v
			await engineCall('volume', [v])
		when 'quality'
			throw new PandoraError('Unknown quality.', null, 0, 'client') unless QUALITIES.includes(msg.value)
			await browser.storage.local.set({quality: msg.value})
			state.settings.quality = msg.value
			await engineCall('quality', [msg.value])
	{state: playerView()}

def stopPlayback why
	return unless player.track or player.status === 'loading'
	note("stopping playback: {why}")
	try
		await engineCall('stop')
	catch e
		null

def roomCaller sender
	!!(sender and sender.id === browser.runtime.id and (extensionPage(sender) or melodicaPageSender(sender)))

def roomOffscreen sender
	!!(sender and sender.id === browser.runtime.id and (sender.url === browser.runtime.getURL('offscreen.html') or (TAB_ENGINE and sender.url === PLAYER_URL)))

def joinRoom roomId, paused = no
	throw new PandoraError('Leave your DJ room before joining another room.', null, 0, 'room') if room.id and room.id !== roomId and roomBroadcastActive()
	throw new PandoraError('Rooms require a signed-in spacegho.st account.', null, 0, 'auth') unless account.signedIn
	const token = await accountBearer()
	throw new PandoraError('Sign in to spacegho.st before joining a room.', null, 0, 'auth') unless token
	const current = room
	room = {id: roomId, state: current.id === roomId ? current.state : null, audio: current.id === roomId ? current.audio : {state: 'idle'}, changed: current.id === roomId ? current.changed : 0}
	const changedBeforeJoin = room.changed
	playerChanged(player)
	const result = await engineCall('room-join', [{id: roomId, clientId: await roomClientIdentity(), paused: paused === yes, sequence: room.changed, base: await accountBase(), scrobbling: scrobble.on !== no, sfuConfigured: yes}])
	roomEngineReady = yes
	# RoomSession may publish a fresher audio snapshot while the join promise still
	# waits for its first state. Never replace that ordered update with the reply.
	if room.changed === changedBeforeJoin
		room.state = publicRoom(result and result.state)
		room.audio = publicRoomAudio(result and result.audio)
		persistRoom()
	rememberRoom(room.state).catch(do(e) null) if room.state
	if !roomIsDj() and (player.status === 'playing' or player.status === 'loading')
		await engineCall('pause')
	playerChanged(player)
	room

def leaveRoom
	const roomId = room.id
	return room unless roomId
	try
		await engineCall('room-leave', [{leave: yes}])
	finally
		room = {id: null, state: null, audio: {state: 'idle'}, changed: room.changed + 1}
		roomEngineReady = no
		persistRoom()
	playerChanged(player)
	await closeIdleOffscreen()
	room

def roomCommand msg, sender
	throw new PandoraError('not allowed', null, 0, 'room') unless roomCaller(sender)
	throw new PandoraError('Join that room before sending commands.', null, 0, 'room') unless msg.roomId and room.id === msg.roomId
	await restoreRoomSession() unless roomEngineReady
	const command = validRoomCommand(msg.command)
	throw new PandoraError('not allowed', null, 0, 'room') if ['play', 'heard', 'clock'].includes(command.action)
	const result = await engineCall('room-command', [room.id, command])
	if command.action === 'leave' or command.action === 'close'
		room = {id: null, state: null, audio: {state: 'idle'}, changed: room.changed + 1}
		roomEngineReady = no
		persistRoom()
	else
		room.state = publicRoom(result)
		persistRoom()
	playerChanged(player)
	{room: roomView(), state: room.state}

def roomAudioCommand msg, sender
	throw new PandoraError('not allowed', null, 0, 'room') unless roomCaller(sender) and room.id and room.id === msg.roomId
	await restoreRoomSession() unless roomEngineReady
	const action = String(msg.action or '')
	throw new PandoraError('Unknown room audio action.', null, 0, 'room') unless ['listen', 'pause', 'resume', 'skip', 'volume'].includes(action)
	const value = Number(msg.value)
	throw new PandoraError('Invalid room volume.', null, 0, 'room') if action === 'volume' and (!Number.isFinite(value) or value < 0 or value > 100)
	const result = await engineCall('room-audio', [room.id, action, value])
	room.state = publicRoom(result and result.state) if result and result.state
	room.audio = publicRoomAudio(result and result.audio)
	persistRoom()
	playerChanged(player)
	{room: roomView(), state: playerView()}

def bridge msg
	const search = String(msg.search or '')
	const method = search.startsWith('?') and !search.includes('#') ? new URLSearchParams(search).get('method') : null
	throw new PandoraError('method not allowed', null, 0, 'bridge') unless method and METHOD.test(method)
	# The page's own Pandora login goes straight to Pandora through here, so past the
	# partner login it needs the same access answer as the extension's login.
	# Only an answer that said no refuses; no answer yet is not a refusal.
	if method !== 'auth.partnerLogin' and method !== 'test.checkLicensing' and access.checkedAt and !access.allowed and access.message
		throw new PandoraError(access.message or ACCESS_DENIED, null, 0, 'access')
	let res
	try
		res = await fetch(state.settings.endpoint + search, {
			method: 'POST'
			headers: {'content-type': 'text/plain'}
			body: fromBase64(msg.body)
			credentials: 'omit'
			redirect: 'error'
		})
	catch e
		throw new PandoraError("Could not reach {state.settings.endpoint} ({e and e.message or e}).", null, 0, 'network')
	const body = new Uint8Array(await res.arrayBuffer())
	{fetchOk: res.ok, status: res.status, body: toBase64(body)}

def stationByToken token
	(state.saved.stations or []).find(do(s) s.token === token) or null

def handle msg, sender
	await ensure()
	const client = state.client
	# Stale account and access answers are asked again; player traffic (the views,
	# the bridge) is not held up by those round trips.
	const quick = msg.type === 'engine-last' or msg.type === 'player' or msg.type === 'player-get' or msg.type === 'player-subscribe' or msg.type === 'engine-state' or msg.type === 'engine-log' or msg.type === 'wake' or msg.type === 'playback-export' or msg.type === 'playback-import' or msg.type === 'playback-copy' or msg.type.startsWith('room-')
	if !accountChecking and account.checkedAt and Date.now() - account.checkedAt > ACCOUNT_MAX_AGE
		quick ? checkAccount().catch(do(e) null) : await checkAccount()
	if !accessChecking and access.checkedAt and Date.now() - access.checkedAt > ACCESS_MAX_AGE
		quick ? checkAccess().catch(do(e) null) : await checkAccess()
	switch msg.type
		when 'access'
			{access: accessView()}
		when 'access-check'
			{access: accessView(await checkAccess(yes))}
		when 'account'
			{account: accountView()}
		when 'account-check'
			{account: await checkAccount(yes)}
		when 'account-signin'
			{account: await accountSignin()}
		when 'account-begin'
			await accountBegin(!!msg.tab)
		when 'account-finish'
			{account: await accountFinish(String(msg.url or ''))}
		when 'account-code'
			{account: await accountCode(msg, sender)}
		when 'account-signout'
			{account: await accountSignout()}
		when 'spot-metadata'
			{spot: spotsOn() ? await client.spotMetadata(msg.placeholder or {}, QUALITIES.includes(msg.quality) ? msg.quality : state.settings.quality) : null}
		when 'register-spot'
			const st = (state.saved.stations or []).find(do(x) x.id === msg.stationId) or null
			await client.registerSpot(msg.stationId or (st and st.id), Array.isArray(msg.trackingTokens) ? msg.trackingTokens : [])
			note("registered ({(msg.trackingTokens or []).length} tracking tokens)")
			{}
		when 'update'
			{update: await checkUpdate()}
		when 'update-check'
			{update: await checkUpdate(yes)}
		when 'update-reload'
			throw new PandoraError('This browser cannot reload the extension from here.', null, 0, 'client') unless browser.runtime.reload
			note('reload requested from a page')
			setTimeout((do browser.runtime.reload()), 100)
			{}
		when 'ping'
			{version: browser.runtime.getManifest().version, core: state.core.version}
		when 'diagnostics'
			let permissions = null
			try
				permissions = await browser.permissions.getAll()
			catch e
				permissions = {error: String(e and e.message or e)}
			const manifest = browser.runtime.getManifest()
			{
				version: manifest.version_name or manifest.version
				core: state.core.version
				ua: navigator.userAgent
				endpoint: state.settings.endpoint
				userAgent: client.userAgent or '(the browser\'s)'
				loggedIn: client.loggedIn
				syncOffset: state.core.syncOffset
				sessionStorage: !!browser.storage.session
				background: manifest.background
				permissions: permissions
				account: accountView()
				accountBase: await accountBase()
				update: updateState()
				player: Object.assign({}, player, {track: publicTrack(player.track), history: player.history.length})
				engine: browser.offscreen ? 'offscreen document' : (TAB_ENGINE ? 'player tab' : 'background page')
				lines: logLines.slice()
			}
		when 'state'
			{
				loggedIn: client.loggedIn
				email: client.user and client.user.email or state.settings.email or ''
				stations: state.saved.stations or []
				player: playerView()
				settings: {endpoint: state.settings.endpoint, quality: state.settings.quality, remember: state.settings.remember, volume: state.settings.volume}
				version: browser.runtime.getManifest().version
				core: state.core.version
				account: accountView()
				access: accessView()
				update: updateState()
			}
		when 'login'
			const email = String(msg.email or '').trim()
			const password = String(msg.password or '')
			note("login requested (email {email.length} chars, password {password.length} chars, remember={!!msg.remember})")
			const allowed = await accessAsk(email)
			await setAccess(email, allowed)
			throw new PandoraError(allowed.message, null, 0, 'access') unless allowed.allowed
			await client.login(email, password)
			note("login ok: user id {client.user.id.length} chars, token {client.user.authToken.length} chars, subscriber={client.user.subscriber}")
			const keep = !!msg.remember and vaultAvailable()
			await browser.storage.local.set({email, remember: keep})
			Object.assign(state.settings, {email, remember: keep})
			await wipe() unless keep
			await persist()
			sessionChanged()
			const stations = await client.stations()
			await remember('stations', stations)
			playerChanged(player)
			# Not awaited: the username never holds up playback.
			melodicaLogin(email, yes).catch(do(e) note("login-ok failed: {e and e.message or e}"))
			{email, stations}
		when 'logout'
			await forgetPandora('signed out')
			{}
		when 'remember'
			const on = !!msg.on and vaultAvailable()
			await browser.storage.local.set({remember: on})
			state.settings.remember = on
			if on
				await sealRemembered()
			else
				await wipe()
				note('remember: forgotten')
			sessionChanged()
			{remember: on}
		when 'stations'
			let stations = state.saved.stations or []
			unless stations.length
				stations = await client.stations()
				await remember('stations', stations)
				await persist()
			playerChanged(player)
			{stations}
		when 'open-login'
			{opened: await openLogin()}
		when 'username-me'
			await refreshMe(no)
			{user: userView()}
		when 'username-set'
			{user: await setUsername(String(msg.username or ''))}
		when 'scrobble-token'
			# For the shared Scrobbles UI in the extension's own pages (never a web page).
			throw new PandoraError('not allowed', null, 0, 'client') unless extensionPage(sender)
			const bs = await melodicaBearers()
			{token: bs.length ? bs[0].token : null}
		when 'scrobble-recent'
			{recent: await scrobbleRecent(!!msg.force)}
		when 'scrobble-notice-seen'
			scrobble.noticeSeen = yes
			await browser.storage.local.set({scrobbleNoticeSeen: yes})
			flushListens().catch(do(e) null)
			playerChanged(player)
			{scrobbling: scrobbleView()}
		when 'scrobble-settings'
			await scrobbleSettings(yes)
			{scrobbling: scrobbleView(), known: scrobble.checkedAt > 0}
		when 'scrobble-set'
			await scrobbleSettings(yes, !!msg.on)
			engineCall('room-scrobbling', [scrobble.on !== no]).catch(do(e) null) if room.id
			{scrobbling: scrobbleView(), known: scrobble.checkedAt > 0}
		when 'username-later'
			await setMelodica({later: yes})
			{user: userView()}
		when 'playlist'
			const station = stationByToken(msg.stationToken) or {token: msg.stationToken, name: ''}
			const quality = QUALITIES.includes(msg.quality) ? msg.quality : state.settings.quality
			const songs = playable(await client.playlist(station, quality))
			await persist()
			{songs, quality}
		when 'rate'
			await client.rate(msg.trackToken, !!msg.positive)
			{}
		when 'tired'
			await client.tired(msg.trackToken)
			{}
		when 'explain'
			{traits: await client.explain(msg.trackToken)}
		when 'search'
			{results: await client.search(String(msg.query or ''))}
		when 'terrain-station'
			throw new Error('Only extension pages may create stations here.') unless extensionPage(sender)
			{station: await createTerrainStation(msg.station)}
		when 'create-station'
			const station = await client.createStation(msg.musicToken)
			const stations = await client.stations()
			await remember('stations', stations)
			{station, stations}
		when 'delete-station'
			await client.deleteStation(stationByToken(msg.stationToken) or {token: msg.stationToken})
			const stations = await client.stations()
			await remember('stations', stations)
			{stations}
		when 'open-player'
			await openPlayer()
		when 'player-subscribe'
			await subscribeTab(sender and sender.tab and sender.tab.id, msg.on !== no)
			{state: playerView()}
		when 'wake'
			# A spacegho.st/melodica/ page loaded: ensure() above has restored the session.
			{loggedIn: !!client.loggedIn}
		when 'player-get'
			{state: playerView(), settings: state.settings, account: accountView(), update: updateState()}
		when 'player'
			await playerCommand(msg, sender)
		when 'playback-export'
			throw new PandoraError('not allowed', null, 0, 'bridge') unless melodicaPageSender(sender) or extensionPage(sender)
			{playback: await exportPlayback(), state: playerView()}
		when 'playback-import'
			throw new PandoraError('not allowed', null, 0, 'bridge') unless melodicaPageSender(sender) or extensionPage(sender)
			await importPlayback(msg.playback)
		when 'playback-copy'
			throw new PandoraError('not allowed', null, 0, 'bridge') unless melodicaPageSender(sender) or extensionPage(sender)
			await exportPlaybackCopy(msg)
		when 'open-rooms'
			throw new PandoraError('not allowed', null, 0, 'room') unless extensionPage(sender)
			const roomId = String(msg.roomId or '')
			throw new PandoraError('Choose a valid room.', null, 0, 'room') if roomId and !/^[A-Za-z0-9_-]{16,64}$/.test(roomId)
			const target = browser.runtime.getURL('rooms.html') + (roomId ? '?room=' + encodeURIComponent(roomId) : '')
			const created = await browser.tabs.create({url: target})
			{tabId: created.id}
		when 'room-recent'
			throw new PandoraError('not allowed', null, 0, 'room') unless roomCaller(sender)
			await checkAccount()
			{recentRoomIds: await recentRoomsView()}
		when 'room-search'
			throw new PandoraError('not allowed', null, 0, 'room') unless roomCaller(sender)
			await checkAccount()
			throw new PandoraError('Sign in to spacegho.st before searching rooms.', null, 0, 'auth') unless account.signedIn
			const query = String(msg.query or '').trim().slice(0, 80)
			throw new PandoraError('Search query is too long.', null, 0, 'room') if String(msg.query or '').length > 80
			const cursor = String(msg.cursor or '')
			throw new PandoraError('Invalid room cursor.', null, 0, 'room') if cursor.length > 512 or /[\u0000-\u001f\u007f]/.test(cursor)
			const recentIds = Array.isArray(msg.recentIds) ? msg.recentIds.filter(do(id) /^[A-Za-z0-9_-]{16,64}$/.test(String(id or ''))).slice(0, 12) : await recentRoomsView()
			const params = new URLSearchParams()
			params.set('q', query) if query
			params.set('cursor', cursor) if cursor
			params.set('recent', recentIds.join(',')) if recentIds.length
			const reply = await roomApi({path: 'rooms?' + params.toString()}, sender)
			const body = reply.result or {}
			const rooms = (Array.isArray(body.rooms) ? body.rooms : []).map(publicRoomSummary).filter(Boolean)
			const recent = (Array.isArray(body.recent) ? body.recent : []).map(publicRoomSummary).filter(Boolean)
			{rooms, recent, recentRoomIds: recent.map(do(r) r.id), next_cursor: typeof body.next_cursor === 'string' ? body.next_cursor.slice(0, 512) : null}
		when 'room-get'
			throw new PandoraError('not allowed', null, 0, 'room') unless roomCaller(sender)
			await restoreRoomSession() if room.id and !roomEngineReady
			{room: roomView()}
		when 'room-join'
			throw new PandoraError('not allowed', null, 0, 'room') unless roomCaller(sender)
			const roomId = String(msg.roomId or msg.id or '')
			throw new PandoraError('Choose a valid room.', null, 0, 'room') unless /^[A-Za-z0-9_-]{16,64}$/.test(roomId)
			throw new PandoraError('Invalid room playback state.', null, 0, 'room') if msg.paused !== undefined and typeof msg.paused !== 'boolean'
			await joinRoom(roomId, msg.paused === yes)
			{room: roomView()}
		when 'room-leave'
			throw new PandoraError('not allowed', null, 0, 'room') unless roomCaller(sender) and room.id and room.id === msg.roomId
			await restoreRoomSession() unless roomEngineReady
			await leaveRoom()
			{room: roomView()}
		when 'room-command'
			await roomCommand(msg, sender)
		when 'room-audio-command'
			await roomAudioCommand(msg, sender)
		when 'room-config'
			throw new PandoraError('not allowed', null, 0, 'room') unless roomOffscreen(sender) and room.id === msg.roomId
			throw new PandoraError('Sign in to spacegho.st before joining a room.', null, 0, 'auth') unless await accountBearer()
			{base: await accountBase(), scrobbling: scrobble.on !== no, sfuConfigured: yes}
		when 'room-token'
			throw new PandoraError('not allowed', null, 0, 'room') unless roomOffscreen(sender) and room.id
			const token = await accountBearer()
			throw new PandoraError('Sign in to spacegho.st before joining a room.', null, 0, 'auth') unless token
			{token}
		when 'room-api'
			await roomApi(msg, sender)
		when 'room-state'
			throw new PandoraError('not allowed', null, 0, 'room') unless roomOffscreen(sender) and room.id and msg.roomId === room.id
			if Number.isSafeInteger(msg.changed) and msg.changed > room.changed
				room.changed = msg.changed
				room.state = publicRoom(msg.room)
				room.audio = publicRoomAudio(msg.audio)
				roomEngineReady = yes
				persistRoom()
				playerChanged(player)
			{}
		when 'room-clock'
			throw new PandoraError('not allowed', null, 0, 'room') unless roomOffscreen(sender) and room.id and msg.roomId === room.id
			applyRoomClock(msg)
		when 'listen-open'
			const u = sender and sender.url and new URL(sender.url)
			throw new PandoraError('not allowed', null, 0, 'bridge') unless sender and sender.id === browser.runtime.id and sender.frameId === 0 and sender.tab and u and u.origin === BRIDGE_ORIGIN and u.pathname.startsWith('/listen/')
			{opened: await listenTab(msg.uri, sender.tab.id)}
		when 'play-seed'
			throw new PandoraError('not allowed', null, 0, 'bridge') unless melodicaPageSender(sender) or extensionPage(sender)
			await playSeed(String(msg.kind or ''), msg.name, sender)
		when 'engine-hello'
			# The offscreen document (re)started: give it what the last one knew.
			note(TAB_ENGINE ? 'player tab engine up; hydrating' : 'offscreen document up; hydrating')
			roomEngineReady = no if room.id
			const waiting = engineWaiters
			engineWaiters = []
			setTimeout((do waiting.forEach(do(f) f())), 0)
			{saved: Object.assign({}, player, {last: lastPlay})}
		when 'engine-room-control'
			throw new PandoraError('not allowed', null, 0, 'room') unless roomOffscreen(sender) and ['ended', 'play', 'resume', 'pause', 'next'].includes(String(msg.action or ''))
			{handled: await engineRoomControl(String(msg.action))}
		when 'test-expire-last'
			# Smoke tests only (extension pages): the saved song's link stops working.
			throw new Error('extension pages only') unless extensionPage(sender)
			const dead = 'http://127.0.0.1:9/expired.m4a'
			await engineCall('expire-link', [dead]) if player.track
			lastPlay.track = Object.assign({}, lastPlay.track, {audioUrl: dead, fetchedAt: Date.now() - 24 * 60 * 60 * 1000}) if lastPlay and lastPlay.track
			player = Object.assign({}, player, {track: Object.assign({}, player.track, {audioUrl: dead, fetchedAt: Date.now() - 24 * 60 * 60 * 1000})}) if player.track
			await session.set({player})
			if msg.dropCopy
				await dropAudioCopies()
			{}
		when 'engine-last'
			saveLastPlay(msg.record, !!msg.urgent) if msg.record and typeof msg.record === 'object'
			{}
		when 'engine-log'
			note("engine: {String(msg.line or '').slice(0, 300)}")
			{}
		when 'engine-state'
			playerChanged(msg.state) if msg.state and typeof msg.state === 'object'
			maybeReload('playback stopped') if !player.track
			{}
		when 'bridge'
			await bridge(msg)
		when 'bridge-session-get'
			bridgeSender(sender)
			await sessionTabs(sender.tab.id, yes)
			silentAccountFor(msg.account)
			const view = await sessionView()
			if (await browser.storage.local.get({accountSignoutPending: no})).accountSignoutPending
				await browser.storage.local.remove('accountSignoutPending')
				view.accountSignout = yes
			view
		when 'bridge-session-offer'
			bridgeSender(sender)
			await sessionTabs(sender.tab.id, yes)
			silentAccountFor(msg.account)
			{outcome: await sessionOffer(msg)}
		when 'bridge-account-signout'
			bridgeSender(sender)
			await accountSignout(yes) if account.signedIn
			{}
		when 'bridge-session-logout'
			bridgeSender(sender)
			await sessionLogout(String(msg.sid or ''))
			{}
		else
			throw new PandoraError("Unknown message type {msg.type}.", null, 0, 'client')

browser.runtime.onMessage.addListener do(msg, sender, sendResponse)
	return no unless msg and typeof msg === 'object' and typeof msg.type === 'string'
	const done = do(result) sendResponse(Object.assign({ok: yes}, result or {}))
	const failed = do(e)
		console.warn("melodica {msg.type}: {(e and e.message) or e}")
		note("{msg.type} failed: {(e and e.message) or e}") unless e and e.kind === 'pandora'
		const code = (e and e.code != null) ? e.code : null
		sendResponse({ok: no, error: String((e and e.message) or e), code: code, status: e and e.status or 0, kind: (e and e.kind) or 'error'})
	handle(msg, sender).then(done, failed)
	yes

# Settings edited on the options page: a new endpoint invalidates the session
# (tokens belong to one server); quality applies to the next playlist.
# A change that lands while boot() is still reading the old settings must not be
# dropped (seen in Brave, whose worker starts later than the options page saves):
# wait for the boot and apply it on top. A worker that has not begun booting
# reads the stored settings when it does.
browser.storage.onChanged.addListener do(changes, area)
	return unless area === 'local' and booting
	try
		await ensure()
	catch e
		return
	if changes.endpoint
		const endpoint = normalizeEndpoint(changes.endpoint.newValue)
		if endpoint !== state.client.endpoint
			state.settings.endpoint = endpoint
			state.client.endpoint = endpoint
			state.client.userAgent = await clientUserAgent(endpoint)
			state.client.reset()
			await persist()
			await remember('stations', [])
			await stopPlayback('endpoint changed')
	# The account tokens or the account server override changed (a sign-in, a
	# sign-out, a test): ask the policy again.
	await checkAccount(yes) if changes.account or changes.accountBase
	state.settings.quality = changes.quality.newValue if changes.quality and QUALITIES.includes(changes.quality.newValue)
	# "Remember me" and the sealed login are changed only through the background
	# (login, logout, the 'remember' message), which keeps state.settings itself.
	state.settings.email = changes.email.newValue or '' if changes.email

browser.runtime.onInstalled.addListener do(details)
	console.info("melodica-extension {browser.runtime.getManifest().version} {details.reason}")

# Keyboard shortcuts (manifest `commands`): play/pause and next, from anywhere.
if browser.commands and browser.commands.onCommand
	browser.commands.onCommand.addListener do(command)
		try
			await ensure()
			if room.id
				await engineRoomControl(command === 'next-song' ? 'next' : 'toggle')
			else
				await playerCommand({action: command === 'next-song' ? 'next' : 'toggle'})
		catch e
			note("shortcut {command} failed: {e and e.message or e}")

# Firefox: the engine lives here; bring it up with the saved state on boot so a
# paused track survives a restart and the badge is right.
if typeof document !== 'undefined' and !browser.offscreen and !TAB_ENGINE
	ensure().then(do localEngine()).catch(do(e) null)
